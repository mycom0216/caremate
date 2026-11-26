// ─────────────────────────────────────────────────────────────────────────────
// rag.mjs — 검색기(Retriever): 질문과 가장 관련 있는 지식 조각을 찾고 "얼마나 믿을 만한지(신뢰도)"를 계산
//
// [RAG 에서의 위치]  RAG(검색 증강 생성)는 "먼저 찾고(Retrieval), 찾은 내용만 근거로 답한다(Generation)"는 구조입니다.
//                   이 파일이 앞의 "찾기" 단계입니다. 답을 만드는 일은 llm.mjs, 흐름 제어는 chat.mjs 가 합니다.
//
// [검색 방식]
//   1) BM25 (어휘 검색): 질문과 같은 글자 덩어리(토큰)가 많이, 그리고 드물게 쓰이는 단어일수록 높은 점수를 주는 고전적 알고리즘.
//      토큰은 text.mjs 의 어절+글자 바이그램을 씁니다. 외부 라이브러리 없이 직접 구현했습니다.
//   2) 임베딩 (의미 검색, 선택): 문장을 숫자 벡터로 바꾸는 모델(Ollama embeddinggemma)로 두 벡터의 방향이 비슷한지
//      (코사인 유사도) 비교해 "단어는 다르지만 뜻이 비슷한" 문서도 찾음. EMBEDDINGS=on 일 때만 쓰며, 실패하면 자동으로 BM25 만 씁니다.
//   3) 두 점수를 섞어(fused) 순위를 매김.
//
// [신뢰도(confidence)]  "찾은 문서가 질문에 답할 근거가 되는가"를 0~1 로 나타낸 값입니다. 이 값이 임계값(기본 0.2)보다 낮으면
//                      챗봇은 지어내지 않고 상담원에게 넘깁니다(환각 방지의 첫 번째 관문).
//
// [검색 결과 한 행(row)의 모양]
//   { chunk: 지식 조각, bm25: 원점수, coverage: 질의 토큰 중 문서가 가진 비율(가중), cosine: 코사인 유사도 또는 null, fused: 최종 점수 }
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { FILLER, tokens, words } from './text.mjs';

// BM25 의 두 조절값. K1: 같은 단어가 여러 번 나와도 점수가 무한히 커지지 않게 하는 포화 정도(클수록 반복에 더 보상).
//   B: 문서 길이 정규화 강도(0~1, 1이면 평균보다 긴 문서의 점수를 크게 깎음). 0.75 는 BM25 에서 널리 쓰이는 기본값입니다.
const K1 = 1.4, B = 0.75;

// BM25(문자 바이그램) + 선택적 임베딩(Ollama) 하이브리드 검색기.
export class Retriever {
  // chunks: kb.mjs 가 만든 조각 배열. 생성자는 BM25 에 필요한 통계를 미리 계산해 둡니다(검색할 때마다 다시 세지 않기 위함).
  //   옵션: ollamaUrl/embedModel(임베딩 서버·모델), cacheFile(벡터 캐시 파일), useEmbeddings(임베딩 사용 여부)
  constructor(chunks, { ollamaUrl = 'http://127.0.0.1:11434', embedModel = 'embeddinggemma', cacheFile = null, useEmbeddings = true } = {}) {
    this.chunks = chunks;
    this.ollamaUrl = ollamaUrl;
    this.embedModel = embedModel;
    this.cacheFile = cacheFile;
    this.useEmbeddings = useEmbeddings;
    // vectors: 조각별 임베딩 벡터 배열. null 이면 임베딩을 쓰지 않는 상태(= BM25 전용)입니다. init() 이 성공해야 채워집니다.
    this.vectors = null;
    // docs: 조각마다 {tf, len}. tf(term frequency)는 토큰별 등장 횟수 Map, len 은 토큰 총 개수입니다.
    //   제목을 두 번 넣어(title title text) 제목에 있는 단어에 가중을 줍니다 — 제목이 항목의 주제를 가장 잘 나타내기 때문입니다.
    this.docs = chunks.map((c) => {
      const toks = tokens(`${c.title} ${c.title} ${c.text}`);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      return { tf, len: toks.length };
    });
    // avgLen: 조각 평균 길이(BM25 의 길이 정규화에 사용). 조각이 없을 때 0 으로 나누지 않도록 || 1 을 둡니다.
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / (this.docs.length || 1);
    // df(document frequency): 각 토큰이 몇 개의 조각에 나타나는지. 여러 조각에 흔한 단어일수록 변별력이 낮다고 봅니다.
    this.df = new Map();
    for (const d of this.docs) for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }

