import { DatabaseSync } from 'node:sqlite';

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

const SEED_ORDERS = [
  ['MM-1001', '무선 이어폰 모아버즈', 59000, '배송중', '한진택배', '4012-3345-8812', '2026-11-18', '2026-11-21'],
  ['MM-1002', '순면 후드티 (M)', 39000, '상품준비중', null, null, '2026-11-20', '2026-11-23'],
  ['MM-1003', '프리미엄 원두 1kg', 28000, '배송완료', '한진택배', '4012-3301-0097', '2026-11-12', '2026-11-14'],
  ['MM-1004', '스테인리스 텀블러', 21000, '결제완료', null, null, '2026-11-20', '2026-11-24'],
  ['MM-1005', '무선 청소기', 189000, '출고완료', '한진택배', '4012-3355-6620', '2026-11-19', '2026-11-22'],
];

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

export class Store {
  constructor(db) { this.db = db; }

  order(no) { return this.db.prepare('SELECT * FROM orders WHERE order_no = ?').get(no) ?? null; }

  addInquiry(r) {
    const info = this.db.prepare(`INSERT INTO inquiries
      (session_id, created_at, question, pii_found, category, category_prob, sentiment, priority, reasons, answer, generator, confidence, sources, escalated, latency_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      r.sessionId, new Date().toISOString(), r.question, JSON.stringify(r.piiFound), r.category, r.categoryProb,
      r.sentiment, r.priority, JSON.stringify(r.reasons), r.answer, r.generator, r.confidence,
      JSON.stringify(r.sources), r.escalated ? 1 : 0, r.latencyMs);
    return Number(info.lastInsertRowid);
  }

  addTicket(inquiryId, reason, priority) {
    const info = this.db.prepare('INSERT INTO tickets (inquiry_id, created_at, reason, priority) VALUES (?,?,?,?)')
      .run(inquiryId, new Date().toISOString(), reason, priority);
    return Number(info.lastInsertRowid);
  }

  inquiry(id) { return this.parse(this.db.prepare('SELECT * FROM inquiries WHERE id = ?').get(id)); }

  parse(row) {
    if (!row) return null;
    for (const k of ['pii_found', 'reasons', 'sources']) if (k in row) row[k] = JSON.parse(row[k]);
    return row;
  }

  recentInquiries(limit = 50) {
    return this.db.prepare('SELECT * FROM inquiries ORDER BY id DESC LIMIT ?').all(limit).map((r) => this.parse(r));
  }

  tickets(status) {
    const sql = `SELECT t.*, i.question, i.category, i.sentiment, i.answer AS bot_answer, i.session_id
      FROM tickets t JOIN inquiries i ON i.id = t.inquiry_id ${status ? 'WHERE t.status = ?' : ''}
      ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.id DESC`;
    return status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all();
  }

  ticket(id) { return this.db.prepare('SELECT t.*, i.question, i.category, i.sentiment FROM tickets t JOIN inquiries i ON i.id=t.inquiry_id WHERE t.id = ?').get(id) ?? null; }

  replyTicket(id, reply) {
    const info = this.db.prepare("UPDATE tickets SET reply = ?, status = 'resolved', replied_at = ? WHERE id = ? AND status = 'open'")
      .run(reply, new Date().toISOString(), id);
    return info.changes === 1;
  }

  setFeedback(id, helpful) {
    return this.db.prepare('UPDATE inquiries SET feedback = ? WHERE id = ?').run(helpful ? 1 : 0, id).changes === 1;
  }

  history(sessionId, limit = 6) {
    return this.db.prepare('SELECT question, answer FROM inquiries WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit).reverse();
  }

  stats() {
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
      byGenerator: q("SELECT CASE WHEN instr(generator,'(')>0 THEN substr(generator,1,instr(generator,'(')-1) ELSE generator END AS label, COUNT(*) AS count FROM inquiries GROUP BY 1 ORDER BY 2 DESC"),
      byDay: q('SELECT substr(created_at,1,10) AS label, COUNT(*) AS count FROM inquiries GROUP BY 1 ORDER BY 1 DESC LIMIT 7').reverse(),
      topSources: this.topSources(),
    };
  }

  // 자주 인용된 지식베이스 항목 = 고객이 가장 많이 궁금해하는 주제
  topSources() {
    const counts = new Map();
    for (const r of this.db.prepare("SELECT sources FROM inquiries WHERE escalated = 0 OR sources != '[]'").all()) {
      for (const s of JSON.parse(r.sources)) if (s.id && s.kind !== 'order') counts.set(s.id, { id: s.id, title: s.title, count: (counts.get(s.id)?.count ?? 0) + 1 });
    }
    return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  }
}
