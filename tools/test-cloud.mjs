// Checks the cloud API (worker/index.js) against a copy running on this computer.
// Start that first, in another window, with the limits lowered so they can be reached:
//   npx wrangler dev --port 8787 --var FAMILY_BYTES:6000000 --var MAX_PLAYERS:3
// (the preview config "seeley-trail-tracker-cloud" does exactly that).
// The last checks use up the minute's allowance of requests: wait a minute before running it again.
// Usage: node tools/test-cloud.mjs [address, default http://localhost:8787]

import { newTransferCode } from '../js/transfer.js';

const base = process.argv[2] ?? 'http://localhost:8787';
let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}
const call = (code, path, init = {}) => fetch(`${base}/api/${path}`, { ...init, headers: { Authorization: `Bearer ${code}`, ...(init.headers ?? {}) } });
const sync = async (code, since, items = []) => (await call(code, 'sync', { method: 'POST', body: JSON.stringify({ since, items }) })).json();

const family = newTransferCode(), stranger = newTransferCode();
const ride = (id, name, updated) => ({ kind: 'ride', id: String(id), updated, deleted: false, data: { id, name, dist: 1200, status: 'done' } });

check('cloud: no code, no entry', (await fetch(`${base}/api/sync`, { method: 'POST', body: '{}' })).status === 401);
check('cloud: a new family starts empty', (await sync(family, 0)).items.length === 0);

const first = await sync(family, 0, [ride(1, 'Morning walk', 1000), ride(2, 'Creek loop', 1000), { kind: 'pin', id: '9', updated: 1000, deleted: false, data: { id: 9, name: 'House' } }]);
check('cloud: a phone sends two rides and a pin', first.seq === 1 && first.items.length === 3, `seq ${first.seq}`);
const desk = await sync(family, 0);
check('cloud: the desktop gets all three', desk.items.length === 3 && desk.items.find((i) => i.id === '2')?.data.name === 'Creek loop');
check('cloud: asking again gets nothing new', (await sync(family, desk.seq)).items.length === 0);
check('cloud: another family sees none of it', (await sync(stranger, 0)).items.length === 0);

const renamed = await sync(family, desk.seq, [ride(2, 'Creek loop east', 2000)]);
check('cloud: a rename on the desktop reaches the phone', (await sync(family, first.seq)).items.some((i) => i.id === '2' && i.data.name === 'Creek loop east'), `seq ${renamed.seq}`);
await sync(family, 0, [ride(2, 'Stale name from a phone that was offline', 1500)]);
check('cloud: an older change does not undo a newer one', (await sync(family, 0)).items.find((i) => i.id === '2').data.name === 'Creek loop east');

const pts = JSON.stringify(Array.from({ length: 30000 }, (_, i) => ({ seg: 0, lat: 44.9 + i * 1e-6, lon: -75.8, alt: 110, t: 1e12 + i * 1000, acc: 5, spd: 1.2 })));
check('cloud: points not sent yet are reported missing', (await call(family, 'points/1')).status === 404);
check('cloud: a long ride goes up', (await call(family, 'points/1', { method: 'PUT', body: pts })).ok, `${pts.length} characters`);
check('cloud: and comes back the same', await (await call(family, 'points/1')).text() === pts);
check('cloud: but not for another family', (await call(stranger, 'points/1')).status === 404);

const picture = crypto.getRandomValues(new Uint8Array(40000));
check('cloud: a photo goes up', (await call(family, 'photo/9', { method: 'PUT', body: picture, headers: { 'Content-Type': 'image/jpeg' } })).ok);
const back = await call(family, 'photo/9');
const got = new Uint8Array(await back.arrayBuffer());
check('cloud: and comes back the same', back.headers.get('Content-Type') === 'image/jpeg' && got.length === picture.length && got.every((v, i) => v === picture[i]));
check('cloud: with nosniff, so a browser will not guess its type', back.headers.get('X-Content-Type-Options') === 'nosniff');
check('cloud: an SVG picture is refused', (await call(family, 'photo/8', { method: 'PUT', body: '<svg xmlns="http://www.w3.org/2000/svg"/>', headers: { 'Content-Type': 'image/svg+xml' } })).status === 415);

await sync(family, 0, [{ kind: 'ride', id: '1', updated: 3000, deleted: true }, { kind: 'pin', id: '9', updated: 3000, deleted: true }]);
const after = await sync(family, 0);
check('cloud: a deleted ride is passed on as deleted', after.items.find((i) => i.kind === 'ride' && i.id === '1')?.deleted === true);
check('cloud: its points and the deleted pin\'s photo are gone', (await call(family, 'points/1')).status === 404 && (await call(family, 'photo/9')).status === 404);

