import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { FILLER, tokens, words } from './text.mjs';

const K1 = 1.4, B = 0.75;

// BM25(문자 바이그램) + 선택적 임베딩(Ollama) 하이브리드 검색기.
export class Retriever {
  constructor(chunks, { ollamaUrl = 'http://127.0.0.1:11434', embedModel = 'embeddinggemma', cacheFile = null, useEmbeddings = true } = {}) {
    this.chunks = chunks;
    this.ollamaUrl = ollamaUrl;
    this.embedModel = embedModel;
    this.cacheFile = cacheFile;
    this.useEmbeddings = useEmbeddings;
    this.vectors = null;
    // 제목에 추가 가중치를 주기 위해 제목 토큰을 두 번 포함한다.
    this.docs = chunks.map((c) => {
      const toks = tokens(`${c.title} ${c.title} ${c.text}`);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      return { tf, len: toks.length };
    });
    // 문서 길이 정규화와 역문서 빈도 계산에 사용할 통계를 준비한다.
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / (this.docs.length || 1);
    this.df = new Map();
    for (const d of this.docs) for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }

  get mode() { return this.vectors ? 'hybrid(BM25+embedding)' : 'BM25'; }

  // 여러 문서에서 흔하게 등장하는 토큰의 영향력을 줄인다.
  idf(t) {
    const n = this.df.get(t) ?? 0, N = this.docs.length;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  async embed(texts, timeoutMs = 20000) {
    const res = await fetch(`${this.ollamaUrl}/api/embed`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.embedModel, input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error('embed ' + res.status);
    return (await res.json()).embeddings;
  }

  // 모델명과 문서 내용의 해시로 임베딩 캐시의 유효성을 판단한다.
  async init() {
    if (!this.useEmbeddings) return this;
    const texts = this.chunks.map((c) => `${c.title}\n${c.text}`);
    const key = createHash('sha256').update(this.embedModel + JSON.stringify(texts)).digest('hex');
    try {
      if (this.cacheFile && existsSync(this.cacheFile)) {
        const cached = JSON.parse(readFileSync(this.cacheFile, 'utf8'));
        if (cached.key === key) { this.vectors = cached.vectors; return this; }
      }
      this.vectors = await this.embed(texts, 60000);
      if (this.cacheFile) writeFileSync(this.cacheFile, JSON.stringify({ key, vectors: this.vectors }));
    } catch {
      this.vectors = null; // 임베딩 서버가 없으면 BM25만 사용
    }
    return this;
  }

  // 토큰별 BM25 점수와 질의 커버리지를 함께 계산한다.
  bm25(query) {
    const q = [...new Set(tokens(query, { query: true }))];
    // 코퍼스에 한 번도 없는 토큰(군말·오탈자)은 영향력을 낮춰 커버리지가 과도하게 떨어지지 않게 합니다.
    const weight = (t) => (this.df.has(t) ? this.idf(t) : 0.3 * this.idf(t));
    const qWeight = q.reduce((s, t) => s + weight(t), 0) || 1;
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

  // 코퍼스에 없는 핵심 어절의 비율을 계산해 신뢰도 보정에 사용한다.
  oovRatio(query) {
    const ws = words(query).filter((w) => !FILLER.has(w));
    if (!ws.length) return 0;
    const oov = ws.filter((w) => {
      const ts = tokens(w, { query: true }).filter((t) => t[0] === 'b' || t[0] === 'c');
      return w.length >= 3 && ts.length > 0 && ts.every((t) => !this.df.has(t));
    });
    return oov.length / ws.length;
  }

  // 어휘 검색과 선택적인 벡터 유사도를 결합해 상위 문서를 선택한다.
  async search(query, k = 4) {
    const lex = this.bm25(query);
    let cos = null;
    if (this.vectors) {
      try {
        const [qv] = await this.embed([query], 5000);
        cos = this.vectors.map((v) => cosine(qv, v));
      } catch { cos = null; }
    }
    const maxBm = Math.max(...lex.map((l) => l.score), 1e-9);
    const rows = this.chunks.map((c, i) => {
      const bn = lex[i].score / maxBm;
      const sem = cos ? cos[i] : null;
      const fused = sem === null ? bn : 0.5 * bn + 0.5 * Math.max(0, (sem - 0.3) / 0.5);
      return { chunk: c, bm25: lex[i].score, coverage: lex[i].coverage, cosine: sem, fused };
    });
    rows.sort((a, b) => b.fused - a.fused);
    const top = rows.slice(0, k);
    // 신뢰도: 질의 토큰 커버리지(어휘 근거)와 임베딩 유사도(의미 근거)를 섞은 값
    const best = top[0];
    const semScore = best.cosine === null ? null : Math.min(1, Math.max(0, (best.cosine - 0.35) / 0.35));
    const base = semScore === null ? best.coverage : 0.5 * best.coverage + 0.5 * semScore;
    // 질의의 핵심 어절이 지식베이스 어디에도 없으면(예: "양자컴퓨터", "블랙홀") 범위 밖일 가능성이 높아 신뢰도를 깎습니다.
    const oov = this.oovRatio(query);
    return { hits: top, confidence: base * (1 - 0.7 * oov), oovRatio: oov };
  }
}

// 벡터 내적과 크기를 이용하여 코사인 유사도를 반환한다.
function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}
