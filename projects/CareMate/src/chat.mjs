// ─────────────────────────────────────────────────────────────────────────────
// chat.mjs — ChatService: 고객 질문 한 건을 처리하는 전체 흐름 (이 프로젝트의 "두뇌")
//
// [한 질문이 지나가는 길 — ask()]
//   0) 입력 검사: 빈 질문·500자 초과는 거절(400)
//   1) 개인정보 마스킹(text.mjs) → 이후 모든 단계는 "가려진 문장"만 사용 (DB 저장, LLM 전달 포함)
//   2) 분석: 감정·우선순위(규칙) + 문의 유형(나이브 베이즈)
//   3) 분기(위에서부터 먼저 맞는 것 하나만):
//        a. 상담원 연결 요청   → 고정 안내 + 티켓
//        b. 인사·감사·잡담      → 고정 응답 (상담원 호출 안 함)
//        c. 주문번호 MM-####    → DB 조회 결과로 답(검색·LLM 사용 안 함)
//        d. 그 외              → RAG: 검색 → 신뢰도 임계값 → (LLM 생성 → 환각 검사 | 추출형) → 답 또는 상담원 연결
//   4) 긴급·사고성 문의는 답과 별개로 상담원에게도 알림(티켓 생성)
//   5) 문의 기록(inquiries)과 필요 시 티켓(tickets)을 DB 에 저장하고 결과를 화면에 돌려줌
//
// [용어]
//   · 에스컬레이션(escalation): 챗봇이 해결하지 못했거나 급한 문의를 사람 상담원에게 넘기는 것. 여기서는 "티켓 생성"으로 구현.
//   · 티켓: 상담원이 처리해야 할 문의 한 건(상태 open → resolved).
//   · generator: 답변이 어떻게 만들어졌는지 표시하는 꼬리표(llm, extractive, no-evidence, order-lookup, rule, smalltalk ...).
//
// [주의(데모의 한계)]  주문 조회는 주문번호만 맞으면 누구나 볼 수 있습니다(본인 확인·로그인 없음). 실제 서비스라면 반드시 인증이 필요합니다.
// ─────────────────────────────────────────────────────────────────────────────
import { analyzeTone, wantsHuman } from './analyze.mjs';
import { extractiveAnswer, guardAnswer } from './llm.mjs';
import { maskPII, tokens } from './text.mjs';

// 주문번호 형식: "MM-" + 숫자 4자리 (iu: 대소문자 무시·유니코드). 질문 어디에 있어도 찾으며, 결과는 대문자로 바꿔 DB 에서 조회합니다.
const ORDER_RE = /MM-\d{4}/iu;
// "강한 근거" 기준(0.6). LLM 답변이 환각 검사에서 거절됐을 때, 검색 신뢰도가 이 이상이면 원문 발췌로 대신 답해도 안전하다고 보고
//   미만이면 아예 답을 포기하고 상담원에게 넘깁니다(compose 참고).
const STRONG = 0.6; // 이 이상이면 LLM 답변이 거절돼도 검색 원문을 그대로 보여 줘도 안전하다고 봅니다.
// 잡담 사전: [인식 정규식, 고정 응답]. 인사·감사·챗봇 소개 질문은 문서 검색이 필요 없고 상담원을 부를 이유도 없어서 즉시 답합니다.
const SMALLTALK = [
  [/^(안녕|하이|헬로|반가워|hello|hi)/iu, '안녕하세요! 모아마켓 상담 챗봇이에요. 배송, 교환·반품, 결제, 쿠폰·포인트 등 궁금한 점을 물어보세요.'],
  [/(고마워|감사합니다|감사해요|땡큐|수고)/u, '도움이 되었다니 기쁩니다. 다른 궁금한 점이 있으면 언제든 물어보세요.'],
  [/(이름이?\s*뭐|누구(야|세요|니)|몇\s*살|뭐하는|넌 뭐|너는 뭐)/u, '저는 모아마켓 고객 문의를 도와드리는 AI 상담 챗봇이에요. 배송, 반품, 결제, 회원 관련 질문에 안내 자료를 근거로 답해 드려요.'],
];
// 후속 질문 표지: "그럼", "근데" 등으로 시작하면 이전 질문의 맥락을 이어받는 질문으로 봅니다(retrievalQuery).
const FOLLOW_UP =/^(그럼|그러면|그건|그거|그럼요|그리고|아니|근데)/u;

