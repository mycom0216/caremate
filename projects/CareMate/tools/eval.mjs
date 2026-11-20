// RAG 평가: 고정 질문 세트로 검색 적중률, 범위 밖 질문 거절률, 분류 정확도, (LLM 사용 시) 답변 품질·시간을 측정합니다.
// 사용법: node tools/eval.mjs [--llm] [--out evidence/eval.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ROOT, createServices, loadLabeled } from '../src/app.mjs';

const useLlm = process.argv.includes('--llm');
const outIdx = process.argv.indexOf('--out');
const out = outIdx > 0 ? process.argv[outIdx + 1] : null;
const questions = JSON.parse(readFileSync(`${ROOT}data/eval-questions.json`, 'utf8'));
const svc = await createServices({ llmEnabled: useLlm });

const rows = [];
for (const item of questions) {
  const t0 = Date.now();
  const { hits, confidence } = await svc.retriever.search(item.q, 4);
  const ids = hits.map((h) => h.chunk.id);
  const inScope = item.expect.length > 0;
  const accepted = confidence >= svc.chat.threshold;
  const row = {
    q: item.q, expect: item.expect, top4: ids, confidence: Number(confidence.toFixed(2)), inScope, accepted,
    hit1: inScope && item.expect.includes(ids[0]),
    hit4: inScope && item.expect.some((e) => ids.includes(e)),
    correctDecision: inScope ? accepted : !accepted,
    retrieveMs: Date.now() - t0,
  };
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

const inRows = rows.filter((r) => r.inScope), outRows = rows.filter((r) => !r.inScope);
const pct = (n, d) => (d ? Number(((100 * n) / d).toFixed(1)) : null);
const sorted = (a) => [...a].sort((x, y) => x - y);
const median = (a) => (a.length ? sorted(a)[Math.floor(a.length / 2)] : null);
const labeled = loadLabeled();
const cls = svc.classifier.evaluate(labeled.test);
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
if (useLlm) {
  summary.answerAccuracy = pct(rows.filter((r) => r.answerOk).length, rows.length);
  summary.citationHit = pct(inRows.filter((r) => r.citedExpected).length, inRows.length);
  summary.answerMedianMs = median(rows.map((r) => r.latencyMs));
  summary.answerMaxMs = Math.max(...rows.map((r) => r.latencyMs));
  summary.generators = rows.reduce((m, r) => ((m[r.generator] = (m[r.generator] ?? 0) + 1), m), {});
}
console.log(JSON.stringify(summary, null, 2));
for (const r of rows.filter((r) => !r.correctDecision || (r.inScope && !r.hit4) || (useLlm && !r.answerOk))) {
  console.log('실패:', r.q, '→', r.top4.join(','), 'conf', r.confidence, r.generator ?? '');
}
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), summary, rows }, null, 2));
}
