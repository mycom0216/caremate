import { tokens } from './text.mjs';

// 1) 문의 유형 분류: 문자 바이그램 다항 나이브 베이즈(라플라스 평활화). 라벨 데이터로 직접 학습합니다.
export class CategoryClassifier {
  constructor() { this.labels = new Map(); this.vocab = new Set(); this.total = 0; }

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

// 2) 감정·긴급도: 사전 기반 규칙. 근거 단어를 함께 돌려줘 상담원이 이유를 볼 수 있게 합니다.
const NEGATIVE = ['화나', '짜증', '최악', '어이없', '실망', '불친절', '엉망', '황당', '답답', '불만', '도대체', '몇 번째', '몇번째', '왜 아직', '아직도', '항의', '사기', '다시는'];
const URGENT = ['급해', '급합니다', '당장', '빨리', '오늘까지', '내일까지', '지금 바로', '긴급'];
const LEGAL = ['신고', '소비자원', '고소', '법적', '환불 안 해주면', '공정위', '변호사'];
const INCIDENT = ['중복 결제', '이중 결제', '결제 오류', '분실', '파손', '오배송', '도난', '해킹', '개인정보 유출', '못 받았'];

export function analyzeTone(text) {
  const t = String(text).toLowerCase();
  const hit = (list) => list.filter((w) => t.includes(w));
  const neg = hit(NEGATIVE), urg = hit(URGENT), legal = hit(LEGAL), inc = hit(INCIDENT);
  const exclaim = (t.match(/[!?]{2,}/g) ?? []).length;
  const sentiment = -Math.min(1, neg.length * 0.35 + legal.length * 0.4 + exclaim * 0.15);
  let score = neg.length + urg.length * 1.5 + legal.length * 3 + inc.length * 2 + exclaim * 0.5;
  const priority = score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low';
  return {
    sentiment: Number(sentiment.toFixed(2)),
    sentimentLabel: sentiment <= -0.6 ? '매우 부정' : sentiment < 0 ? '부정' : '중립',
    priority,
    score: Number(score.toFixed(1)),
    reasons: [...neg, ...urg, ...legal, ...inc],
    incident: inc.length > 0 || legal.length > 0,
  };
}

export function wantsHuman(text) {
  // '상담원이 답해 주나요?' 같은 정보 질문은 제외하고, 연결을 요청하는 표현만 잡습니다.
  return /(상담원|상담사|담당자|직원|사람)\S*\s*(와|과|이랑|하고)?\s*(직접\s*)?(통화|연결|바꿔|불러|얘기하고|말하고|만나)/u.test(text);
}
