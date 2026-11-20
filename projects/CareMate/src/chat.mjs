import { analyzeTone, wantsHuman } from './analyze.mjs';
import { extractiveAnswer, guardAnswer } from './llm.mjs';
import { maskPII, tokens } from './text.mjs';

const ORDER_RE = /MM-\d{4}/iu;
const STRONG = 0.6; // 이 이상이면 LLM 답변이 거절돼도 검색 원문을 그대로 보여 줘도 안전하다고 봅니다.
const SMALLTALK = [
  [/^(안녕|하이|헬로|반가워|hello|hi)/iu, '안녕하세요! 모아마켓 상담 챗봇이에요. 배송, 교환·반품, 결제, 쿠폰·포인트 등 궁금한 점을 물어보세요.'],
  [/(고마워|감사합니다|감사해요|땡큐|수고)/u, '도움이 되었다니 기쁩니다. 다른 궁금한 점이 있으면 언제든 물어보세요.'],
  [/(이름이?\s*뭐|누구(야|세요|니)|몇\s*살|뭐하는|넌 뭐|너는 뭐)/u, '저는 모아마켓 고객 문의를 도와드리는 AI 상담 챗봇이에요. 배송, 반품, 결제, 회원 관련 질문에 안내 자료를 근거로 답해 드려요.'],
];
const FOLLOW_UP =/^(그럼|그러면|그건|그거|그럼요|그리고|아니|근데)/u;

export function describeOrder(o) {
  const money = o.amount.toLocaleString('ko-KR');
  const base = `주문번호 ${o.order_no}(${o.item}, ${money}원)은 현재 '${o.status}' 상태입니다.`;
  switch (o.status) {
    case '결제완료': return `${base} 아직 출고 전이라 마이페이지에서 취소와 배송지 변경이 가능합니다. 도착 예정일은 ${o.eta}입니다.`;
    case '상품준비중': return `${base} 포장 중이라 취소는 고객센터 확인이 필요하고, 배송지 변경은 출고 전까지 가능합니다. 도착 예정일은 ${o.eta}입니다.`;
    case '출고완료':
    case '배송중': return `${base} ${o.carrier} 운송장 번호는 ${o.tracking_no}이며 도착 예정일은 ${o.eta}입니다.`;
    case '배송완료': return `${base} ${o.carrier} 운송장 ${o.tracking_no}로 배송이 완료되었습니다. 받지 못하셨다면 고객센터로 접수해 주세요.`;
    default: return base;
  }
}

export class ChatService {
  constructor({ retriever, store, classifier, llm, threshold = 0.2 }) {
    Object.assign(this, { retriever, store, classifier, llm, threshold });
  }

  retrievalQuery(question, history) {
    const last = history.at(-1);
    if (last && (question.length < 12 || FOLLOW_UP.test(question))) return `${last.question} ${question}`;
    return question;
  }

  // 근거 문서로 답변 생성 (LLM → 환각 검사 → 실패 시 추출형)
  async compose(question, hits, history, confidence = 1) {
    if (this.llm?.available) {
      try {
        const raw = await this.llm.generate(question, hits, history);
        const g = guardAnswer(raw, question, hits);
        if (g.ok) {
          // 모델이 붙인 [n]은 틀리는 경우가 있어(예: 배송비 답에 반품 배송비 문서를 인용), 답변과 실제로 가장 많이 겹치는 문서를 출처로 씁니다.
          const cited = bestSupported(raw.replace(/\[\d+\]/g, ''), hits);
          return { answer: raw.replace(/\s*\[\d+\](\s*\[\d+\])*\s*$/u, '').trim(), generator: 'llm', cited };
        }
        if (g.reason === 'abstain') return { answer: null, generator: 'llm-abstain', cited: [] };
        // 환각 검사 실패: 검색 신뢰도가 충분할 때만 원문 발췌로 대체하고, 아니면 답변을 포기하고 상담원에게 넘깁니다.
        if (confidence < STRONG) return { answer: null, generator: `llm-rejected(${g.reason})`, cited: [] };
        return { answer: extractiveAnswer(question, hits), generator: `extractive(guard:${g.reason})`, cited: hits.slice(0, 2) };
      } catch {
        // 시간 초과·연결 오류 → 아래 추출형으로
      }
    }
    return { answer: extractiveAnswer(question, hits), generator: 'extractive', cited: hits.slice(0, 2) };
  }

