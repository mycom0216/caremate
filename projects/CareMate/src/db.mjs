// ─────────────────────────────────────────────────────────────────────────────
// db.mjs — SQLite 저장소 (주문, 문의 기록, 상담 티켓)
//
// [기술]  node:sqlite 의 DatabaseSync(Node 내장, 동기 방식). 파일 하나에 저장되므로 별도 DB 서버가 필요 없습니다.
//         ':memory:' 를 주면 메모리 DB(테스트용)로 열립니다.
//
// [테이블 3개]
//   orders     주문 (order_no 기본키) — 주문번호 조회 답변의 원천. 비어 있으면 샘플 5건을 자동으로 넣음.
//   inquiries  문의 한 건 = 고객 질문(마스킹본) + 분석 결과(유형·감정·우선순위) + 챗봇 답변 + 생성 방식 + 신뢰도
//              + 근거 목록(JSON 문자열) + 상담원 연결 여부 + 응답 시간 + 고객 평가(feedback: 1 도움, 0 아님, NULL 미평가)
//   tickets    상담원에게 넘긴 문의 (inquiry_id 로 inquiries 를 참조) — 사유, 우선순위, 상태(open/resolved), 상담원 답변
//
// [보안·정합성]
//   · 모든 SQL 값은 ? 자리표시자(prepared statement)로 전달 → SQL 인젝션 방지. (문자열 이어 붙이기로 값을 넣지 않음)
//   · 배열·객체는 JSON.stringify 로 문자열 저장, 읽을 때 JSON.parse (parse 메서드).
//   · foreign_keys ON 으로 존재하지 않는 문의에 티켓을 달 수 없게 함.
//   · 티켓 답변은 "status='open' 인 것만" 갱신하는 한 번의 UPDATE → 두 상담원이 동시에 답해도 한 번만 성공(중복 처리 방지).
// ─────────────────────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';

