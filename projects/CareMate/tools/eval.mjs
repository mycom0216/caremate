// ─────────────────────────────────────────────────────────────────────────────
// eval.mjs — RAG 평가 도구: 검색·거절·분류(·답변)의 정확도를 같은 질문 세트로 반복 측정
//
// [용어]  · hit@1 / hit@4: 정답 문서가 검색 1등 / 상위 4개 안에 들어간 질문의 비율.
//         · 범위 밖(out-of-scope) 질문: 지식베이스에 답이 없는 질문(예: 날씨). 정답은 "신뢰도가 낮아 거절"입니다.
//         · correctDecision: 범위 안 질문은 "받아들임(신뢰도 ≥ 임계값)", 범위 밖은 "거절"이면 올바른 판단.
// [입력]  data/eval-questions.json — 항목 {q: 질문, expect: 정답 조각 ID 배열(빈 배열이면 범위 밖), must: 답변에 들어가야 할 문구 후보}
// [출력]  요약 JSON 을 콘솔에 출력하고, 틀린 질문은 '실패:' 로 따로 나열합니다. --out 을 주면 질문별 상세 결과를 파일로도 저장합니다.
// [옵션]  --llm  실제 답변까지 생성(Ollama 필요, 느림)해 답변 정확도·인용·응답시간을 측정 / --out 파일  결과 저장
// [한계]  평가 질문이 적고 문서와 같은 사람이 썼으므로 수치는 낙관적일 수 있습니다(README 참고).
// ─────────────────────────────────────────────────────────────────────────────
// RAG 평가: 고정 질문 세트로 검색 적중률, 범위 밖 질문 거절률, 분류 정확도, (LLM 사용 시) 답변 품질·시간을 측정합니다.
// 사용법: node tools/eval.mjs [--llm] [--out evidence/eval.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ROOT, createServices, loadLabeled } from '../src/app.mjs';

// 명령줄 옵션 해석: --llm 이 있는지, --out 다음 값이 저장 경로인지.
const useLlm = process.argv.includes('--llm');
const outIdx = process.argv.indexOf('--out');
const out = outIdx > 0 ? process.argv[outIdx + 1] : null;
// 평가용 질문 세트를 읽고, 서비스는 LLM 사용 여부만 옵션에 맞춰 조립합니다(DB 는 메모리).
const questions = JSON.parse(readFileSync(`${ROOT}data/eval-questions.json`, 'utf8'));
const svc = await createServices({ llmEnabled: useLlm, llmModel: process.env.LLM_MODEL ?? 'kanana2:3b' });

// rows: 질문별 결과 누적.
const rows = [];
// 각 질문마다 ① 검색만 수행해 상위 4개 ID·신뢰도를 기록 ② (--llm 이면) 실제 챗봇 응답까지 받아 답변 평가.
for (const item of questions) {
  const t0 = Date.now();
  const { hits, confidence } = await svc.retriever.search(item.q, 4);
  const ids = hits.map((h) => h.chunk.id);
  // inScope: 범위 안 질문인지, accepted: 신뢰도가 임계값 이상이라 답변을 시도하는지.
  const inScope = item.expect.length > 0;
  const accepted = confidence >= svc.chat.threshold;
  // 질문 한 건의 검색 평가 기록: hit1/hit4(적중 여부), correctDecision(받아들임/거절 판단이 맞는지), retrieveMs(검색 시간).
  const row = {
    q: item.q, expect: item.expect, top4: ids, confidence: Number(confidence.toFixed(2)), inScope, accepted,
    hit1: inScope && item.expect.includes(ids[0]),
    hit4: inScope && item.expect.some((e) => ids.includes(e)),
    correctDecision: inScope ? accepted : !accepted,
    retrieveMs: Date.now() - t0,
  };
  // --llm: 실제 ChatService.ask 로 전체 답변 파이프라인을 실행합니다(세션 ID 는 질문마다 새로 만들어 대화 맥락이 섞이지 않게 함).
  if (useLlm) {
    const r = await svc.chat.ask('eval-' + rows.length + '-session', item.q);
    row.generator = r.generator; row.answer = r.answer; row.escalated = r.escalated; row.latencyMs = r.latencyMs;
    row.citedExpected = r.sources.some((s) => item.expect.includes(s.id));
    // 정답 기준: 핵심 사실 문구(must 중 하나)가 답변에 있어야 함. 범위 밖 질문은 상담원 연결 또는 잡담 응답이어야 함.
    row.answerOk = inScope ? item.must.some((m) => r.answer.includes(m)) : (r.escalated || r.generator === 'smalltalk');
    await new Promise((r2) => setTimeout(r2, 850)); // 서버 쪽 속도 제한과 같은 간격 유지(여기선 불필요하지만 부하 완화)
  }
  rows.push(row);
}

