// The cloud side of Seeley Trail Tracker: a small API over a Cloudflare D1
// database. The phones and computers keep their own copy (so the app works
// with no signal) and exchange changes with this when they can.
//
// Who may see what: every request carries a family sync code. The data is
// filed under a one-way hash of that code, so a device with the code sees that
// family's rides and nobody else's, and the code itself is never stored.
//
//   POST /api/sync            { since, items: [{ kind, id, updated, deleted, data }] }
//                             -> { seq, items: [...changed since `since`] }
//   PUT/GET /api/points/<ride id>   the GPS points of one ride (JSON text)
//   PUT/GET /api/photo/<pin id>     the picture of one photo pin
//
// When two devices change the same thing, the later change wins.

const KINDS = new Set(['ride', 'pin', 'kv']);
const MAX_ITEMS = 200;          // per request
const MAX_ITEM = 200000;        // characters of one item's data
const PART = 900000;            // characters of points per database row
const MAX_POINTS = 30000000;    // characters of points per ride
const MAX_PHOTO = 1900000;      // bytes

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS groups (grp TEXT PRIMARY KEY, seq INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS items (grp TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL,
     updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, data TEXT, PRIMARY KEY (grp, kind, id))`,
  `CREATE INDEX IF NOT EXISTS items_seq ON items (grp, seq)`,
  `CREATE TABLE IF NOT EXISTS points (grp TEXT NOT NULL, ride TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (grp, ride, part))`,
  `CREATE TABLE IF NOT EXISTS photos (grp TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY (grp, id))`,
];
let ready = null;
const prepare = (db) => (ready ??= db.batch(SCHEMA.map((sql) => db.prepare(sql))).catch((err) => { ready = null; throw err; }));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
const fail = (status, error) => json({ error }, status);

/** The family this request belongs to, from its sync code; null if it carries none worth the name. */
async function groupOf(request) {
  const code = /^Bearer ([A-Z0-9]{20,40})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!code) return null;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`seeley-trails ${code}`)));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sync(db, grp, body) {
  const since = Number.isInteger(body?.since) && body.since >= 0 ? body.since : 0;
  const incoming = Array.isArray(body?.items) ? body.items : [];
  if (incoming.length > MAX_ITEMS) return fail(413, 'too many items in one request');
  const clean = [];
  for (const it of incoming) {
    const data = it?.deleted ? null : JSON.stringify(it?.data ?? null);
    if (!KINDS.has(it?.kind) || typeof it.id !== 'string' || !it.id || it.id.length > 80 || !Number.isFinite(it.updated)) return fail(400, 'bad item');
    if (data && data.length > MAX_ITEM) return fail(413, 'item too large');
    clean.push({ kind: it.kind, id: it.id, updated: Math.round(it.updated), deleted: it.deleted ? 1 : 0, data });
  }
  let seq;
  if (clean.length) {
    // One step forward for the family's change counter; every change in this request carries it.
    seq = (await db.prepare('INSERT INTO groups (grp, seq) VALUES (?, 1) ON CONFLICT (grp) DO UPDATE SET seq = seq + 1 RETURNING seq').bind(grp).first()).seq;
    await db.batch(clean.map((it) => db.prepare(
      `INSERT INTO items (grp, kind, id, seq, updated, deleted, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (grp, kind, id) DO UPDATE SET seq = ?4, updated = ?5, deleted = ?6, data = ?7 WHERE ?5 > items.updated`,
    ).bind(grp, it.kind, it.id, seq, it.updated, it.deleted, it.data)));
    // A deleted ride or photo takes its bulky parts with it.
    const gone = clean.filter((it) => it.deleted);
    if (gone.length) {
      await db.batch(gone.map((it) => (it.kind === 'ride'
        ? db.prepare('DELETE FROM points WHERE grp = ? AND ride = ? AND EXISTS (SELECT 1 FROM items WHERE grp = ?1 AND kind = \'ride\' AND id = ?2 AND deleted = 1)').bind(grp, it.id)
        : db.prepare('DELETE FROM photos WHERE grp = ? AND id = ? AND EXISTS (SELECT 1 FROM items WHERE grp = ?1 AND kind = \'pin\' AND id = ?2 AND deleted = 1)').bind(grp, it.id))));
    }
  } else {
    seq = (await db.prepare('SELECT seq FROM groups WHERE grp = ?').bind(grp).first())?.seq ?? 0;
  }
  const rows = (await db.prepare('SELECT kind, id, seq, updated, deleted, data FROM items WHERE grp = ? AND seq > ? ORDER BY seq LIMIT 500').bind(grp, since).all()).results;
  const more = rows.length === 500;
  return json({
    seq: more ? rows[rows.length - 1].seq - 1 : seq, // more to come: stop just short, so nothing with the last counter is skipped
    more,
    items: (more ? rows.filter((r) => r.seq < rows[rows.length - 1].seq) : rows)
      .map((r) => ({ kind: r.kind, id: r.id, updated: r.updated, deleted: !!r.deleted, data: r.data ? JSON.parse(r.data) : null })),
  });
}

async function points(db, grp, ride, request) {
  if (request.method === 'GET') {
    const rows = (await db.prepare('SELECT data FROM points WHERE grp = ? AND ride = ? ORDER BY part').bind(grp, ride).all()).results;
    if (!rows.length) return fail(404, 'no points for that ride yet');
    return new Response(rows.map((r) => r.data).join(''), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
  }
  const text = await request.text();
  if (!text.startsWith('[') || text.length > MAX_POINTS) return fail(413, 'points missing or too large');
  const parts = [];
  for (let at = 0; at < text.length; at += PART) parts.push(text.slice(at, at + PART));
  await db.batch([
    db.prepare('DELETE FROM points WHERE grp = ? AND ride = ?').bind(grp, ride),
    ...parts.map((data, i) => db.prepare('INSERT INTO points (grp, ride, part, data) VALUES (?, ?, ?, ?)').bind(grp, ride, i, data)),
  ]);
  return json({ ok: true, parts: parts.length });
}

async function photo(db, grp, id, request) {
  if (request.method === 'GET') {
    const row = await db.prepare('SELECT type, data FROM photos WHERE grp = ? AND id = ?').bind(grp, id).first();
    if (!row) return fail(404, 'no picture for that pin yet');
    return new Response(new Uint8Array(row.data), { headers: { 'Content-Type': row.type, 'Cache-Control': 'no-store', ...CORS } });
  }
  const data = await request.arrayBuffer();
  if (!data.byteLength || data.byteLength > MAX_PHOTO) return fail(413, 'picture missing or too large');
  const type = /^image\/[a-z0-9.+-]+$/.test(request.headers.get('Content-Type') ?? '') ? request.headers.get('Content-Type') : 'image/jpeg';
  await db.prepare('INSERT INTO photos (grp, id, type, data) VALUES (?, ?, ?, ?) ON CONFLICT (grp, id) DO UPDATE SET type = ?3, data = ?4').bind(grp, id, type, data).run();
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      const grp = await groupOf(request);
      if (!grp) return fail(401, 'a sync code is needed');
      await prepare(env.DB);
      const [, , what, id] = url.pathname.split('/');
      if (what === 'sync' && request.method === 'POST') return await sync(env.DB, grp, await request.json().catch(() => null));
      if ((what === 'points' || what === 'photo') && /^[A-Za-z0-9_-]{1,80}$/.test(id ?? '') && (request.method === 'GET' || request.method === 'PUT')) {
        return await (what === 'points' ? points : photo)(env.DB, grp, id, request);
      }
      return fail(404, 'no such address');
    } catch (err) {
      return fail(500, String(err?.message ?? err));
    }
  },
};
