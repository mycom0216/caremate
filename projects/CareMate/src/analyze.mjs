// ─────────────────────────────────────────────────────────────────────────────
// analyze.mjs — 문의 분석: ① 유형 분류(나이브 베이즈) ② 감정·우선순위(규칙) ③ 상담원 연결 요청 감지
//
// [왜 규칙·통계 방식인가]  LLM 에게 분류를 맡기면 느리고 매번 결과가 흔들립니다. 여기서는 작은 학습 데이터로도 되는
//   고전 기법과 사전 규칙을 써서 빠르고(밀리초), 결과의 "근거"를 사람이 확인할 수 있게 했습니다.
//
// [입력]   고객 문의 문자열(개인정보는 이미 마스킹된 상태, chat.mjs).
// [출력]   · 분류: { label:'배송', prob:0.82, ranked:[상위 3개 {label,prob}] }
//          · 톤:   { sentiment:-0.7, sentimentLabel, priority:'high'|'medium'|'low', score, reasons:[근거 단어], incident:true|false }
// ─────────────────────────────────────────────────────────────────────────────
import { tokens } from './text.mjs';

// 1) 문의 유형 분류: 문자 바이그램 다항 나이브 베이즈(라플라스 평활화). 라벨 데이터로 직접 학습합니다.
// 나이브 베이즈(Naive Bayes) 분류기. "이 문장이 각 유형에서 나올 확률"을 비교해 가장 그럴듯한 유형을 고릅니다.
//   · 다항(multinomial): 토큰이 나온 횟수를 셉니다. · 나이브: 토큰들이 서로 독립이라고 단순화합니다(그래서 계산이 쉽고 빠름).
//   · 학습 상태: labels(유형별 {docs: 문서 수, counts: 토큰별 횟수, tokens: 토큰 총수}), vocab(전체 어휘 집합), total(전체 학습 문장 수)
export class CategoryClassifier {
  constructor() { this.labels = new Map(); this.vocab = new Set(); this.total = 0; }

  // 학습. pairs: [[라벨, 문장], ...] (data/inquiries-labeled.json 의 train). 라벨별로 토큰 횟수를 누적합니다. this 를 돌려줘 이어 쓸 수 있습니다.
  train(pairs) {
    for (const [label, text] of pairs) {
      const m = this.labels.get(label) ?? { docs: 0, counts: new Map(), tokens: 0 };
      m.docs++; this.total++;
      for (const t of tokens(text)) {
        m.counts.set(t, (m.counts.get(t) ?? 0) + 1);
        m.tokens++; this.vocab.add(t);
      }
      this.labels.set(label, m);
    }
    return this;
  }

  // 예측. 모든 유형에 대해 로그 점수 = log(사전확률) + Σ log(토큰이 그 유형에서 나올 확률)을 계산합니다.
  //   · 로그를 쓰는 이유: 작은 확률을 수십 번 곱하면 0 에 가까워 계산이 깨지므로 로그로 바꿔 덧셈으로 처리합니다.
  //   · 확률 = (그 유형에서 토큰 횟수 + 0.5) / (그 유형의 토큰 총수 + 0.5 × 어휘 크기). 0.5 를 더하는 가산 평활화(smoothing)는
  //     학습에 한 번도 없던 토큰 때문에 확률이 0 이 되어 전체가 무너지는 것을 막습니다.
  //   · 마지막에 점수를 확률로 바꿀 때(softmax) 가장 큰 값을 빼고 exp 를 취해 오버플로(너무 큰 수)를 방지한 뒤 합이 1 이 되게 나눕니다.
  //   반환: 확률이 가장 높은 유형, 그 확률, 상위 3개 목록.
  predict(text) {
    const toks = tokens(text);
    const V = this.vocab.size;
    const scores = [];
    for (const [label, m] of this.labels) {
      let s = Math.log(m.docs / this.total);
      for (const t of toks) s += Math.log(((m.counts.get(t) ?? 0) + 0.5) / (m.tokens + 0.5 * V));
      scores.push([label, s]);
    }
    const max = Math.max(...scores.map((x) => x[1]));
    const exp = scores.map(([l, s]) => [l, Math.exp(s - max)]);
    const z = exp.reduce((a, [, e]) => a + e, 0);
    const ranked = exp.map(([l, e]) => ({ label: l, prob: e / z })).sort((a, b) => b.prob - a.prob);
    return { label: ranked[0].label, prob: ranked[0].prob, ranked: ranked.slice(0, 3) };
  }

