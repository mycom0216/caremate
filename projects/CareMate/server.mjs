import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { ROOT, createServices } from './src/app.mjs';
import { HttpError } from './src/chat.mjs';

// 환경변수로 접속 주소를 설정하고 기본값은 로컬 데모 환경에 맞춘다.
const PORT = Number(process.env.PORT ?? 5200);
const HOST = process.env.HOST ?? '127.0.0.1';
mkdirSync(`${ROOT}data`, { recursive: true });

// HTTP 서버가 열리기 전에 검색기, 분류기, 저장소 및 LLM을 초기화한다.
const svc = await createServices({
  dbFile: process.env.DB_FILE ?? `${ROOT}data/caremate.db`,
  llmEnabled: process.env.LLM !== 'off',
  embeddings: process.env.EMBEDDINGS === 'on',
  llmModel: process.env.LLM_MODEL ?? 'kanana2:3b',
});

// 정적 파일의 확장자를 HTTP Content-Type으로 매핑한다.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
// 본문 크기 제한 및 JSON 파싱 실패를 HTTP 오류로 변환한다.
const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0, tooBig = false; const parts = [];
  // 한도를 넘으면 본문은 버리고(저장 안 함) 끝까지 읽은 뒤 413으로 응답합니다. destroy하면 응답 없이 연결이 끊깁니다.
  req.on('data', (c) => { size += c.length; if (size > 20000) tooBig = true; else if (!tooBig) parts.push(c); });
  req.on('end', () => { if (tooBig) return reject(new HttpError(413, '요청이 너무 큽니다.')); try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'JSON 형식이 올바르지 않습니다.')); } });
});

// 연속 호출 방지: 세션당 1초에 1회 질문
const lastAsk = new Map();

// 요청 메서드와 경로를 기준으로 서비스 기능에 연결한다.
async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  if (m === 'GET' && p === '/api/status') {
    return json(res, 200, {
      knowledgeChunks: svc.chunks.length, retrieval: svc.retriever.mode,
      llm: svc.llm.available ? svc.llm.model : '사용 안 함(추출형 답변)',
      classifierLabels: [...svc.classifier.labels.keys()],
    });
  }
  if (m === 'POST' && p === '/api/chat') {
    const b = await readBody(req);
    const sid = String(b.sessionId ?? '').slice(0, 64);
    if (!/^[\w-]{6,64}$/u.test(sid)) throw new HttpError(400, 'sessionId가 필요합니다.');
    const now = Date.now();
    if (now - (lastAsk.get(sid) ?? 0) < 800) throw new HttpError(429, '잠시 후 다시 질문해 주세요.');
    lastAsk.set(sid, now);
    if (lastAsk.size > 5000) lastAsk.clear();
    return json(res, 200, await svc.chat.ask(sid, b.question));
  }
  if (m === 'GET' && p === '/api/inquiries') return json(res, 200, svc.store.recentInquiries(Number(url.searchParams.get('limit') ?? 50)));
  if (m === 'GET' && p === '/api/stats') return json(res, 200, svc.store.stats());
  if (m === 'GET' && p === '/api/tickets') return json(res, 200, svc.store.tickets(url.searchParams.get('status') || undefined));
  if (m === 'GET' && p === '/api/kb') return json(res, 200, svc.chunks);
  if (m === 'GET' && p === '/api/kb/search') {
    const q = String(url.searchParams.get('q') ?? '').slice(0, 200);
    const { hits, confidence } = await svc.retriever.search(q, 5);
    return json(res, 200, { confidence, hits: hits.map((h) => ({ id: h.chunk.id, title: h.chunk.title, score: h.fused, coverage: h.coverage })) });
  }
  let mm;
  if (m === 'POST' && (mm = /^\/api\/inquiries\/(\d+)\/feedback$/u.exec(p))) {
    const b = await readBody(req);
    if (typeof b.helpful !== 'boolean') throw new HttpError(400, 'helpful(true/false)이 필요합니다.');
    if (!svc.store.setFeedback(Number(mm[1]), b.helpful)) throw new HttpError(404, '문의를 찾을 수 없습니다.');
    return json(res, 200, { ok: true });
  }
  if (m === 'GET' && (mm = /^\/api\/tickets\/(\d+)\/draft$/u.exec(p))) return json(res, 200, await svc.chat.draft(Number(mm[1])));
  if (m === 'POST' && (mm = /^\/api\/tickets\/(\d+)\/reply$/u.exec(p))) {
    const b = await readBody(req);
    const reply = String(b.reply ?? '').trim();
    if (reply.length < 5 || reply.length > 2000) throw new HttpError(400, '답변은 5~2000자로 입력해 주세요.');
    if (!svc.store.replyTicket(Number(mm[1]), reply)) throw new HttpError(409, '이미 처리되었거나 없는 티켓입니다.');
    return json(res, 200, { ok: true });
  }
  throw new HttpError(404, '없는 API입니다.');
}

// API와 정적 파일 요청을 분리하고 예외를 HTTP 응답으로 변환한다.
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^([/\\])+/u, '');
    if (rel.includes('..')) throw new HttpError(403, '접근할 수 없습니다.');
    try {
      const file = readFileSync(join(ROOT, 'public', rel));
      res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' });
      res.end(file);
    } catch { throw new HttpError(404, '찾을 수 없습니다.'); }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (req.url.startsWith('/api/')) json(res, status, { error: status === 500 ? '서버 오류가 발생했습니다.' : e.message });
    else { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(e.message); }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`CareMate 실행 중: http://${HOST}:${PORT}`);
  console.log(`검색: ${svc.retriever.mode} · 지식 ${svc.chunks.length}개 · LLM: ${svc.llm.available ? svc.llm.model : '없음(추출형 답변)'}`);
});