// 스키마(테이블·인덱스 정의). IF NOT EXISTS 라서 매번 실행해도 안전합니다(이미 있으면 건너뜀).
//   주요 열: orders.status(결제완료/상품준비중/출고완료/배송중/배송완료), inquiries.pii_found/reasons/sources(JSON 문자열 배열),
//   inquiries.escalated(0/1), tickets.status 기본 'open'. 인덱스 두 개는 최근 문의 조회·티켓 상태별 조회를 빠르게 합니다.
//   (SQL 은 문자열 안이라 이 안에는 주석을 달지 않았습니다.)
const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  order_no TEXT PRIMARY KEY, item TEXT NOT NULL, amount INTEGER NOT NULL,
  status TEXT NOT NULL, carrier TEXT, tracking_no TEXT, ordered_at TEXT NOT NULL, eta TEXT
);
CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_at TEXT NOT NULL,
  question TEXT NOT NULL, pii_found TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL, category_prob REAL NOT NULL,
  sentiment REAL NOT NULL, priority TEXT NOT NULL, reasons TEXT NOT NULL DEFAULT '[]',
  answer TEXT NOT NULL, generator TEXT NOT NULL, confidence REAL NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]', escalated INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0, feedback INTEGER
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  created_at TEXT NOT NULL, reason TEXT NOT NULL, priority TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', reply TEXT, replied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_inq_created ON inquiries(created_at);
CREATE INDEX IF NOT EXISTS idx_ticket_status ON tickets(status);
`;

// 샘플 주문 5건(가상 데이터). 열 순서는 orders 테이블 정의와 같아야 합니다: 주문번호, 상품, 금액, 상태, 택배사, 운송장, 주문일, 도착예정일.
//   배송 전 주문은 택배사·운송장이 null.
const SEED_ORDERS = [
  ['MM-1001', '무선 이어폰 모아버즈', 59000, '배송중', '한진택배', '4012-3345-8812', '2026-11-18', '2026-11-21'],
  ['MM-1002', '순면 후드티 (M)', 39000, '상품준비중', null, null, '2026-11-20', '2026-11-23'],
  ['MM-1003', '프리미엄 원두 1kg', 28000, '배송완료', '한진택배', '4012-3301-0097', '2026-11-12', '2026-11-14'],
  ['MM-1004', '스테인리스 텀블러', 21000, '결제완료', null, null, '2026-11-20', '2026-11-24'],
  ['MM-1005', '무선 청소기', 189000, '출고완료', '한진택배', '4012-3355-6620', '2026-11-19', '2026-11-22'],
];

// DB 를 열고 준비합니다. 반환: DatabaseSync 객체.
//   1) 파일(없으면 생성) 또는 메모리 DB 열기 2) WAL 모드(읽기·쓰기가 서로 덜 막힘) + 외래키 검사 켜기 3) 스키마 생성 4) 주문이 하나도 없으면 샘플 주문 삽입
export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const n = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  if (n === 0) {
    const ins = db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?)');
    for (const r of SEED_ORDERS) ins.run(...r);
  }
  return db;
}

// DB 접근을 한곳에 모은 클래스. 서비스 코드는 SQL 을 직접 쓰지 않고 이 메서드들만 호출합니다.
export class Store {
  constructor(db) { this.db = db; }

  // 주문번호로 주문 한 건 조회. 없으면 null. (인증 없음 — chat.mjs 의 주의 참고)
  order(no) { return this.db.prepare('SELECT * FROM orders WHERE order_no = ?').get(no) ?? null; }

  // 문의 저장. r 은 chat.mjs 가 만든 객체(sessionId, question, piiFound, category, ... latencyMs). 배열은 JSON 문자열로 바꿔 넣고
  //   escalated 는 불리언을 0/1 로 바꿉니다. 시각은 ISO 문자열(UTC). 반환: 새로 생긴 문의 번호.
  addInquiry(r) {
    const info = this.db.prepare(`INSERT INTO inquiries
      (session_id, created_at, question, pii_found, category, category_prob, sentiment, priority, reasons, answer, generator, confidence, sources, escalated, latency_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      r.sessionId, new Date().toISOString(), r.question, JSON.stringify(r.piiFound), r.category, r.categoryProb,
      r.sentiment, r.priority, JSON.stringify(r.reasons), r.answer, r.generator, r.confidence,
      JSON.stringify(r.sources), r.escalated ? 1 : 0, r.latencyMs);
    return Number(info.lastInsertRowid);
  }

  // 티켓 생성. 반환: 티켓 번호. 상태는 기본값 'open'.
  addTicket(inquiryId, reason, priority) {
    const info = this.db.prepare('INSERT INTO tickets (inquiry_id, created_at, reason, priority) VALUES (?,?,?,?)')
      .run(inquiryId, new Date().toISOString(), reason, priority);
    return Number(info.lastInsertRowid);
  }

  // 문의 한 건 조회(JSON 열은 객체로 풀어 줌). 없으면 null.
  inquiry(id) { return this.parse(this.db.prepare('SELECT * FROM inquiries WHERE id = ?').get(id)); }

  // DB 행의 JSON 문자열 열(pii_found, reasons, sources)을 배열로 바꿉니다. 행이 없으면 null.
  parse(row) {
    if (!row) return null;
    for (const k of ['pii_found', 'reasons', 'sources']) if (k in row) row[k] = JSON.parse(row[k]);
    return row;
  }

  // 최근 문의 N건(기본 50), 최신이 먼저. limit 은 ? 로 전달.
  recentInquiries(limit = 50) {
    return this.db.prepare('SELECT * FROM inquiries ORDER BY id DESC LIMIT ?').all(limit).map((r) => this.parse(r));
  }

  // 티켓 목록(문의 내용 포함). status 가 있으면 그 상태만. 정렬: 우선순위 high → medium → low, 같으면 최신 번호 먼저.
  //   (CASE 식으로 문자열 우선순위를 숫자 순서로 바꿔 정렬)  JOIN 으로 고객 질문·유형·감정·챗봇 답변도 함께 가져옵니다.
  tickets(status) {
    const sql = `SELECT t.*, i.question, i.category, i.sentiment, i.answer AS bot_answer, i.session_id
      FROM tickets t JOIN inquiries i ON i.id = t.inquiry_id ${status ? 'WHERE t.status = ?' : ''}
      ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.id DESC`;
    return status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all();
  }

  // 티켓 한 건 + 문의의 질문·유형·감정. 없으면 null. (draft 생성에 사용)
  ticket(id) { return this.db.prepare('SELECT t.*, i.question, i.category, i.sentiment FROM tickets t JOIN inquiries i ON i.id=t.inquiry_id WHERE t.id = ?').get(id) ?? null; }

  // 상담원 답변 등록. 조건 status='open' 이 핵심: 이미 처리된 티켓이면 변경 행이 0 개 → false. 성공하면 상태를 resolved 로 바꾸고 시각을 기록.
  //   반환: 한 건 바뀌었으면 true.
  replyTicket(id, reply) {
    const info = this.db.prepare("UPDATE tickets SET reply = ?, status = 'resolved', replied_at = ? WHERE id = ? AND status = 'open'")
      .run(reply, new Date().toISOString(), id);
    return info.changes === 1;
  }

  // 고객 평가 저장(true→1, false→0). 문의가 없으면(변경 0건) false.
  setFeedback(id, helpful) {
    return this.db.prepare('UPDATE inquiries SET feedback = ? WHERE id = ?').run(helpful ? 1 : 0, id).changes === 1;
  }

  // 한 세션의 최근 대화(기본 6건). 최신순으로 가져온 뒤 reverse() 로 오래된 것 → 최근 순으로 바꿉니다. 후속 질문 맥락용.
  history(sessionId, limit = 6) {
    return this.db.prepare('SELECT question, answer FROM inquiries WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit).reverse();
  }

  // 대시보드 통계. 반환 필드: total(총 문의), escalated(상담원 연결), autoResolvedRate(자동 해결률 = 1 − 연결 비율),
  //   avgLatencyMs(평균 응답시간), avgConfidence(평균 검색 신뢰도), helpful/unhelpful(평가), openTickets(미처리 티켓),
  //   byCategory/byPriority/byGenerator/byDay(분포: [{label, count}]), topSources(자주 인용된 지식).
  stats() {
    // q: SQL 을 실행해 모든 행을 배열로, one: 한 줄짜리 집계 결과의 첫 행. COALESCE(AVG(...),0) 는 문의가 없을 때 NULL 대신 0 을 줍니다.
    const q = (sql, ...a) => this.db.prepare(sql).all(...a);
    const total = q('SELECT COUNT(*) c FROM inquiries')[0].c;
    const one = (sql) => q(sql)[0];
    return {
      total,
      escalated: one('SELECT COUNT(*) c FROM inquiries WHERE escalated = 1').c,
      autoResolvedRate: total ? 1 - one('SELECT COUNT(*) c FROM inquiries WHERE escalated = 1').c / total : 0,
      avgLatencyMs: Math.round(one('SELECT COALESCE(AVG(latency_ms),0) a FROM inquiries').a),
      avgConfidence: Number(one('SELECT COALESCE(AVG(confidence),0) a FROM inquiries').a.toFixed(2)),
      helpful: one('SELECT COUNT(*) c FROM inquiries WHERE feedback = 1').c,
      unhelpful: one('SELECT COUNT(*) c FROM inquiries WHERE feedback = 0').c,
      openTickets: one("SELECT COUNT(*) c FROM tickets WHERE status = 'open'").c,
      byCategory: q('SELECT category AS label, COUNT(*) AS count FROM inquiries GROUP BY category ORDER BY count DESC'),
      byPriority: q('SELECT priority AS label, COUNT(*) AS count FROM inquiries GROUP BY priority'),
      // 답변 방식별: generator 에서 괄호 뒤(예: "extractive(guard:...)" 의 세부 사유)를 잘라 같은 방식끼리 묶습니다.
      byGenerator: q("SELECT CASE WHEN instr(generator,'(')>0 THEN substr(generator,1,instr(generator,'(')-1) ELSE generator END AS label, COUNT(*) AS count FROM inquiries GROUP BY 1 ORDER BY 2 DESC"),
      // 일자별: 문의 시각의 앞 10글자(YYYY-MM-DD)로 묶어 최근 7일을 가져온 뒤 reverse() 로 날짜 오름차순으로 만듭니다.
      byDay: q('SELECT substr(created_at,1,10) AS label, COUNT(*) AS count FROM inquiries GROUP BY 1 ORDER BY 1 DESC LIMIT 7').reverse(),
      topSources: this.topSources(),
    };
  }

  // 자주 인용된 지식베이스 항목 = 고객이 가장 많이 궁금해하는 주제
  // 각 근거(source)의 id 별 인용 횟수를 세어 상위 5개를 돌려줍니다. 주문 조회 결과(kind:'order')와 id 없는 항목은 제외합니다.
  //   sources 가 JSON 문자열이므로 파싱해서 셉니다.
  topSources() {
    const counts = new Map();
    for (const r of this.db.prepare("SELECT sources FROM inquiries WHERE escalated = 0 OR sources != '[]'").all()) {
      for (const s of JSON.parse(r.sources)) if (s.id && s.kind !== 'order') counts.set(s.id, { id: s.id, title: s.title, count: (counts.get(s.id)?.count ?? 0) + 1 });
    }
    return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  }
}