// 주문 한 건(DB 행)을 고객에게 보여 줄 문장으로 바꿉니다. 모든 내용은 DB 값으로만 채우고 AI 가 지어내지 않습니다.
//   o 의 모양: { order_no, item, amount(원), status, carrier, tracking_no, eta }. 상태별로 가능한 조치(취소·배송지 변경 등)가 다르므로 문구를 나눕니다.
export function describeOrder(o) {
  // 금액에 천 단위 쉼표를 붙입니다(59000 → 59,000).
  const money = o.amount.toLocaleString('ko-KR');
  const base = `주문번호 ${o.order_no}(${o.item}, ${money}원)은 현재 '${o.status}' 상태입니다.`;
  // 상태가 결제완료·상품준비중·출고완료/배송중·배송완료인지에 따라 안내가 달라집니다. 그 외 상태는 기본 문장만 돌려줍니다.
  switch (o.status) {
    case '결제완료': return `${base} 아직 출고 전이라 마이페이지에서 취소와 배송지 변경이 가능합니다. 도착 예정일은 ${o.eta}입니다.`;
    case '상품준비중': return `${base} 포장 중이라 취소는 고객센터 확인이 필요하고, 배송지 변경은 출고 전까지 가능합니다. 도착 예정일은 ${o.eta}입니다.`;
    case '출고완료':
    case '배송중': return `${base} ${o.carrier} 운송장 번호는 ${o.tracking_no}이며 도착 예정일은 ${o.eta}입니다.`;
    case '배송완료': return `${base} ${o.carrier} 운송장 ${o.tracking_no}로 배송이 완료되었습니다. 받지 못하셨다면 고객센터로 접수해 주세요.`;
    default: return base;
  }
}

// 질문 처리 서비스. 필요한 부품(검색기, 저장소, 분류기, LLM)과 임계값을 주입받아 보관합니다(src/app.mjs 에서 조립).
//   threshold: 검색 신뢰도가 이 값 미만이면 "근거 없음"으로 처리하는 기준(기본 0.2).
export class ChatService {
  constructor({ retriever, store, classifier, llm, threshold = 0.2 }) {
    Object.assign(this, { retriever, store, classifier, llm, threshold });
  }

  // 검색용 질의 만들기: 직전 대화가 있고 지금 질문이 짧거나(12자 미만) 후속 표지로 시작하면 직전 질문을 앞에 붙여 검색합니다.
  //   예: "무통장입금은 며칠 안에?" 뒤에 "그럼 안 하면요?" → "무통장입금은 며칠 안에? 그럼 안 하면요?" 로 검색해야 맞는 문서를 찾습니다.
  //   history 는 [{question, answer}, ...] (오래된 것 → 최근 순)입니다.
  retrievalQuery(question, history) {
    const last = history.at(-1);
    if (last && (question.length < 12 || FOLLOW_UP.test(question))) return `${last.question} ${question}`;
    return question;
  }

  // 근거 문서로 답변 생성 (LLM → 환각 검사 → 실패 시 추출형)
  // 근거 문서로 답변 만들기. 반환: { answer: 문자열 또는 null(답할 수 없음), generator: 방식 이름, cited: 출처로 보여 줄 검색 row 배열 }
  //   흐름: LLM 가능 → 생성 → 환각 검사 통과면 채택 / '근거 부족'이면 포기(null) / 검사 실패면 (신뢰도 충분 시) 추출형으로 대체, 아니면 포기
  //         LLM 없음·오류(시간 초과 등)면 추출형 답변. answer 가 null 이면 호출한 쪽이 상담원에게 넘깁니다.
  async compose(question, hits, history, confidence = 1) {
    if (this.llm?.available) {
      try {
        const raw = await this.llm.generate(question, hits, history);
        const g = guardAnswer(raw, question, hits);
        // 검사 통과(g.ok)한 경우: 답변 끝에 모델이 붙인 [n] 인용 표시는 화면에 보일 필요가 없으므로 제거하고, 출처는 아래 bestSupported 로 다시 정합니다.
        if (g.ok) {
          // 모델이 붙인 [n]은 틀리는 경우가 있어(예: 배송비 답에 반품 배송비 문서를 인용), 답변과 실제로 가장 많이 겹치는 문서를 출처로 씁니다.
          const cited = bestSupported(raw.replace(/\[\d+\]/g, ''), hits);
          return { answer: raw.replace(/\s*\[\d+\](\s*\[\d+\])*\s*$/u, '').trim(), generator: 'llm', cited };
        }
        // 모델이 스스로 "근거 부족"이라고 답한 경우: 상담원 연결 대상(generator 에 llm-abstain 기록).
        if (g.reason === 'abstain') return { answer: null, generator: 'llm-abstain', cited: [] };
        // 환각 검사 실패: 검색 신뢰도가 충분할 때만 원문 발췌로 대체하고, 아니면 답변을 포기하고 상담원에게 넘깁니다.
        if (confidence < STRONG) return { answer: null, generator: `llm-rejected(${g.reason})`, cited: [] };
        return { answer: extractiveAnswer(question, hits), generator: `extractive(guard:${g.reason})`, cited: hits.slice(0, 2) };
      } catch {
        // 시간 초과·연결 오류 → 아래 추출형으로
      }
    }
    // 여기까지 왔다면 LLM 을 쓸 수 없거나(꺼짐·서버 없음) 호출이 실패(연결·시간 초과)한 경우입니다. 오류로 삼지 않고 추출형 답변으로 이어집니다. 덕분에 LLM 이 죽어도 서비스는 멈추지 않습니다.
    return { answer: extractiveAnswer(question, hits), generator: 'extractive', cited: hits.slice(0, 2) };
  }

