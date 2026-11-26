// ─────────────────────────────────────────────────────────────────────────────
// server.mjs — CareMate 웹 서버 (REST API + 정적 파일 서빙)
//
// [역할]  브라우저(고객 챗봇·상담원 콘솔·대시보드·지식베이스 화면)와 src/ 의 서비스 계층을 이어 주는 얇은 HTTP 계층입니다.
//         외부 패키지 없이 Node 내장 모듈(node:http, node:fs, node:path)만 사용합니다.
//         비즈니스 로직(검색·답변·분류·DB)은 여기에 두지 않고 src/chat.mjs, src/db.mjs 등에 있습니다.
//
// [구성]  1) 환경변수로 설정을 읽고 서비스를 조립(createServices)
//         2) /api/ 로 시작하는 요청 → api() 함수가 메서드+경로로 분기해 JSON 응답
//         3) 그 외 요청 → public/ 폴더의 정적 파일(html/js/css)을 돌려줌
//         4) 모든 오류는 마지막 catch 한 곳에서 HTTP 상태코드로 변환
//
// [API 목록]
//         GET  /api/status                      시스템 상태(지식 개수, 검색 방식, LLM 사용 여부)
//         POST /api/chat                        고객 질문 처리 (본문: {sessionId, question})
//         GET  /api/inquiries?limit=N           최근 문의 목록
//         GET  /api/stats                       대시보드 통계
//         GET  /api/tickets[?status=open]       상담원 티켓 목록(우선순위순)
//         GET  /api/kb , /api/kb/search?q=      지식베이스 전체 / 검색 결과(점수 확인용)
//         POST /api/inquiries/:id/feedback      고객 만족 평가(true/false)
//         GET  /api/tickets/:id/draft           상담원용 AI 답변 초안
//         POST /api/tickets/:id/reply           상담원 답변 등록
//
// [보안·안정성 장치 — 아래 각 위치에 이유를 적었습니다]
//         · 기본 HOST 가 127.0.0.1 → 같은 PC에서만 접속 가능(외부 노출 방지)
//         · 요청 본문 20,000바이트 제한(413), JSON 오류는 400
//         · sessionId 형식 검사 + 세션별 호출 간격 제한(429)
//         · 정적 파일 경로 조작(../) 차단(403)
//         · 내부 오류(500)의 상세 메시지는 사용자에게 숨김
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { ROOT, createServices } from './src/app.mjs';
import { HttpError } from './src/chat.mjs';

// ── 설정 ──────────────────────────────────────────────
// PORT/HOST 는 환경변수로 바꿀 수 있습니다. HOST 기본값 127.0.0.1 은 "이 컴퓨터 안에서만 접속"이라는 뜻입니다.
// (인증 기능이 없는 데모이므로 외부에 열지 않는 것이 안전합니다.)
const PORT = Number(process.env.PORT ?? 5200);
const HOST = process.env.HOST ?? '127.0.0.1';
// DB 파일을 둘 data/ 폴더가 없으면 만듭니다(recursive: 이미 있어도 오류 없음). ROOT 는 프로젝트 폴더 경로입니다(src/app.mjs).
mkdirSync(`${ROOT}data`, { recursive: true });

// 서비스 묶음 조립: 지식베이스 로딩 → 검색기 → 분류기 → LLM 확인 → DB → ChatService (자세한 순서는 src/app.mjs).
//   LLM=off 이면 LLM 없이 추출형 답변, EMBEDDINGS=on 이면 임베딩 검색을 섞습니다.
//   서버가 시작되기 전에 await 로 준비를 끝내므로, 첫 요청이 준비 중인 서비스를 만나는 일이 없습니다.
const svc = await createServices({
  dbFile: process.env.DB_FILE ?? `${ROOT}data/caremate.db`,
  llmEnabled: process.env.LLM !== 'off',
  embeddings: process.env.EMBEDDINGS === 'on',
  llmModel: process.env.LLM_MODEL ?? 'kanana2:3b',
});

// 확장자 → Content-Type 표. 목록에 없는 확장자는 아래에서 application/octet-stream(내려받기용)으로 보냅니다.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
// JSON 응답 도우미. cache-control: no-store 는 상담 티켓·통계가 브라우저에 캐시되어 오래된 값이 보이는 일을 막습니다.
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
// 요청 본문(JSON)을 읽어 객체로 돌려줍니다. 본문이 없으면 빈 객체 {}.
//   크기 제한(20,000바이트)을 넘거나 JSON 형식이 틀리면 HttpError(413/400)로 거절합니다.
//   → 비정상적으로 큰 본문으로 메모리를 소모시키는 공격을 막는 장치입니다.
const readBody = (req) => new Promise((resolve, reject) => {
  // size: 지금까지 받은 바이트 수, tooBig: 한도 초과 여부, parts: 받은 조각들(Buffer)
  let size = 0, tooBig = false; const parts = [];
  // 한도를 넘으면 본문은 버리고(저장 안 함) 끝까지 읽은 뒤 413으로 응답합니다. destroy하면 응답 없이 연결이 끊깁니다.
  // data 이벤트는 조각 단위로 여러 번 옵니다. 한도를 넘은 뒤에는 조각을 저장하지 않아 메모리를 더 쓰지 않습니다.
  req.on('data', (c) => { size += c.length; if (size > 20000) tooBig = true; else if (!tooBig) parts.push(c); });
  // end 이벤트: 다 받은 뒤 ① 한도 초과면 413 ② 조각을 합쳐 UTF-8 문자열로 바꾸고 JSON.parse, 실패하면 400 ③ 본문이 없으면 {}
  req.on('end', () => { if (tooBig) return reject(new HttpError(413, '요청이 너무 큽니다.')); try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'JSON 형식이 올바르지 않습니다.')); } });
});

