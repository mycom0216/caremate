// ─────────────────────────────────────────────────────────────────────────────
// app.js — CareMate 웹 화면(브라우저에서 실행되는 클라이언트 코드). index.html 에서 type="module" 로 불러옵니다.
//
// [구성] 탭 4개: 고객 챗봇 / 상담원 콘솔 / 분석 대시보드 / 지식베이스. 서버와는 fetch 로 JSON API(server.mjs)만 주고받습니다.
// [화면 만드는 방법] 프레임워크 없이 h() 도우미로 DOM 요소를 직접 만들고 replaceChildren 으로 교체합니다.
//
// [XSS 방지(가장 중요한 보안 원칙)]
//   XSS(교차 사이트 스크립팅)는 고객이 입력한 <script> 같은 글이 HTML 로 해석되어 실행되는 공격입니다.
//   이 파일은 서버·고객이 준 문자열을 innerHTML 에 절대 넣지 않고, textContent 또는 createTextNode 로만 넣습니다.
//   → 브라우저가 문자열을 "코드"가 아니라 "글자"로만 다루므로 안전합니다. (style 속성에는 숫자로 계산한 폭(%)만 넣습니다.)
// ─────────────────────────────────────────────────────────────────────────────
// 화면 구성: 모든 사용자 입력·서버 문자열은 textContent로만 넣어 XSS를 막습니다.
// $: document.querySelector 의 짧은 이름(CSS 선택자로 요소 하나 찾기).
const $ = (s) => document.querySelector(s);
// h(태그, 속성, ...자식): DOM 요소 생성 도우미(안전한 "미니 템플릿").
//   · 속성 'class' → className, 'on...'(예: onclick) → 이벤트 리스너, false/null 이면 속성 생략, true 이면 빈 값 속성(예: disabled)
//   · 자식: 배열은 펼치고(flat), null/false 는 무시, DOM 노드면 그대로, 그 외(문자열·숫자)는 createTextNode 로 "글자"로 추가 → XSS 안전.
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
// 서버 API 호출 도우미. opts 가 있으면(POST 등) JSON 헤더를 붙이고 body 객체를 JSON 문자열로 바꿔 보냅니다.
//   응답이 JSON 이 아니어도 {} 로 대신해 오류를 막고, 상태가 실패(ok 아님)면 서버가 준 error 메시지(없으면 상태코드)로 예외를 던집니다.
//   호출한 쪽의 catch 가 이 메시지를 사용자에게 보여 줍니다.
const api = async (path, opts) => {
  const res = await fetch(path, opts && { ...opts, headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패(${res.status})`);
  return data;
};
// 세션 ID: 브라우저 탭마다 하나. sessionStorage 에 저장해 새로고침해도 같은 대화로 이어지게 합니다(탭을 닫으면 새 ID).
//   "web-" + 무작위 UUID 라서 서버의 형식 검사(영문·숫자·하이픈 6~64자)를 통과합니다. 저장소 접근이 막힌 환경에서는 저장 없이 새 ID 를 씁니다(catch).
const sessionId = (() => {
  try { let s = sessionStorage.getItem('cm-sid'); if (!s) { s = 'web-' + crypto.randomUUID(); sessionStorage.setItem('cm-sid', s); } return s; } catch { return 'web-' + crypto.randomUUID(); }
})();

// ── 탭 전환 ──
// ---- 탭 ----
const tabs = ['chat', 'agent', 'dash', 'kb'];
// 탭 이름(chat/agent/dash/kb)을 받아 해당 영역만 보이게 하고 나머지는 숨깁니다. 버튼의 aria-selected 도 갱신(접근성).
//   상담원·대시보드·지식 탭은 열 때마다 최신 데이터를 서버에서 불러옵니다.
function show(name) {
  for (const t of tabs) $('#tab-' + t).hidden = t !== name;
  document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  if (name === 'agent') loadTickets(); if (name === 'dash') loadDash(); if (name === 'kb') loadKb();
}
// 이벤트 위임: 탭 줄에 클릭 리스너 하나만 달고, 눌린 요소에서 가장 가까운 data-tab 버튼을 찾아 처리합니다.
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) show(b.dataset.tab); });

// ---- 상태 ----
// 시작할 때 서버 상태를 가져와 상단 줄에 지식 개수·검색 방식·LLM 정보를 표시합니다. 실패하면 연결 불가 문구. (textContent 사용)
api('/api/status').then((s) => { $('#status').textContent = `지식 ${s.knowledgeChunks}개 · 검색 ${s.retrieval} · LLM ${s.llm}`; }).catch(() => { $('#status').textContent = '서버에 연결할 수 없습니다'; });

// ---- 챗봇 ----
// 예시 질문 버튼(시연용). 눌리면 ask() 로 바로 질문합니다. 마지막 두 개는 범위 밖 질문·상담원 연결 요청 시연용입니다.
const SAMPLES = ['반품 배송비는 누가 내나요?', '포인트 유효기간이 얼마예요?', 'MM-1001 배송 어디쯤이에요?', '무통장입금 기한이 지나면요?', '결제 오류로 중복 결제됐어요 도대체 몇 번째예요!!', '오늘 서울 날씨 어때?', '상담원 연결해 주세요'];
for (const s of SAMPLES) $('#chips').append(h('button', { type: 'button', onclick: () => ask(s) }, s));
// log: 대화 영역. addMsg(종류, 글): 말풍선을 추가하고 맨 아래로 스크롤, 만든 요소를 돌려줍니다(나중에 내용을 바꾸기 위함). 글은 textContent 계열로 넣음.
const log = $('#log');
const addMsg = (cls, text) => { const m = h('div', { class: 'msg ' + cls }, text); log.append(m); log.scrollTop = log.scrollHeight; return m; };
addMsg('bot', '안녕하세요! 모아마켓 상담 챗봇입니다. 배송, 교환·반품, 결제, 쿠폰·포인트, 주문 조회(MM-1001 형식)까지 물어보세요.');

// 폼 제출: 페이지 새로고침(기본 동작)을 막고, 입력값이 비어 있지 않을 때만 질문합니다.
$('#form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#q').value.trim(); if (v) ask(v); });

// 질문 한 건 보내기. ① 입력칸을 비우고 내 말풍선 표시 ② "찾는 중" 말풍선 표시 + 보내기 버튼 잠금(연타 방지)
//   ③ 서버 응답으로 그 말풍선을 답변으로 교체, 근거·평가 줄 추가, 오른쪽 분석 패널 갱신 ④ 실패하면 오류 문구 ⑤ finally 에서 항상 버튼 복구.
//   상담원 연결(escalated)이면 탭의 티켓 배지를 새로 고칩니다.
async function ask(text) {
  $('#q').value = '';
  addMsg('me', text);
  const wait = addMsg('bot', '답변을 찾는 중…');
  $('#send').disabled = true;
  try {
    const r = await api('/api/chat', { method: 'POST', body: { sessionId, question: text } });
    wait.textContent = r.answer;
    wait.append(metaRow(r));
    // 말풍선을 클릭하면 그 답변의 분석·근거를 다시 오른쪽 패널에 보여 줍니다.
    wait.addEventListener('click', () => renderAnalysis(r, wait));
    renderAnalysis(r, wait);
    if (r.escalated) refreshBadge();
  } catch (err) {
    wait.textContent = '오류: ' + err.message;
  } finally { $('#send').disabled = false; $('#q').focus(); log.scrollTop = log.scrollHeight; }
}

// 답변 아래 줄: 근거 문서 ID 태그, 상담원 연결 태그, 👍/👎 평가 버튼.
//   평가 버튼을 누르면 서버에 저장하고 눌린 버튼만 강조합니다(e.stopPropagation 은 말풍선 클릭 이벤트가 같이 실행되지 않게 막음).
function metaRow(r) {
  const fb = h('span', { class: 'fb' });
  const mk = (val, label) => h('button', { type: 'button', title: val ? '도움이 됐어요' : '도움이 안 됐어요', onclick: async (e) => {
    e.stopPropagation();
    try { await api(`/api/inquiries/${r.id}/feedback`, { method: 'POST', body: { helpful: val } }); fb.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } catch (er) { alert(er.message); }
  } }, label);
  fb.append(mk(true, '👍'), mk(false, '👎'));
  return h('div', { class: 'meta' },
    r.sources.length ? h('span', { class: 'tag' }, '근거 ' + r.sources.map((s) => s.id).join(', ')) : null,
    r.escalated ? h('span', { class: 'tag warn' }, `상담원 연결 #${r.ticketId}`) : null,
    fb);
}

// 우선순위 → [화면 글자, 색 클래스]. 서버 값(high/medium/low)을 한글과 색 의미(bad/warn/ok)로 바꿉니다.
const priLabel = { high: ['높음', 'bad'], medium: ['보통', 'warn'], low: ['낮음', 'ok'] };
// 오른쪽 분석 패널: 개인정보 감지 안내, 문의 유형(확률), 감정, 우선순위+근거 단어, 검색 신뢰도 막대, 답변 방식, 응답 시간,
//   상담원 티켓 생성 사유, 답변 근거 문서 목록. 모든 값은 h() 로 만든 "글자" 노드입니다.
function renderAnalysis(r, bubble) {
  log.querySelectorAll('.msg.active').forEach((m) => m.classList.remove('active')); bubble.classList.add('active');
  const a = r.analysis, [pl, pc] = priLabel[a.priority];
  // replaceChildren 으로 패널 내용을 한 번에 교체합니다. null 항목은 h() 대신 .filter(Boolean) 으로 걸러 냅니다.
  const box = $('#analysis'); box.className = ''; box.replaceChildren(...[
    r.piiMasked.length ? h('div', { class: 'notice' }, `개인정보(${r.piiMasked.join(', ')})를 감지해 가려서 저장했습니다.`) : null,
    h('dl', { class: 'kv' },
      h('dt', {}, '문의 유형'), h('dd', {}, `${a.category} (${Math.round(a.categoryProb * 100)}%)`),
      h('dt', {}, '감정'), h('dd', {}, `${a.sentimentLabel} (${a.sentiment})`),
      h('dt', {}, '우선순위'), h('dd', {}, h('span', { class: 'tag ' + pc }, pl), a.reasons.length ? ' ' + a.reasons.join(', ') : ''),
      // 신뢰도(0~1)를 퍼센트 폭으로 바꾼 막대. 폭은 숫자 계산 결과만 style 에 들어갑니다.
      h('dt', {}, '검색 신뢰도'), h('dd', {}, String(r.confidence), h('div', { class: 'meter' }, h('i', { style: `width:${Math.round(r.confidence * 100)}%` }))),
      h('dt', {}, '답변 방식'), h('dd', {}, r.generator),
      h('dt', {}, '응답 시간'), h('dd', {}, (r.latencyMs / 1000).toFixed(1) + '초')),
    r.escalated ? h('div', { class: 'notice' }, `상담원 티켓 #${r.ticketId} 생성 (사유: ${({ low_confidence: '근거 부족', user_request: '고객 요청', priority: '긴급·사고성 문의' })[r.escalateReason] ?? r.escalateReason})`) : null,
    h('b', {}, '답변 근거'),
    r.sources.length ? r.sources.map((s) => h('div', { class: 'src' }, h('b', {}, `${s.id} · ${s.title}`), h('span', {}, s.text))) : h('div', { class: 'empty' }, '근거 문서 없음')].flat().filter(Boolean));
}

// ---- 상담원 콘솔 ----
// 티켓 배지: 미처리(open) 티켓 개수를 상담원 탭 옆에 표시(0 이면 숨김). 실패하면 빈 배열을 돌려주고 조용히 넘어갑니다.
async function refreshBadge() {
  try { const t = await api('/api/tickets?status=open'); const b = $('#ticketBadge'); b.hidden = t.length === 0; b.textContent = t.length; return t; } catch { return []; }
}
// selected: 지금 선택한 티켓 번호(없으면 null). 목록을 다시 그려도 선택 표시를 유지하기 위함입니다.
let selected = null;
// 티켓 목록 불러와 그리기. 서버가 이미 우선순위순으로 정렬해 주므로 그대로 보여 줍니다. 처리완료 티켓은 흐리게(done 클래스).
//   목록의 한 줄에는 문의 앞 40글자만 미리보기로 보입니다.
async function loadTickets() {
  const all = await api('/api/tickets');
  await refreshBadge();
  const ul = $('#tickets'); ul.replaceChildren();
  if (!all.length) ul.append(h('li', { class: 'empty' }, '접수된 티켓이 없습니다.'));
  for (const t of all) {
    const [pl, pc] = priLabel[t.priority];
    ul.append(h('li', { class: (t.status === 'resolved' ? 'done ' : '') + (selected === t.id ? 'sel' : ''), onclick: () => { selected = t.id; renderTicket(t); loadTickets(); } },
      h('span', { class: 'tag ' + pc }, pl), ' ', h('span', { class: 'tag' }, t.category), ' ', t.status === 'resolved' ? h('span', { class: 'tag ok' }, '처리완료') : null,
      h('small', {}, `#${t.id} · ${t.question.slice(0, 40)}`)));
  }
  const cur = all.find((t) => t.id === selected); if (cur) renderTicket(cur);
}
// 티켓 상세 + 답변 작성 영역. 처리완료 티켓은 입력·버튼을 잠급니다.
//   · "AI 답변 초안": 서버에서 근거가 달린 초안을 받아 입력칸에 채웁니다(자동 발송 아님, 상담원이 검토·수정).
//   · "답변 등록": 입력칸 내용을 서버에 보냅니다. 서버가 길이(5~2000자)와 중복 처리(409)를 검사하고, 오류는 아래 안내 줄에 표시.
function renderTicket(t) {
  const area = h('textarea', { placeholder: '답변을 작성하거나 AI 초안을 불러오세요', disabled: t.status === 'resolved' }, t.reply ?? '');
  const info = h('div', { class: 'empty' });
  const draftBtn = h('button', { class: 'ghost', type: 'button', disabled: t.status === 'resolved', onclick: async () => {
    draftBtn.disabled = true; info.textContent = '초안 생성 중…';
    try { const d = await api(`/api/tickets/${t.id}/draft`); area.value = d.draft; info.textContent = `근거: ${d.sources.map((s) => s.id).join(', ') || '없음'} · 방식 ${d.generator} · 초안은 상담원이 검토 후 발송하세요.`; } catch (e) { info.textContent = e.message; } finally { draftBtn.disabled = false; }
  } }, 'AI 답변 초안');
  const send = h('button', { class: 'primary', type: 'button', disabled: t.status === 'resolved', onclick: async () => {
    try { await api(`/api/tickets/${t.id}/reply`, { method: 'POST', body: { reply: area.value } }); await loadTickets(); } catch (e) { info.textContent = e.message; }
  } }, '답변 등록');
  $('#ticketDetail').replaceChildren(h('div', { class: 'detail' },
    h('h2', {}, `티켓 #${t.id}`, h('span', { class: 'tag' }, ({ low_confidence: '근거 부족', user_request: '고객 요청', priority: '긴급·사고성' })[t.reason] ?? t.reason)),
    h('b', {}, '고객 문의'), h('div', { class: 'quote' }, t.question),
    t.bot_answer ? [h('b', {}, '챗봇 응답'), h('div', { class: 'quote' }, t.bot_answer)] : null,
    h('b', {}, '상담원 답변'), area, h('div', {}, draftBtn, ' ', send), info));
}
$('#reloadTickets').addEventListener('click', loadTickets);

// ---- 대시보드 ----
// 가로 막대 그래프 카드. rows: [{label, count}], fmt: 라벨 표시 변환 함수. 가장 큰 값을 100% 로 하여 막대 폭을 계산(최소 분모 1 → 0 나눗셈 방지).
function bars(title, rows, fmt = (x) => x) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return h('div', { class: 'card' }, h('h2', {}, title), rows.length ? rows.map((r) => h('div', { class: 'bar' }, h('span', { title: fmt(r.label) }, fmt(r.label)), h('div', {}, h('i', { style: `width:${(r.count / max) * 100}%` })), h('span', {}, r.count))) : h('div', { class: 'empty' }, '데이터 없음'));
}
// 대시보드: /api/stats 로 통계를 받아 KPI 6개(총 문의, 자동 해결률, 평균 응답 시간, 미처리 티켓, 고객 만족, 평균 검색 신뢰도)와 막대 차트 5개를 그립니다.
//   고객 만족 = 도움이 됐어요 / (도움 + 도움 안 됨). 평가가 없으면 '-' 로 표시합니다.
async function loadDash() {
  const s = await api('/api/stats');
  const rated = s.helpful + s.unhelpful;
  const kpi = (v, l) => h('div', { class: 'kpi' }, h('b', {}, v), h('span', {}, l));
  $('#kpis').replaceChildren(kpi(s.total, '총 문의'), kpi(Math.round(s.autoResolvedRate * 100) + '%', '챗봇 자동 해결률'), kpi((s.avgLatencyMs / 1000).toFixed(1) + '초', '평균 응답 시간'), kpi(s.openTickets, '미처리 티켓'), kpi(rated ? Math.round((s.helpful / rated) * 100) + '%' : '-', `고객 만족(평가 ${rated}건)`), kpi(s.avgConfidence, '평균 검색 신뢰도'));
  const pri = { high: '높음', medium: '보통', low: '낮음' };
  $('#charts').replaceChildren(bars('문의 유형별', s.byCategory), bars('우선순위별', s.byPriority, (x) => pri[x] ?? x), bars('답변 방식별', s.byGenerator), bars('일자별 문의(최근 7일)', s.byDay), bars('자주 인용된 지식(= 많이 궁금해하는 주제)', s.topSources.map((t) => ({ label: `${t.id} ${t.title}`, count: t.count }))));
}