  // 평가: 학습에 쓰지 않은 문장 모음으로 정확도를 계산하고, 틀린 경우를 "정답→예측" 개수로 모은 혼동 목록(errors)도 돌려줍니다.
  //   (tools/eval.mjs 와 테스트가 사용)
  evaluate(pairs) {
    let ok = 0;
    const confusion = {};
    for (const [label, text] of pairs) {
      const p = this.predict(text).label;
      if (p === label) ok++; else (confusion[`${label}→${p}`] = (confusion[`${label}→${p}`] ?? 0) + 1);
    }
    return { accuracy: ok / pairs.length, correct: ok, total: pairs.length, errors: confusion };
  }
}

// ── 2) 감정·긴급도 사전 ──
// 2) 감정·긴급도: 사전 기반 규칙. 근거 단어를 함께 돌려줘 상담원이 이유를 볼 수 있게 합니다.
// 단어 사전(부분 문자열 포함 검사). '화나' 는 '화나요', '화났어요' 에도 걸리도록 어간만 넣었습니다.
//   NEGATIVE 부정 감정/불만, URGENT 시간 압박, LEGAL 법적·신고 위협(가장 무거움), INCIDENT 사고성 사건(중복 결제·분실·파손·해킹 등).
const NEGATIVE = ['화나', '짜증', '최악', '어이없', '실망', '불친절', '엉망', '황당', '답답', '불만', '도대체', '몇 번째', '몇번째', '왜 아직', '아직도', '항의', '사기', '다시는'];
const URGENT = ['급해', '급합니다', '당장', '빨리', '오늘까지', '내일까지', '지금 바로', '긴급'];
const LEGAL = ['신고', '소비자원', '고소', '법적', '환불 안 해주면', '공정위', '변호사'];
const INCIDENT = ['중복 결제', '이중 결제', '결제 오류', '분실', '파손', '오배송', '도난', '해킹', '개인정보 유출', '못 받았'];

// 감정·우선순위 계산(규칙 기반). 점수식:
//   · sentiment(-1~0) = -(부정어 수×0.35 + 법적 표현 수×0.4 + 연속 느낌표·물음표 수×0.15), 최대 -1 로 제한
//   · score = 부정어 + 긴급어×1.5 + 법적×3 + 사고성×2 + 느낌표·물음표×0.5
//   · priority: score ≥ 3 높음, ≥ 1 보통, 그 외 낮음   (가중치와 임계값은 코드에 고정된 경험적 값)
//   · reasons: 걸린 단어 전체(상담원이 이유를 볼 수 있게 화면에 그대로 표시)
//   · incident: 사고성 단어나 법적 표현이 있으면 true → chat.mjs 가 상담원 티켓을 별도로 만듭니다.
export function analyzeTone(text) {
  const t = String(text).toLowerCase();
  // hit(list): 사전 중 문장에 들어 있는 단어만 골라 줍니다.
  const hit = (list) => list.filter((w) => t.includes(w));
  const neg = hit(NEGATIVE), urg = hit(URGENT), legal = hit(LEGAL), inc = hit(INCIDENT);
  // exclaim: "!!", "?!", "??" 처럼 느낌표·물음표가 2개 이상 이어진 덩어리 수(강한 감정 표현의 신호).
  const exclaim = (t.match(/[!?]{2,}/g) ?? []).length;
  const sentiment = -Math.min(1, neg.length * 0.35 + legal.length * 0.4 + exclaim * 0.15);
  let score = neg.length + urg.length * 1.5 + legal.length * 3 + inc.length * 2 + exclaim * 0.5;
  const priority = score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low';
  return {
    sentiment: Number(sentiment.toFixed(2)),
    // 라벨: -0.6 이하 '매우 부정', 0 미만 '부정', 그 외 '중립'. (긍정 감정은 판정하지 않음)
    sentimentLabel: sentiment <= -0.6 ? '매우 부정' : sentiment < 0 ? '부정' : '중립',
    priority,
    score: Number(score.toFixed(1)),
    reasons: [...neg, ...urg, ...legal, ...inc],
    incident: inc.length > 0 || legal.length > 0,
  };
}

// 상담원 연결을 "요청"하는 표현인지 판별합니다(true/false).
export function wantsHuman(text) {
  // '상담원이 답해 주나요?' 같은 정보 질문은 제외하고, 연결을 요청하는 표현만 잡습니다.
  // 정규식 구조: (상담원|상담사|담당자|직원|사람) + 임의 글자(\S*, 조사 등) + 공백 + 선택적 (와|과|이랑|하고) + 선택적 '직접' + 요청 동사(통화|연결|바꿔|불러|얘기하고|말하고|만나).
  //    즉 "상담원과 통화하고 싶어요", "사람 연결해 주세요"는 true, 요청 동사가 없는 "상담원이 답해 주나요?"는 false 입니다.
  return /(상담원|상담사|담당자|직원|사람)\S*\s*(와|과|이랑|하고)?\s*(직접\s*)?(통화|연결|바꿔|불러|얘기하고|말하고|만나)/u.test(text);
}
