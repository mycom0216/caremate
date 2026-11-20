import { fileURLToPath } from 'node:url';
import { loadKnowledge } from '../src/kb.mjs';
import { Retriever } from '../src/rag.mjs';
const chunks = loadKnowledge(fileURLToPath(new URL('../knowledge', import.meta.url)));
console.log(chunks.length, 'chunks');
const r = await new Retriever(chunks, { cacheFile: 'data/embeddings.json' }).init();
console.log(r.mode);
for (const q of process.argv.slice(2)) {
  const { hits, confidence } = await r.search(q);
  console.log(q, '=>', confidence.toFixed(2), hits.map((h) => `${h.chunk.id}(${h.fused.toFixed(2)}/cov${h.coverage.toFixed(2)}/cos${h.cosine?.toFixed(2)})`).join(' '));
}