  async ask(sessionId, rawQuestion) {
    const t0 = Date.now();
    const question0 = String(rawQuestion ?? '').trim();
    if (!question0) throw new HttpError(400, '질문을 입력해 주세요.');
    if (question0.length > 500) throw new HttpError(400, '질문은 500자 이내로 입력해 주세요.');
    const { masked: question, found } = maskPII(question0);
    const history = this.store.history(sessionId);

    const tone = analyzeTone(question);
    const cat = this.classifier.predict(question);

    let answer, generator, sources = [], confidence = 0, escalateReason = null;

    const orderNo = ORDER_RE.exec(question)?.[0].toUpperCase();
    if (wantsHuman(question)) {
      answer = '상담원 연결을 요청하셨어요. 문의를 접수했으며 영업일 기준 24시간 안에 답변드리겠습니다. 운영시간은 평일 9시~18시(점심 12~13시)입니다.';
      generator = 'rule'; escalateReason = 'user_request';
    } else if (!ORDER_RE.test(question) && (SMALLTALK.find(([re]) => re.test(question)))) {
      answer = SMALLTALK.find(([re]) => re.test(question))[1];
      generator = 'smalltalk'; confidence = 1;
    } else if (orderNo) {
      const o = this.store.order(orderNo);
      if (o) {
        answer = describeOrder(o); generator = 'order-lookup'; confidence = 1;
        sources = [{ kind: 'order', id: o.order_no, title: '주문 조회 결과', text: `${o.item} / ${o.status}` }];
      } else {
        answer = `${orderNo} 주문번호를 찾을 수 없습니다. 주문번호를 다시 확인해 주세요. 마이페이지 > 주문내역에서 확인할 수 있습니다.`;
        generator = 'order-lookup'; confidence = 1;
      }
    } else {
      const { hits, confidence: conf } = await this.retriever.search(this.retrievalQuery(question, history), 4);
      confidence = conf;
      if (conf < this.threshold) {
        answer = '죄송해요, 해당 내용은 안내할 수 있는 자료를 찾지 못했어요. 상담원에게 전달해 드릴게요. 영업일 기준 24시간 안에 답변드리겠습니다.';
        generator = 'no-evidence'; escalateReason = 'low_confidence';
        sources = hits.slice(0, 2).map(toSource);
      } else {
        const r = await this.compose(question, hits, history, conf);
        if (r.answer === null) {
          answer = '죄송해요, 문의하신 내용은 저희 안내 자료에서 확인되지 않아 상담원에게 전달해 드릴게요. 영업일 기준 24시간 안에 답변드리겠습니다.';
          generator = r.generator; escalateReason = 'low_confidence'; sources = hits.slice(0, 2).map(toSource);
        } else {
          answer = r.answer; generator = r.generator; sources = r.cited.map(toSource);
        }
      }
    }

    // 긴급·사고성 문의는 답변과 별개로 상담원에게도 알립니다.
    if (!escalateReason && (tone.priority === 'high' || tone.incident)) escalateReason = 'priority';
    if (escalateReason === 'priority') answer += ' 불편을 드려 죄송합니다. 우선 확인이 필요한 문의로 상담원에게도 전달했습니다.';

    const id = this.store.addInquiry({
      sessionId, question, piiFound: found, category: cat.label, categoryProb: Number(cat.prob.toFixed(3)),
      sentiment: tone.sentiment, priority: tone.priority, reasons: tone.reasons, answer, generator,
      confidence: Number(confidence.toFixed(3)), sources, escalated: !!escalateReason, latencyMs: Date.now() - t0,
    });
    let ticketId = null;
    if (escalateReason) ticketId = this.store.addTicket(id, escalateReason, escalateReason === 'priority' ? 'high' : tone.priority === 'low' ? 'medium' : tone.priority);

    return {
      id, answer, generator, confidence: Number(confidence.toFixed(2)), sources,
      analysis: { category: cat.label, categoryProb: Number(cat.prob.toFixed(2)), top: cat.ranked, ...tone },
      piiMasked: found, escalated: !!escalateReason, ticketId, escalateReason, latencyMs: Date.now() - t0,
    };
  }

  // 상담원 보조: 티켓 질문에 대한 답변 초안(근거 포함)
  async draft(ticketId) {
    const t = this.store.ticket(ticketId);
    if (!t) throw new HttpError(404, '티켓을 찾을 수 없습니다.');
    const { hits, confidence } = await this.retriever.search(t.question, 4);
    let body = '', generator = 'none', cited = [];
    if (confidence >= this.threshold * 0.75) {
      const r = await this.compose(t.question, hits, [], confidence);
      if (r.answer) { body = r.answer; generator = r.generator; cited = r.cited; }
    }
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

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const toSource = (h) => ({ kind: 'kb', id: h.chunk.id, title: h.chunk.title, doc: h.chunk.doc, text: h.chunk.text, score: Number(h.fused.toFixed(2)) });
