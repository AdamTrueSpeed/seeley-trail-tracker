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
  // Challenges between friends (see the end of this file). They are not filed under a family: whoever holds a challenge's id is in it.
  `CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS scores (challenge TEXT NOT NULL, player TEXT NOT NULL, day TEXT NOT NULL, name TEXT NOT NULL, team TEXT NOT NULL,
     dist REAL NOT NULL, ms INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (challenge, player, day))`,
  `CREATE TABLE IF NOT EXISTS invites (inbox TEXT NOT NULL, challenge TEXT NOT NULL, sender TEXT NOT NULL, title TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (inbox, challenge))`,
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

// ---- challenges between friends ---------------------------------------------------------
//
//   PUT /api/challenge/<id>          { name, kind, start, days, teams, by }   made once; later PUTs change nothing
//   GET /api/challenge/<id>          -> { challenge, scores: [{ player, name, team, day, dist, ms }] }
//   PUT /api/challenge/<id>/score    { player, name, team, days: [{ day, dist, ms }] }   a player's own daily totals
//   POST /api/invite                 { to: [inbox], challenge, from, title }   "inbox" is a one-way hash of a friend code
//   GET /api/invites/<inbox>         -> { invites: [{ challenge, from, title, created }] }
//
// Only a name, a team and a distance per day are kept: no positions. Anyone holding
// a challenge's id (it is in the link the challenger sends) can see and join it.

const CHALLENGE_ID = /^[A-HJKMNP-TV-Z2-9]{10}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS_OF_CHALLENGE = new Set(['any', 'foot', 'wheels']);
const INVITE_LIFE = 30 * 86400000;
const short = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

async function challenge(db, id, sub, request) {
  if (request.method === 'GET' && !sub) {
    const row = await db.prepare('SELECT data FROM challenges WHERE id = ?').bind(id).first();
    if (!row) return fail(404, 'no such challenge');
    const scores = (await db.prepare('SELECT player, name, team, day, dist, ms FROM scores WHERE challenge = ? ORDER BY day, dist DESC LIMIT 5000').bind(id).all()).results;
    return json({ challenge: { id, ...JSON.parse(row.data) }, scores });
  }
  if (request.method !== 'PUT') return fail(404, 'no such address');
  const body = await request.json().catch(() => null);
  if (!sub) {
    const teams = Array.isArray(body?.teams) ? [...new Set(body.teams.map((t) => short(t, 24)).filter(Boolean))].slice(0, 6) : [];
    const data = {
      name: short(body?.name, 60), kind: body?.kind, start: body?.start,
      days: Number.isInteger(body?.days) && body.days >= 0 && body.days <= 366 ? body.days : 0,
      teams: teams.length > 1 ? teams : [], by: short(body?.by, 40),
    };
    if (!data.name || !KINDS_OF_CHALLENGE.has(data.kind) || !DAY.test(data.start ?? '')) return fail(400, 'bad challenge');
    await db.prepare('INSERT OR IGNORE INTO challenges (id, created, data) VALUES (?, ?, ?)').bind(id, Date.now(), JSON.stringify(data)).run();
    return json({ ok: true });
  }
  if (sub !== 'score') return fail(404, 'no such address');
  const player = short(body?.player, 40), name = short(body?.name, 40), days = Array.isArray(body?.days) ? body.days.slice(0, 40) : [];
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(player) || !name) return fail(400, 'bad player');
  const row = await db.prepare('SELECT data FROM challenges WHERE id = ?').bind(id).first();
  if (!row) return fail(404, 'no such challenge');
  const teams = JSON.parse(row.data).teams ?? [];
  const team = teams.includes(body?.team) ? body.team : '';
  const clean = days.filter((d) => DAY.test(d?.day ?? '') && Number.isFinite(d.dist) && d.dist >= 0 && d.dist < 2e6);
  if (clean.length) {
    await db.batch(clean.map((d) => db.prepare(
      `INSERT INTO scores (challenge, player, day, name, team, dist, ms, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (challenge, player, day) DO UPDATE SET name = ?4, team = ?5, dist = ?6, ms = ?7, updated = ?8`,
    ).bind(id, player, d.day, name, team, Math.round(d.dist), Math.max(0, Math.round(Number(d.ms) || 0)), Date.now())));
  }
  // The name and team a player goes by now apply to their earlier days as well.
  await db.prepare('UPDATE scores SET name = ?, team = ? WHERE challenge = ? AND player = ?').bind(name, team, id, player).run();
  return json({ ok: true });
}

async function invites(db, what, id, request) {
  if (what === 'invite' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const to = Array.isArray(body?.to) ? body.to.filter((x) => /^[0-9a-f]{64}$/.test(x)).slice(0, 50) : [];
    if (!to.length || !CHALLENGE_ID.test(body?.challenge ?? '')) return fail(400, 'bad invite');
    const sender = short(body.from, 40) || 'A friend', title = short(body.title, 120);
    await db.batch(to.map((inbox) => db.prepare(
      'INSERT INTO invites (inbox, challenge, sender, title, created) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (inbox, challenge) DO UPDATE SET sender = ?3, title = ?4, created = ?5',
    ).bind(inbox, body.challenge, sender, title, Date.now())));
    return json({ ok: true, sent: to.length });
  }
  if (what === 'invites' && request.method === 'GET' && /^[0-9a-f]{64}$/.test(id ?? '')) {
    await db.prepare('DELETE FROM invites WHERE created < ?').bind(Date.now() - INVITE_LIFE).run();
    const rows = (await db.prepare('SELECT challenge, sender, title, created FROM invites WHERE inbox = ? ORDER BY created DESC LIMIT 50').bind(id).all()).results;
    return json({ invites: rows.map((r) => ({ challenge: r.challenge, from: r.sender, title: r.title, created: r.created })) });
  }
  return fail(404, 'no such address');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      const [, , kind, key, sub] = url.pathname.split('/');
      if (kind === 'challenge' || kind === 'invite' || kind === 'invites') {
        await prepare(env.DB);
        if (kind !== 'challenge') return await invites(env.DB, kind, key, request);
        if (!CHALLENGE_ID.test(key ?? '')) return fail(404, 'no such challenge');
        return await challenge(env.DB, key, sub, request);
      }
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