// ---- challenges: no family code, whoever holds the id is in ----------------------------------------
{
  const { newChallengeId, standings, winnerOf } = await import('../js/challenge.js');
  const api = (path, method, body) => fetch(`${base}/api/${path}`, { method: method ?? 'GET', body: body ? JSON.stringify(body) : undefined });
  const id = newChallengeId(), day = '2026-11-16';
  const ch = { name: 'Test walk-off', kind: 'foot', start: day, days: 7, teams: ['Red', 'Blue'], by: 'Adam' };
  check('challenge: one that was never made is not found', (await api(`challenge/${id}`)).status === 404);
  check('challenge: a score for one that was never made is refused', (await api(`challenge/${id}/score`, 'PUT', { player: 'phone-aaaa', name: 'Adam', team: 'Red', days: [{ day, dist: 10, ms: 0 }] })).status === 404);
  check('challenge: it is made', (await api(`challenge/${id}`, 'PUT', ch)).ok);
  await api(`challenge/${id}`, 'PUT', { ...ch, name: 'Hijacked', teams: [] });
  check('challenge: making it again changes nothing', (await (await api(`challenge/${id}`)).json()).challenge.name === 'Test walk-off');
  check('challenge: a nonsense challenge is refused', (await api(`challenge/${newChallengeId()}`, 'PUT', { name: '', kind: 'foot', start: day })).status === 400);
  await api(`challenge/${id}/score`, 'PUT', { player: 'phone-aaaa', name: 'Adam', team: 'Red', days: [{ day, dist: 3000, ms: 60000 }] });
  await api(`challenge/${id}/score`, 'PUT', { player: 'phone-cccc', name: 'Christianne', team: 'Blue', days: [{ day, dist: 4200, ms: 90000 }] });
  await api(`challenge/${id}/score`, 'PUT', { player: 'phone-dddd', name: 'Dale', team: 'Green', days: [{ day, dist: 100, ms: 0 }, { day: 'yesterday', dist: 9e9 }] });
  await api(`challenge/${id}/score`, 'PUT', { player: 'phone-aaaa', name: 'Adam', team: 'Red', days: [{ day, dist: 5000, ms: 120000 }] });
  const got = await (await api(`challenge/${id}`)).json();
  const board = standings(got.challenge, got.scores, day);
  check('challenge: three people on the board, a later total replaces the earlier one', board.people.length === 3 && board.people[0].name === 'Adam' && board.people[0].dist === 5000, JSON.stringify(board.people.map((p) => [p.name, p.dist])));
  check('challenge: a team that does not exist is dropped, a nonsense day ignored', got.scores.find((s) => s.name === 'Dale').team === '' && got.scores.length === 3);
  check('challenge: the day goes to the team that went furthest', winnerOf(got.challenge, got.scores, day).name === 'Red');
  const inbox = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`test inbox ${id}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  check('challenge: an empty inbox is empty', (await (await api(`invites/${inbox}`)).json()).invites.length === 0);
  check('challenge: an invitation is left for a friend', (await api('invite', 'POST', { to: [inbox], challenge: id, from: 'Adam', title: 'Adam did a 3 km walk today. Can you beat that?' })).ok);
  await api('invite', 'POST', { to: [inbox], challenge: id, from: 'Adam', title: 'Sent twice' });
  const inv = (await (await api(`invites/${inbox}`)).json()).invites;
  check('challenge: the friend finds it, once', inv.length === 1 && inv[0].challenge === id && inv[0].from === 'Adam');
  check('challenge: a bad invitation is refused', (await api('invite', 'POST', { to: ['nobody'], challenge: id })).status === 400);

  // ---- limits (MAX_PLAYERS is 3 in the local test cloud) ----
  const fourth = await api(`challenge/${id}/score`, 'PUT', { player: 'phone-eeee', name: 'Eve', team: 'Red', days: [{ day, dist: 50, ms: 0 }] });
  check('limits: a full challenge takes nobody new', fourth.status === 403, `status ${fourth.status}`);
  check('limits: but someone already in it can still post', (await api(`challenge/${id}/score`, 'PUT', { player: 'phone-aaaa', name: 'Adam', team: 'Red', days: [{ day, dist: 5100, ms: 121000 }] })).ok);
  const burst = [];
  for (let i = 0; i < 35; i++) burst.push(await api('invite', 'POST', { to: ['nobody'], challenge: id }));
  const stopped = burst.find((r) => r.status === 429);
  check('limits: a flood of writes with no code is stopped', !!stopped && stopped.headers.get('Retry-After') === '60', `${burst.filter((r) => r.status === 429).length} of 35 refused`);
  check('limits: reading a challenge still works meanwhile', (await api(`challenge/${id}`)).ok);
}

// ---- a family's cloud space (FAMILY_BYTES is 6 MB in the local test cloud; one long ride is about 2.6 MB) ----
{
  const fam = newTransferCode();
  const put = (ride) => call(fam, `points/${ride}`, { method: 'PUT', body: pts });
  check('space: a first long ride goes up', (await put('a')).ok);
  check('space: and a second', (await put('b')).ok);
  const third = await put('c');
  check('space: a third does not fit', third.status === 507 && (await third.json()).error === 'the family\'s cloud space is full', `status ${third.status}`);
  check('space: sending a ride again replaces it, it is not counted twice', (await put('a')).ok);
  const bulky = (id) => ({ kind: 'pin', id, updated: 5000, deleted: false, data: { id, name: 'x'.repeat(190000) } });
  const items = [bulky('p1'), bulky('p2'), bulky('p3'), bulky('p4'), bulky('p5')];
  const refused = await call(fam, 'sync', { method: 'POST', body: JSON.stringify({ since: 0, items: [...items, { kind: 'ride', id: 'a', updated: 5000, deleted: true }] }) });
  check('space: a sync that would overfill it is refused', refused.status === 507, `status ${refused.status}`);
  check('space: but the deletion sent with it still makes room', (await call(fam, 'points/a')).status === 404);
  check('space: so the same sync now goes through', (await call(fam, 'sync', { method: 'POST', body: JSON.stringify({ since: 0, items }) })).ok);
  check('space: another family is not affected', (await call(stranger, 'points/c', { method: 'PUT', body: pts })).ok);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
