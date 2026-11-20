import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CategoryClassifier } from './analyze.mjs';
import { ChatService } from './chat.mjs';
import { Store, openDb } from './db.mjs';
import { loadKnowledge } from './kb.mjs';
import { OllamaLLM } from './llm.mjs';
import { Retriever } from './rag.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function loadLabeled() {
  return JSON.parse(readFileSync(`${ROOT}data/inquiries-labeled.json`, 'utf8'));
}

// 서비스 조립. 테스트에서는 인메모리 DB·LLM 비활성으로 호출합니다.
export async function createServices({ dbFile = ':memory:', llmEnabled = true, embeddings = false, llmModel = 'kanana2:3b', threshold = 0.2 } = {}) {
  const chunks = loadKnowledge(`${ROOT}knowledge`);
  const retriever = await new Retriever(chunks, { cacheFile: `${ROOT}data/embeddings.json`, useEmbeddings: embeddings }).init();
  const classifier = new CategoryClassifier().train(loadLabeled().train);
  const llm = new OllamaLLM({ model: llmModel, enabled: llmEnabled });
  await llm.check();
  if (llmEnabled) await llm.warmup();
  const store = new Store(openDb(dbFile));
  const chat = new ChatService({ retriever, store, classifier, llm, threshold });
  return { chunks, retriever, classifier, llm, store, chat };
}