// 연속 호출 방지용 기록: sessionId → 마지막 질문 시각(ms). 서버 메모리에만 있어 재시작하면 사라집니다.
//   (아래 실제 간격은 800ms 입니다. LLM 호출은 느리고 비싸므로 한 세션이 연타하지 못하게 합니다.)
// 연속 호출 방지: 세션당 1초에 1회 질문
const lastAsk = new Map();

// API 라우터: 메서드(m)와 경로(p)를 보고 해당 서비스 함수를 호출합니다.
//   여기서 던진 HttpError 는 바깥(createServer 콜백)의 catch 가 받아 상태코드로 바꿉니다.
//   어느 분기에도 안 맞으면 마지막 줄에서 404 를 던집니다.
async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  // 상태 확인: 화면 상단 상태 줄에 쓰입니다. classifierLabels 는 학습된 문의 유형 이름들입니다.
  if (m === 'GET' && p === '/api/status') {
    return json(res, 200, {
      knowledgeChunks: svc.chunks.length, retrieval: svc.retriever.mode,
      llm: svc.llm.available ? svc.llm.model : '사용 안 함(추출형 답변)',
      classifierLabels: [...svc.classifier.labels.keys()],
    });
  }
  // 고객 질문 처리 — 이 서버에서 가장 중요한 경로입니다.
  if (m === 'POST' && p === '/api/chat') {
    const b = await readBody(req);
    // ① 세션 ID 검증: 문자열로 바꾸고 64자까지만 취급합니다(비정상적으로 긴 값 방지).
    const sid = String(b.sessionId ?? '').slice(0, 64);
    // ② 형식 검사: 영문·숫자·밑줄·하이픈 6~64자만 허용. 한글·공백·특수문자가 섞인 임의 값을 DB에 저장하지 않기 위함입니다.
    //    (브라우저는 web- 뒤에 UUID 를 붙여 보냅니다. public/app.js 참고)
    if (!/^[\w-]{6,64}$/u.test(sid)) throw new HttpError(400, 'sessionId가 필요합니다.');
    // ③ 속도 제한: 같은 세션이 800ms 안에 다시 질문하면 429(Too Many Requests).
    const now = Date.now();
    if (now - (lastAsk.get(sid) ?? 0) < 800) throw new HttpError(429, '잠시 후 다시 질문해 주세요.');
    lastAsk.set(sid, now);
    // ④ 기록이 5,000개를 넘으면 통째로 비웁니다(메모리가 끝없이 커지는 것을 막는 간단한 방법).
    if (lastAsk.size > 5000) lastAsk.clear();
    // ⑤ 실제 처리는 ChatService.ask 가 합니다(마스킹→분석→검색→답변→저장). 결과를 그대로 JSON 으로 돌려줍니다.
    return json(res, 200, await svc.chat.ask(sid, b.question));
  }
  // 조회용 GET 들. limit 은 숫자로 바꿔 DB 에 파라미터로 전달됩니다(문자열을 SQL 에 이어 붙이지 않음 → SQL 인젝션 방지).
  //   tickets 의 status 는 있으면 해당 상태만, 빈 값이면 전체(undefined)를 뜻합니다.
  if (m === 'GET' && p === '/api/inquiries') return json(res, 200, svc.store.recentInquiries(Number(url.searchParams.get('limit') ?? 50)));
  if (m === 'GET' && p === '/api/stats') return json(res, 200, svc.store.stats());
  if (m === 'GET' && p === '/api/tickets') return json(res, 200, svc.store.tickets(url.searchParams.get('status') || undefined));
  if (m === 'GET' && p === '/api/kb') return json(res, 200, svc.chunks);
  // 지식베이스 검색 확인용: 질의를 200자로 자르고 검색기(retriever)로 상위 5개를 찾아 점수(fused)와 커버리지를 돌려줍니다.
  //   화면의 "지식베이스" 탭이 RAG 검색기가 찾은 순서를 보여 주는 데 씁니다.
  if (m === 'GET' && p === '/api/kb/search') {
    const q = String(url.searchParams.get('q') ?? '').slice(0, 200);
    const { hits, confidence } = await svc.retriever.search(q, 5);
    return json(res, 200, { confidence, hits: hits.map((h) => ({ id: h.chunk.id, title: h.chunk.title, score: h.fused, coverage: h.coverage })) });
  }
  // 경로에 번호(:id)가 들어가는 API 는 정규식으로 매칭하고, 숫자(\d+)만 허용합니다. 캡처된 번호는 mm[1] 입니다.
  let mm;
  if (m === 'POST' && (mm = /^\/api\/inquiries\/(\d+)\/feedback$/u.exec(p))) {
    // 피드백: helpful 은 반드시 true/false(boolean)여야 합니다(문자열 'yes' 등은 400). 없는 문의 번호면 404.
    const b = await readBody(req);
    if (typeof b.helpful !== 'boolean') throw new HttpError(400, 'helpful(true/false)이 필요합니다.');
    if (!svc.store.setFeedback(Number(mm[1]), b.helpful)) throw new HttpError(404, '문의를 찾을 수 없습니다.');
    return json(res, 200, { ok: true });
  }
  // 상담원 답변 초안 생성(ChatService.draft). 초안은 자동 발송되지 않고 화면의 입력칸에 채워질 뿐입니다.
  if (m === 'GET' && (mm = /^\/api\/tickets\/(\d+)\/draft$/u.exec(p))) return json(res, 200, await svc.chat.draft(Number(mm[1])));
  if (m === 'POST' && (mm = /^\/api\/tickets\/(\d+)\/reply$/u.exec(p))) {
    const b = await readBody(req);
    // 답변 등록: 앞뒤 공백을 제거한 뒤 5~2000자만 허용합니다(너무 짧은 빈 답변/지나치게 긴 입력 방지).
    const reply = String(b.reply ?? '').trim();
    if (reply.length < 5 || reply.length > 2000) throw new HttpError(400, '답변은 5~2000자로 입력해 주세요.');
    // replyTicket 은 "아직 open 인 티켓"만 갱신합니다. 이미 처리된 티켓에 다시 답하면 409(Conflict) → 중복 답변 방지.
    if (!svc.store.replyTicket(Number(mm[1]), reply)) throw new HttpError(409, '이미 처리되었거나 없는 티켓입니다.');
    return json(res, 200, { ok: true });
  }
  throw new HttpError(404, '없는 API입니다.');
}