// ---- 지식베이스 ----
// kbAll: 지식베이스 전체 캐시(처음 한 번만 불러옴: ??= 는 비어 있을 때만 대입).
let kbAll = null;
// 지식 탭을 열 때 전체 조각을 불러와 표시합니다.
async function loadKb() {
  kbAll ??= await api('/api/kb'); $('#kbCount').textContent = `${kbAll.length}개 문서 조각`;
  renderKb(kbAll.map((c) => ({ ...c })));
}
// 지식 조각 목록 그리기(검색 결과면 점수 태그 포함). 본문은 textContent 계열로 넣습니다.
const renderKb = (items) => $('#kbList').replaceChildren(...items.map((c) => h('div', { class: 'kb-item' }, h('b', {}, h('code', {}, c.id), c.title, c.score != null ? h('span', { class: 'tag' }, ' 점수 ' + c.score.toFixed(2)) : null), h('div', {}, c.text ?? ''))));
// 검색 입력 디바운스용 타이머. 글자를 칠 때마다 서버를 부르지 않도록, 입력이 250ms 멈췄을 때만 검색합니다.
let timer;
// 검색어가 비면 전체 목록, 있으면 /api/kb/search 로 RAG 검색기의 상위 결과(순서·점수)를 보여 줍니다. 검색어는 encodeURIComponent 로 URL 에 안전하게 넣습니다.
$('#kbSearch').addEventListener('input', (e) => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const q = e.target.value.trim(); if (!q) return renderKb(kbAll);
    const r = await api('/api/kb/search?q=' + encodeURIComponent(q));
    renderKb(r.hits.map((x) => ({ ...kbAll.find((c) => c.id === x.id), score: x.score })));
  }, 250);
});
// 처음 화면을 열 때 미처리 티켓 배지를 한 번 갱신합니다.
refreshBadge();
