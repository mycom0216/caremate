// ─────────────────────────────────────────────────────────────────────────────
// app.mjs — 서비스 조립(의존성 주입) 한 곳
//
// [역할]  서버(server.mjs), 테스트(test/), 평가 도구(tools/eval.mjs)가 모두 똑같은 방식으로 서비스 묶음을 만들도록
//         "무엇을 어떤 순서로 만들어 서로 연결하는가"를 이 파일 하나에 모았습니다.
//         설정(DB 파일, LLM 사용 여부 등)만 바꿔서 운영/테스트에 같은 코드를 씁니다.
//
// [만들어지는 것]
//         chunks     지식베이스 조각 배열 (kb.mjs)
//         retriever  검색기: BM25 + (선택) 임베딩 (rag.mjs)
//         classifier 문의 유형 분류기: 나이브 베이즈 (analyze.mjs)
//         llm        Ollama 로컬 LLM 클라이언트 (llm.mjs)
//         store      SQLite 저장소 (db.mjs)
//         chat       질문 처리 흐름 전체 (chat.mjs) ← 위 부품들을 받아 사용
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CategoryClassifier } from './analyze.mjs';
import { ChatService } from './chat.mjs';
import { Store, openDb } from './db.mjs';
import { loadKnowledge } from './kb.mjs';
import { OllamaLLM } from './llm.mjs';
import { Retriever } from './rag.mjs';

// 프로젝트 루트 폴더의 절대 경로(끝에 구분자 포함). 이 파일(src/app.mjs) 기준 '..' 이 프로젝트 루트입니다.
//   다른 파일에서 ${ROOT}data/... 처럼 이어 붙여 실행 위치(cwd)와 상관없이 데이터 파일을 찾습니다.
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

// 분류기 학습·평가용 라벨 데이터(data/inquiries-labeled.json)를 읽습니다. 모양: {train: [[라벨, 문장], ...], test: [[라벨, 문장], ...]}
//   train 은 학습, test 는 학습에 쓰지 않은 문장으로 정확도를 재기 위한 분리된 세트입니다.
export function loadLabeled() {
  return JSON.parse(readFileSync(`${ROOT}data/inquiries-labeled.json`, 'utf8'));
}

// 서비스 조립 함수. 모든 인자는 선택이며, 기본값은 테스트에 알맞게 잡혀 있습니다.
//   · dbFile     ':memory:' 면 메모리 DB(테스트용, 프로세스가 끝나면 사라짐)
//   · llmEnabled false 면 LLM 을 아예 쓰지 않고 검색된 원문 문장으로 답함(추출형)
//   · embeddings true 면 Ollama 임베딩을 BM25 와 섞음(꺼져 있으면 BM25 만)
//   · threshold  검색 신뢰도가 이 값보다 낮으면 "근거 없음"으로 보고 상담원에게 넘김
//   반환값: {chunks, retriever, classifier, llm, store, chat}
// 서비스 조립. 테스트에서는 인메모리 DB·LLM 비활성으로 호출합니다.
export async function createServices({ dbFile = ':memory:', llmEnabled = true, embeddings = false, llmModel = 'kanana2:3b', threshold = 0.2 } = {}) {
  // 1) 지식베이스 로딩: knowledge/*.md 를 "## [ID] 제목" 단위 조각으로 쪼갭니다.
  const chunks = loadKnowledge(`${ROOT}knowledge`);
  // 2) 검색기 생성 + init(): 임베딩을 쓰는 경우 벡터를 만들거나 캐시(data/embeddings.json)에서 읽습니다. 실패해도 BM25 로 계속 동작합니다.
  const retriever = await new Retriever(chunks, { cacheFile: `${ROOT}data/embeddings.json`, useEmbeddings: embeddings }).init();
  // 3) 분류기 생성 + 학습: 라벨 데이터의 train 부분만 사용합니다(test 는 평가용으로 남겨 둠).
  const classifier = new CategoryClassifier().train(loadLabeled().train);
  // 4) LLM 클라이언트 생성 후 check(): Ollama 서버와 모델이 실제로 있는지 확인합니다. 없으면 available=false 가 되어 추출형으로 대체됩니다.
  const llm = new OllamaLLM({ model: llmModel, enabled: llmEnabled });
  await llm.check();
  // 5) LLM 이 쓸 수 있는 경우에만 warmup(): 첫 질문이 모델 적재 시간을 떠안지 않도록 미리 한 번 호출합니다.
  if (llmEnabled) await llm.warmup();
  // 6) DB 열기(스키마 생성·주문 시드) 후 Store 로 감쌉니다.
  const store = new Store(openDb(dbFile));
  // 7) 위 부품을 ChatService 에 주입해 질문 처리 흐름을 완성합니다.
  const chat = new ChatService({ retriever, store, classifier, llm, threshold });
  return { chunks, retriever, classifier, llm, store, chat };
}
