// ─────────────────────────────────────────────────────────────────────────────
// probe.mjs — 개발용 검색 점검 도구: 질문을 넣으면 검색 결과를 점수와 함께 한 줄로 보여 줍니다.
// 사용법: node tools/probe.mjs "질문1" "질문2" ...
// 출력 항목: 질문 => 신뢰도 / 조각ID(fused 점수 / 어휘 커버리지 cov / 코사인 cos). 임베딩이 꺼져 있으면 cos 는 undefined 로 보입니다.
// 검색 품질이 이상할 때 어떤 조각이 어떤 점수를 받는지 확인하는 용도입니다(서버가 필요 없음).
// ─────────────────────────────────────────────────────────────────────────────
import { fileURLToPath } from 'node:url';
import { loadKnowledge } from '../src/kb.mjs';
import { Retriever } from '../src/rag.mjs';
// 지식베이스를 읽어 조각 수를 출력합니다. 프로젝트 폴더 기준 상대 경로를 URL 로 계산하므로 어느 폴더에서 실행해도 knowledge/ 를 찾습니다.
const chunks = loadKnowledge(fileURLToPath(new URL('../knowledge', import.meta.url)));
console.log(chunks.length, 'chunks');
// 검색기를 만들고 init() — 이 도구는 useEmbeddings 기본값(true)을 쓰므로 임베딩 서버가 있으면 하이브리드, 없으면 BM25 로 동작합니다. 모드를 출력합니다.
const r = await new Retriever(chunks, { cacheFile: 'data/embeddings.json' }).init();
console.log(r.mode);
// 명령줄 인자(질문)마다 상위 조각과 점수를 출력합니다.
for (const q of process.argv.slice(2)) {
  const { hits, confidence } = await r.search(q);
  console.log(q, '=>', confidence.toFixed(2), hits.map((h) => `${h.chunk.id}(${h.fused.toFixed(2)}/cov${h.coverage.toFixed(2)}/cos${h.cosine?.toFixed(2)})`).join(' '));
}
