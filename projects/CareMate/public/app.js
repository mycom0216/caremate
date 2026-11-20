// 화면 구성: 모든 사용자 입력·서버 문자열은 textContent로만 넣어 XSS를 막습니다.
const $ = (s) => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const api = async (path, opts) => {
  const res = await fetch(path, opts && { ...opts, headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패(${res.status})`);
  return data;
};
const sessionId = (() => {
  try { let s = sessionStorage.getItem('cm-sid'); if (!s) { s = 'web-' + crypto.randomUUID(); sessionStorage.setItem('cm-sid', s); } return s; } catch { return 'web-' + crypto.randomUUID(); }
})();

// ---- 탭 ----
const tabs = ['chat', 'agent', 'dash', 'kb'];
function show(name) {
  for (const t of tabs) $('#tab-' + t).hidden = t !== name;
  document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  if (name === 'agent') loadTickets(); if (name === 'dash') loadDash(); if (name === 'kb') loadKb();
}
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) show(b.dataset.tab); });

// ---- 상태 ----
api('/api/status').then((s) => { $('#status').textContent = `지식 ${s.knowledgeChunks}개 · 검색 ${s.retrieval} · LLM ${s.llm}`; }).catch(() => { $('#status').textContent = '서버에 연결할 수 없습니다'; });

// ---- 챗봇 ----
const SAMPLES = ['반품 배송비는 누가 내나요?', '포인트 유효기간이 얼마예요?', 'MM-1001 배송 어디쯤이에요?', '무통장입금 기한이 지나면요?', '결제 오류로 중복 결제됐어요 도대체 몇 번째예요!!', '오늘 서울 날씨 어때?', '상담원 연결해 주세요'];
for (const s of SAMPLES) $('#chips').append(h('button', { type: 'button', onclick: () => ask(s) }, s));
const log = $('#log');
const addMsg = (cls, text) => { const m = h('div', { class: 'msg ' + cls }, text); log.append(m); log.scrollTop = log.scrollHeight; return m; };
addMsg('bot', '안녕하세요! 모아마켓 상담 챗봇입니다. 배송, 교환·반품, 결제, 쿠폰·포인트, 주문 조회(MM-1001 형식)까지 물어보세요.');

$('#form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#q').value.trim(); if (v) ask(v); });

async function ask(text) {
  $('#q').value = '';
  addMsg('me', text);
  const wait = addMsg('bot', '답변을 찾는 중…');
  $('#send').disabled = true;
  try {
    const r = await api('/api/chat', { method: 'POST', body: { sessionId, question: text } });
    wait.textContent = r.answer;
    wait.append(metaRow(r));
    wait.addEventListener('click', () => renderAnalysis(r, wait));
    renderAnalysis(r, wait);
    if (r.escalated) refreshBadge();
  } catch (err) {
    wait.textContent = '오류: ' + err.message;
  } finally { $('#send').disabled = false; $('#q').focus(); log.scrollTop = log.scrollHeight; }
}

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

const priLabel = { high: ['높음', 'bad'], medium: ['보통', 'warn'], low: ['낮음', 'ok'] };
function renderAnalysis(r, bubble) {
  log.querySelectorAll('.msg.active').forEach((m) => m.classList.remove('active')); bubble.classList.add('active');
  const a = r.analysis, [pl, pc] = priLabel[a.priority];
  const box = $('#analysis'); box.className = ''; box.replaceChildren(...[
    r.piiMasked.length ? h('div', { class: 'notice' }, `개인정보(${r.piiMasked.join(', ')})를 감지해 가려서 저장했습니다.`) : null,
    h('dl', { class: 'kv' },
      h('dt', {}, '문의 유형'), h('dd', {}, `${a.category} (${Math.round(a.categoryProb * 100)}%)`),
      h('dt', {}, '감정'), h('dd', {}, `${a.sentimentLabel} (${a.sentiment})`),
      h('dt', {}, '우선순위'), h('dd', {}, h('span', { class: 'tag ' + pc }, pl), a.reasons.length ? ' ' + a.reasons.join(', ') : ''),
      h('dt', {}, '검색 신뢰도'), h('dd', {}, String(r.confidence), h('div', { class: 'meter' }, h('i', { style: `width:${Math.round(r.confidence * 100)}%` }))),
      h('dt', {}, '답변 방식'), h('dd', {}, r.generator),
      h('dt', {}, '응답 시간'), h('dd', {}, (r.latencyMs / 1000).toFixed(1) + '초')),
    r.escalated ? h('div', { class: 'notice' }, `상담원 티켓 #${r.ticketId} 생성 (사유: ${({ low_confidence: '근거 부족', user_request: '고객 요청', priority: '긴급·사고성 문의' })[r.escalateReason] ?? r.escalateReason})`) : null,
    h('b', {}, '답변 근거'),
    r.sources.length ? r.sources.map((s) => h('div', { class: 'src' }, h('b', {}, `${s.id} · ${s.title}`), h('span', {}, s.text))) : h('div', { class: 'empty' }, '근거 문서 없음')].flat().filter(Boolean));
}