// 집계: 범위 안/밖 분리, pct(백분율 소수 1자리), median(가운데 값. 짝수 개면 뒤쪽 가운데 값). 분류기는 분리된 test 문장으로 평가합니다.
const inRows = rows.filter((r) => r.inScope), outRows = rows.filter((r) => !r.inScope);
const pct = (n, d) => (d ? Number(((100 * n) / d).toFixed(1)) : null);
const sorted = (a) => [...a].sort((x, y) => x - y);
const median = (a) => (a.length ? sorted(a)[Math.floor(a.length / 2)] : null);
const labeled = loadLabeled();
const cls = svc.classifier.evaluate(labeled.test);
// 요약 객체: 검색 방식, 질문 수, hit@1·hit@4, 범위 안 수용률, 범위 밖 거절률, 판단 정확도, 검색 중앙값 시간, 분류 정확도·오분류.
const summary = {
  retrieval: svc.retriever.mode,
  llm: useLlm ? svc.llm.model + (svc.llm.available ? '' : ' (연결 실패→추출형)') : '사용 안 함',
  questions: { inScope: inRows.length, outOfScope: outRows.length },
  hitAt1: pct(inRows.filter((r) => r.hit1).length, inRows.length),
  hitAt4: pct(inRows.filter((r) => r.hit4).length, inRows.length),
  inScopeAccepted: pct(inRows.filter((r) => r.accepted).length, inRows.length),
  outOfScopeRejected: pct(outRows.filter((r) => !r.accepted).length, outRows.length),
  decisionAccuracy: pct(rows.filter((r) => r.correctDecision).length, rows.length),
  retrieveMedianMs: median(rows.map((r) => r.retrieveMs)),
  classifier: { accuracy: Number((cls.accuracy * 100).toFixed(1)), correct: cls.correct, total: cls.total, errors: cls.errors },
};
// --llm 일 때만: 답변 정확도, 정답 문서 인용률, 응답시간 중앙값·최댓값, 답변 방식별 횟수.
if (useLlm) {
  summary.answerAccuracy = pct(rows.filter((r) => r.answerOk).length, rows.length);
  summary.citationHit = pct(inRows.filter((r) => r.citedExpected).length, inRows.length);
  summary.answerMedianMs = median(rows.map((r) => r.latencyMs));
  summary.answerMaxMs = Math.max(...rows.map((r) => r.latencyMs));
  summary.generators = rows.reduce((m, r) => ((m[r.generator] = (m[r.generator] ?? 0) + 1), m), {});
}
console.log(JSON.stringify(summary, null, 2));
// 틀린 항목(판단 오류, 범위 안인데 hit@4 실패, 답변 오류)을 '실패:' 줄로 보여 줍니다.
for (const r of rows.filter((r) => !r.correctDecision || (r.inScope && !r.hit4) || (useLlm && !r.answerOk))) {
  console.log('실패:', r.q, '→', r.top4.join(','), 'conf', r.confidence, r.generator ?? '');
}
// --out 이 있으면 폴더를 만들고(recursive) 시각·요약·질문별 상세를 JSON 파일로 저장합니다(evidence 용 원자료).
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), summary, rows }, null, 2));
}