  // 질문 한 건 처리(위 헤더 설명의 0~5단계). sessionId: 브라우저 세션 식별자(대화 맥락·기록용), rawQuestion: 고객이 입력한 원문.
  //   반환 모양: { id(문의 번호), answer, generator, confidence, sources, analysis:{category, categoryProb, top, sentiment, ...}, piiMasked, escalated, ticketId, escalateReason, latencyMs }
  async ask(sessionId, rawQuestion) {
    // t0: 응답 시간(latencyMs) 측정 시작 시각.
    const t0 = Date.now();
    // 입력 정리: 문자열로 바꾸고 앞뒤 공백 제거(null/undefined 는 빈 문자열).
    const question0 = String(rawQuestion ?? '').trim();
    // 0) 입력 검사 — 빈 질문 거절. HttpError 는 server.mjs 가 400 응답으로 바꿉니다.
    if (!question0) throw new HttpError(400, '질문을 입력해 주세요.');
    // 긴 입력 제한: 500자 초과 거절(LLM 입력 길이·비용 폭주와 악용 방지. 화면의 input 도 maxlength 500).
    if (question0.length > 500) throw new HttpError(400, '질문은 500자 이내로 입력해 주세요.');
    // 1) 개인정보 마스킹: question 은 가려진 문장, found 는 발견된 종류. 원문(question0)은 이 줄 이후 쓰지 않습니다 → DB·LLM 에 원본이 가지 않음.
    const { masked: question, found } = maskPII(question0);
    // 같은 세션의 최근 대화(최대 6건) — 후속 질문 맥락과 LLM 대화 이력에 사용.
    const history = this.store.history(sessionId);

    // 2) 분석: 톤(감정·우선순위·근거 단어)과 문의 유형. 분기와 무관하게 모든 질문에 수행해 기록·통계에 씁니다.
    const tone = analyzeTone(question);
    const cat = this.classifier.predict(question);

    // 결과 변수: answer 답변문, generator 방식, sources 근거 목록, confidence 검색 신뢰도(검색 경로가 아니면 0 또는 1), escalateReason 상담원 연결 사유(null 이면 연결 안 함)
    let answer, generator, sources = [], confidence = 0, escalateReason = null;

    // 질문에서 주문번호가 있으면 대문자로 정규화해 둡니다(없으면 undefined).
    const orderNo = ORDER_RE.exec(question)?.[0].toUpperCase();
    // 3-a) 상담원 연결 요청 — 검색·LLM 없이 고정 안내. 사유 user_request.
    if (wantsHuman(question)) {
      answer = '상담원 연결을 요청하셨어요. 문의를 접수했으며 영업일 기준 24시간 안에 답변드리겠습니다. 운영시간은 평일 9시~18시(점심 12~13시)입니다.';
      generator = 'rule'; escalateReason = 'user_request';
    } else if (!ORDER_RE.test(question) && (SMALLTALK.find(([re]) => re.test(question)))) {
      // 3-b) 잡담 — 주문번호가 함께 있으면 잡담으로 보지 않습니다(주문 조회가 우선). 고정 응답이라 신뢰도 1.
      answer = SMALLTALK.find(([re]) => re.test(question))[1];
      generator = 'smalltalk'; confidence = 1;
    } else if (orderNo) {
      // 3-c) 주문 조회 — DB 에 있는 주문이면 상태별 안내문, 없으면 "찾을 수 없음" 안내. 근거 출처에는 주문 조회 결과를 표시합니다.
      const o = this.store.order(orderNo);
      if (o) {
        answer = describeOrder(o); generator = 'order-lookup'; confidence = 1;
        sources = [{ kind: 'order', id: o.order_no, title: '주문 조회 결과', text: `${o.item} / ${o.status}` }];
      } else {
        answer = `${orderNo} 주문번호를 찾을 수 없습니다. 주문번호를 다시 확인해 주세요. 마이페이지 > 주문내역에서 확인할 수 있습니다.`;
        generator = 'order-lookup'; confidence = 1;
      }
    } else {
      // 3-d) 일반 질문 → RAG. 직전 맥락을 반영한 질의로 상위 4개 조각을 검색합니다.
      const { hits, confidence: conf } = await this.retriever.search(this.retrievalQuery(question, history), 4);
      confidence = conf;
      // 신뢰도가 임계값 미만이면 LLM 을 아예 호출하지 않고 "자료를 찾지 못했다"고 안내한 뒤 상담원에게 넘깁니다(환각 방지 1겹).
      //       참고용으로 검색된 상위 2개 조각은 상담원 화면 근거로 남깁니다.
      if (conf < this.threshold) {
        answer = '죄송해요, 해당 내용은 안내할 수 있는 자료를 찾지 못했어요. 상담원에게 전달해 드릴게요. 영업일 기준 24시간 안에 답변드리겠습니다.';
        generator = 'no-evidence'; escalateReason = 'low_confidence';
        sources = hits.slice(0, 2).map(toSource);
      } else {
        // 신뢰도가 충분하면 답변 생성(compose). 결과가 null 이면 "자료에서 확인되지 않아 상담원에게 전달" 안내 후 에스컬레이션.
        const r = await this.compose(question, hits, history, conf);
        if (r.answer === null) {
          answer = '죄송해요, 문의하신 내용은 저희 안내 자료에서 확인되지 않아 상담원에게 전달해 드릴게요. 영업일 기준 24시간 안에 답변드리겠습니다.';
          generator = r.generator; escalateReason = 'low_confidence'; sources = hits.slice(0, 2).map(toSource);
        } else {
          answer = r.answer; generator = r.generator; sources = r.cited.map(toSource);
        }
      }
    }

    // 4) 긴급·사고성 문의 알림 — 이미 다른 사유로 연결되지 않았고, 우선순위가 high 이거나 사고성(법적·결제 오류 등)이면 사유 priority 로 티켓을 추가로 만듭니다.
    //    이 경우 챗봇 답은 그대로 주되 사과와 "상담원에게도 전달" 문구를 덧붙입니다.
    // 긴급·사고성 문의는 답변과 별개로 상담원에게도 알립니다.
    if (!escalateReason && (tone.priority === 'high' || tone.incident)) escalateReason = 'priority';
    if (escalateReason === 'priority') answer += ' 불편을 드려 죄송합니다. 우선 확인이 필요한 문의로 상담원에게도 전달했습니다.';

    // 5) DB 에 문의 저장. 저장되는 질문은 마스킹된 문장입니다. 확률·신뢰도는 소수 3자리로 반올림, latencyMs 는 걸린 시간(ms).
    const id = this.store.addInquiry({
      sessionId, question, piiFound: found, category: cat.label, categoryProb: Number(cat.prob.toFixed(3)),
      sentiment: tone.sentiment, priority: tone.priority, reasons: tone.reasons, answer, generator,
      confidence: Number(confidence.toFixed(3)), sources, escalated: !!escalateReason, latencyMs: Date.now() - t0,
    });
    let ticketId = null;
    // 티켓 우선순위: 사유가 priority 면 high, 아니면 문의 우선순위를 따르되 low 는 medium 으로 올립니다(상담원에게 넘어간 문의는 최소 보통).
    if (escalateReason) ticketId = this.store.addTicket(id, escalateReason, escalateReason === 'priority' ? 'high' : tone.priority === 'low' ? 'medium' : tone.priority);

    // 화면에 돌려줄 응답. 화면 표시용이라 숫자는 소수 2자리로 줄입니다. analysis.top 은 분류 상위 3개 후보입니다.
    return {
      id, answer, generator, confidence: Number(confidence.toFixed(2)), sources,
      analysis: { category: cat.label, categoryProb: Number(cat.prob.toFixed(2)), top: cat.ranked, ...tone },
      piiMasked: found, escalated: !!escalateReason, ticketId, escalateReason, latencyMs: Date.now() - t0,
    };
  }