// HTTP 서버 본체: 요청마다 이 콜백이 실행됩니다. async 안의 모든 예외는 아래 catch 로 모입니다.
const server = createServer(async (req, res) => {
  try {
    // req.url 은 "/경로?쿼리" 형태이므로 기준 주소(http://localhost)를 붙여 URL 객체로 해석합니다(이 주소는 실제 접속과 무관한 해석용).
    const url = new URL(req.url, 'http://localhost');
    // /api/ 로 시작하면 API, 아니면 정적 파일입니다.
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    // 정적 파일 경로 정리: '/' 는 /index.html 로 바꾸고, normalize 로 a/./b, a//b 같은 표기를 정리한 뒤 맨 앞의 슬래시를 제거해 상대 경로로 만듭니다.
    //    (url.pathname 은 %2e%2e 같은 퍼센트 인코딩을 풀지 않으므로, 이 서버에서는 그대로 존재하지 않는 파일 이름으로 취급되어 404 가 됩니다.)
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^([/\\])+/u, '');
    // 경로 조작(Path Traversal) 차단: '..' 이 남아 있으면 public/ 밖의 파일(예: server.mjs, DB 파일)을 읽으려는 시도로 보고 403.
    if (rel.includes('..')) throw new HttpError(403, '접근할 수 없습니다.');
    // public/ 폴더 안에서만 파일을 읽습니다. 읽기 실패(없는 파일, 폴더 등)는 모두 404 로 통일합니다.
    try {
      const file = readFileSync(join(ROOT, 'public', rel));
      res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' });
      res.end(file);
    } catch { throw new HttpError(404, '찾을 수 없습니다.'); }
  } catch (e) {
    // 통합 오류 처리: HttpError 는 자기 status 를 쓰고, 그 밖의 예상 못 한 오류는 500 입니다.
    //    500 은 서버 콘솔에만 자세히 기록하고, 사용자에게는 일반 문구만 보냅니다(내부 구조·경로 정보 노출 방지).
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    // API 요청의 오류는 JSON {error: 메시지} 로, 정적 파일 오류는 일반 텍스트로 응답합니다. 화면(app.js)은 error 값을 사용자에게 보여 줍니다.
    if (req.url.startsWith('/api/')) json(res, status, { error: status === 500 ? '서버 오류가 발생했습니다.' : e.message });
    else { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(e.message); }
  }
});

// 지정한 HOST:PORT 에서 요청을 기다리기 시작합니다. 시작 시 현재 검색 방식·지식 개수·LLM 상태를 콘솔에 출력합니다.
server.listen(PORT, HOST, () => {
  console.log(`CareMate 실행 중: http://${HOST}:${PORT}`);
  console.log(`검색: ${svc.retriever.mode} · 지식 ${svc.chunks.length}개 · LLM: ${svc.llm.available ? svc.llm.model : '없음(추출형 답변)'}`);
});