// ---- 상담원 콘솔 ----
async function refreshBadge() {
  try { const t = await api('/api/tickets?status=open'); const b = $('#ticketBadge'); b.hidden = t.length === 0; b.textContent = t.length; return t; } catch { return []; }
}
let selected = null;
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
function bars(title, rows, fmt = (x) => x) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return h('div', { class: 'card' }, h('h2', {}, title), rows.length ? rows.map((r) => h('div', { class: 'bar' }, h('span', { title: fmt(r.label) }, fmt(r.label)), h('div', {}, h('i', { style: `width:${(r.count / max) * 100}%` })), h('span', {}, r.count))) : h('div', { class: 'empty' }, '데이터 없음'));
}
async function loadDash() {
  const s = await api('/api/stats');
  const rated = s.helpful + s.unhelpful;
  const kpi = (v, l) => h('div', { class: 'kpi' }, h('b', {}, v), h('span', {}, l));
  $('#kpis').replaceChildren(kpi(s.total, '총 문의'), kpi(Math.round(s.autoResolvedRate * 100) + '%', '챗봇 자동 해결률'), kpi((s.avgLatencyMs / 1000).toFixed(1) + '초', '평균 응답 시간'), kpi(s.openTickets, '미처리 티켓'), kpi(rated ? Math.round((s.helpful / rated) * 100) + '%' : '-', `고객 만족(평가 ${rated}건)`), kpi(s.avgConfidence, '평균 검색 신뢰도'));
  const pri = { high: '높음', medium: '보통', low: '낮음' };
  $('#charts').replaceChildren(bars('문의 유형별', s.byCategory), bars('우선순위별', s.byPriority, (x) => pri[x] ?? x), bars('답변 방식별', s.byGenerator), bars('일자별 문의(최근 7일)', s.byDay), bars('자주 인용된 지식(= 많이 궁금해하는 주제)', s.topSources.map((t) => ({ label: `${t.id} ${t.title}`, count: t.count }))));
}

// ---- 지식베이스 ----
let kbAll = null;
async function loadKb() {
  kbAll ??= await api('/api/kb'); $('#kbCount').textContent = `${kbAll.length}개 문서 조각`;
  renderKb(kbAll.map((c) => ({ ...c })));
}
const renderKb = (items) => $('#kbList').replaceChildren(...items.map((c) => h('div', { class: 'kb-item' }, h('b', {}, h('code', {}, c.id), c.title, c.score != null ? h('span', { class: 'tag' }, ' 점수 ' + c.score.toFixed(2)) : null), h('div', {}, c.text ?? ''))));
let timer;
$('#kbSearch').addEventListener('input', (e) => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const q = e.target.value.trim(); if (!q) return renderKb(kbAll);
    const r = await api('/api/kb/search?q=' + encodeURIComponent(q));
    renderKb(r.hits.map((x) => ({ ...kbAll.find((c) => c.id === x.id), score: x.score })));
  }, 250);
});
refreshBadge();