  // 상담원 보조: 티켓 질문에 대한 답변 초안(근거 포함)
  // 상담원용 답변 초안 만들기. 티켓의 (마스킹된) 질문으로 다시 검색해 근거가 있으면 답변을 채우고, 없으면 "상담원 작성 필요" 문구를 넣습니다.
  //   이 함수는 초안만 만들 뿐 발송·저장하지 않습니다 — 상담원이 검토 후 직접 등록해야 합니다(사람이 최종 책임).
  //   반환: { draft, generator, sources, confidence }
  async draft(ticketId) {
    const t = this.store.ticket(ticketId);
    // 없는 티켓이면 404.
    if (!t) throw new HttpError(404, '티켓을 찾을 수 없습니다.');
    const { hits, confidence } = await this.retriever.search(t.question, 4);
    let body = '', generator = 'none', cited = [];
    // 초안 기준은 챗봇 임계값의 75%(더 느슨): 상담원이 검토하므로 약한 근거라도 참고 초안으로 보여 줄 가치가 있다고 봅니다.
    if (confidence >= this.threshold * 0.75) {
      const r = await this.compose(t.question, hits, [], confidence);
      if (r.answer) { body = r.answer; generator = r.generator; cited = r.cited; }
    }
    // 감정이 매우 나쁘거나(≤ -0.35) 우선순위가 높으면 첫머리에 사과 문구를 추가합니다.
    const apology = t.sentiment <= -0.35 || t.priority === 'high' ? '이용에 불편을 드려 진심으로 죄송합니다. ' : '';
    const intro = `안녕하세요, 모아마켓 고객센터입니다. 문의해 주셔서 감사합니다.\n${apology}`;
    const outro = '\n추가로 궁금하신 점이 있으시면 언제든 말씀해 주세요. 감사합니다.';
    const text = body
      ? `${intro}${body}${outro}`
      : `${intro}[상담원 작성 필요] 관련 안내 자료를 찾지 못했습니다. 문의 내용을 확인하고 직접 답변을 작성해 주세요.${outro}`;
    return { draft: text, generator, sources: cited.map(toSource), confidence: Number(confidence.toFixed(2)) };
  }
}