  // 현재 검색 방식 이름(화면 상단과 서버 시작 로그에 표시). 벡터가 있으면 하이브리드, 없으면 BM25.
  get mode() { return this.vectors ? 'hybrid(BM25+embedding)' : 'BM25'; }

  // idf(inverse document frequency): 드문 토큰일수록 큰 값. log(1 + (N - n + 0.5)/(n + 0.5)) 형태(N=전체 조각 수, n=그 토큰이 있는 조각 수).
  //   1 + 를 붙인 변형이라 흔한 단어도 음수가 되지 않고 항상 0 이상입니다.
  idf(t) {
    const n = this.df.get(t) ?? 0, N = this.docs.length;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  // Ollama 의 /api/embed 로 텍스트 배열을 벡터 배열로 바꿉니다. 응답이 없을 때 서버가 멈추지 않도록 AbortSignal.timeout 으로 시간 제한을 둡니다.
  //   HTTP 오류면 예외를 던져 호출한 쪽(init/search)이 BM25 로 대체하게 합니다.
  async embed(texts, timeoutMs = 20000) {
    const res = await fetch(`${this.ollamaUrl}/api/embed`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.embedModel, input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error('embed ' + res.status);
    return (await res.json()).embeddings;
  }

  // 초기화(비동기). 임베딩을 쓰는 경우에만 의미가 있습니다. 항상 this 를 돌려줘 new Retriever(...).init() 처럼 이어 쓸 수 있습니다.
  //   흐름: 캐시 확인 → (없거나 낡았으면) 임베딩 서버 호출 → 캐시 저장. 어디서든 실패하면 vectors=null 로 두고 BM25 만 씁니다.
  async init() {
    if (!this.useEmbeddings) return this;
    const texts = this.chunks.map((c) => `${c.title}\n${c.text}`);
    // 캐시 키: 모델 이름 + 조각 내용 전체의 SHA-256 해시. 문서나 모델이 바뀌면 키가 달라져 낡은 벡터를 쓰지 않습니다.
    const key = createHash('sha256').update(this.embedModel + JSON.stringify(texts)).digest('hex');
    try {
      // 캐시 파일이 있고 키가 같으면 서버 호출 없이 저장된 벡터를 재사용합니다(시작 속도 향상).
      if (this.cacheFile && existsSync(this.cacheFile)) {
        const cached = JSON.parse(readFileSync(this.cacheFile, 'utf8'));
        if (cached.key === key) { this.vectors = cached.vectors; return this; }
      }
      // 캐시가 없으면 새로 계산(조각 수가 많아 첫 호출만 시간 제한을 60초로 넉넉히 둠)하고 파일에 저장합니다.
      this.vectors = await this.embed(texts, 60000);
      if (this.cacheFile) writeFileSync(this.cacheFile, JSON.stringify({ key, vectors: this.vectors }));
    } catch {
      this.vectors = null; // 임베딩 서버가 없으면 BM25만 사용
    }
    return this;
  }

  // BM25 점수 계산. 반환: 조각 순서와 같은 배열 [{score, coverage}, ...].
  //   BM25 공식(조각 d, 질의 토큰 t): score = Σ idf(t) · f·(K1+1) / (f + K1·(1 − B + B·len/avgLen))   (f = d 안에서 t 의 등장 횟수)
  //   coverage 는 "질의의 (가중) 토큰 중 이 조각이 가진 비율"로 신뢰도 계산에 따로 씁니다.
  bm25(query) {
    // 질의 토큰을 중복 없이(Set) 뽑습니다. query:true 로 군말은 이미 제거된 상태입니다.
    const q = [...new Set(tokens(query, { query: true }))];
    // 토큰 가중치: 코퍼스에 있는 토큰은 idf, 한 번도 없는 토큰(군말·오탈자)은 idf 의 30% 만 반영해
    //   질의에 모르는 단어가 섞여 있어도 커버리지가 과도하게 떨어지지 않게 합니다. (0.3 은 코드에 고정된 경험적 값)
    // 코퍼스에 한 번도 없는 토큰(군말·오탈자)은 영향력을 낮춰 커버리지가 과도하게 떨어지지 않게 합니다.
    const weight = (t) => (this.df.has(t) ? this.idf(t) : 0.3 * this.idf(t));
    // qWeight: 질의 전체 가중치 합(커버리지의 분모). 질의 토큰이 없으면 0 이 되므로 || 1 로 0 나눗셈을 피합니다.
    const qWeight = q.reduce((s, t) => s + weight(t), 0) || 1;
    // 조각마다 점수를 계산: 질의 토큰 중 이 조각에 있는 것(f 가 0 이 아님)만 더합니다.
    return this.docs.map((d) => {
      let score = 0, hit = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const idf = this.idf(t);
        score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / this.avgLen));
        hit += weight(t);
      }
      return { score, coverage: hit / qWeight };
    });
  }

  // 코퍼스 밖 어절 비율(Out-Of-Vocabulary ratio): 질문의 핵심 어절 중 지식베이스에 글자 단위로도 전혀 없는 어절의 비율(0~1).
  //   3글자 이상 어절의 바이그램·글자 토큰이 하나도 df 에 없으면 "지식베이스에 없는 주제"(예: '양자컴퓨터')로 셉니다.
  //   어절이 짧으면(1~2글자) 우연히 겹치는 일이 많아 제외합니다.
  oovRatio(query) {
    const ws = words(query).filter((w) => !FILLER.has(w));
    if (!ws.length) return 0;
    const oov = ws.filter((w) => {
      const ts = tokens(w, { query: true }).filter((t) => t[0] === 'b' || t[0] === 'c');
      return w.length >= 3 && ts.length > 0 && ts.every((t) => !this.df.has(t));
    });
    return oov.length / ws.length;
  }

  // 검색 본체. 반환: { hits: 상위 k개 row, confidence: 0~1 신뢰도, oovRatio }. k 기본 4.
  //   순서: ① BM25 ② (가능하면) 임베딩 코사인 ③ 점수 정규화·결합 ④ 정렬 ⑤ 신뢰도 계산
  async search(query, k = 4) {
    const lex = this.bm25(query);
    // cos: 질의-조각 코사인 유사도 배열. 임베딩이 없거나 호출이 실패하면 null 로 두고 BM25 만 사용합니다(질문 한 건 때문에 서비스가 멈추지 않음).
    let cos = null;
    if (this.vectors) {
      try {
        const [qv] = await this.embed([query], 5000);
        cos = this.vectors.map((v) => cosine(qv, v));
      } catch { cos = null; }
    }
    // BM25 점수는 질문마다 크기가 달라 그대로 섞을 수 없으므로 1등 점수(maxBm)로 나눠 0~1 로 맞춥니다(분모 0 방지용 1e-9).
    const maxBm = Math.max(...lex.map((l) => l.score), 1e-9);
    // fused(최종 점수): 의미 점수가 없으면 BM25 정규화 점수 그대로.
    //   있으면 0.5·BM25 + 0.5·의미. 의미 점수는 코사인 0.3 이하를 0 으로 보고 (cos−0.3)/0.5 로 늘린 값입니다
    //   (임베딩 모델의 코사인은 무관한 문장끼리도 0.3 안팎이 나오기 때문에 하한을 둠). 하한 0 만 보장하며 상한은 두지 않았습니다.
    const rows = this.chunks.map((c, i) => {
      const bn = lex[i].score / maxBm;
      const sem = cos ? cos[i] : null;
      const fused = sem === null ? bn : 0.5 * bn + 0.5 * Math.max(0, (sem - 0.3) / 0.5);
      return { chunk: c, bm25: lex[i].score, coverage: lex[i].coverage, cosine: sem, fused };
    });
    // fused 내림차순 정렬 후 상위 k개만 남깁니다.
    rows.sort((a, b) => b.fused - a.fused);
    const top = rows.slice(0, k);
    // ── 신뢰도 계산 ──
    // 신뢰도: 질의 토큰 커버리지(어휘 근거)와 임베딩 유사도(의미 근거)를 섞은 값
    const best = top[0];
    // semScore: 1등 조각의 코사인을 (cos−0.35)/0.35 로 0~1 로 맞춘 값(임베딩이 없으면 null).
    const semScore = best.cosine === null ? null : Math.min(1, Math.max(0, (best.cosine - 0.35) / 0.35));
    // base: 임베딩이 없으면 1등의 어휘 커버리지, 있으면 커버리지와 의미 점수의 평균.
    const base = semScore === null ? best.coverage : 0.5 * best.coverage + 0.5 * semScore;
    // 질의의 핵심 어절이 지식베이스 어디에도 없으면(예: "양자컴퓨터", "블랙홀") 범위 밖일 가능성이 높아 신뢰도를 깎습니다.
    const oov = this.oovRatio(query);
    // 최종 신뢰도 = base × (1 − 0.7 × oov). 코퍼스 밖 어절이 많을수록 최대 70% 까지 깎습니다. (0.7 은 코드에 고정된 경험적 값)
    //   기본 임계값 0.2 보다 낮으면 chat.mjs 가 "근거 없음"으로 처리해 상담원에게 넘깁니다.
    return { hits: top, confidence: base * (1 - 0.7 * oov), oovRatio: oov };
  }
}

// 코사인 유사도: 두 벡터의 내적 / (각 길이의 곱) = 두 벡터가 같은 방향일수록 1 에 가까움. 길이가 0 이면 0 으로 나누지 않도록 || 1.
function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}