// 답변 문장의 바이그램을 가장 많이 담은 문서 1개(2등이 90% 이상이면 함께)를 고릅니다.
// 출처 선정: 답변 문장의 글자 바이그램을 가장 많이 포함한 조각 1개를 고르고, 2등이 1등의 90% 이상이면 함께 고릅니다.
//   hits 는 검색 row 배열, 반환도 같은 row 배열입니다. (LLM 이 붙인 [n] 번호가 틀릴 수 있어 실제 내용 일치로 다시 정함)
export function bestSupported(answer, hits) {
  const ab = new Set(tokens(answer).filter((t) => t[0] === 'b'));
  const scored = hits.map((h) => {
    const ct = new Set(tokens(h.chunk.title + ' ' + h.chunk.text));
    let n = 0; for (const t of ab) if (ct.has(t)) n++;
    return { h, n };
  }).sort((a, b) => b.n - a.n);
  const top = scored[0];
  return scored.filter((x, i) => i === 0 || (i === 1 && x.n >= top.n * 0.9)).map((x) => x.h);
}

// HTTP 상태코드를 가진 오류. 서비스 계층에서 던지면 server.mjs 의 catch 가 status 를 응답 코드로 사용합니다(400 잘못된 입력, 404 없음 등).
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// 검색 row → 화면에 보여 줄 근거 항목 {kind:'kb', id, title, doc, text, score}. score 는 fused 점수를 소수 2자리로 줄인 값.
const toSource = (h) => ({ kind: 'kb', id: h.chunk.id, title: h.chunk.title, doc: h.chunk.doc, text: h.chunk.text, score: Number(h.fused.toFixed(2)) });
