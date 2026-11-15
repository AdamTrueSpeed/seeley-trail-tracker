// Live check of position sharing through the real relays (needs the internet,
// so it is not part of `npm test`). Four pretend phones:
//
//   A  shares; starts with "friends", then "everyone", then goes private
//   B  has A's friend code and is nearby
//   C  does not have A's code but is nearby
//   D  does not have A's code and is far away
//
// Usage: node tools/test-relay.mjs

import { LiveShare, newCode } from '../js/share.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = { lat: 44.9275, lon: -75.818, acc: 5 }, away = { lat: 45.6, lon: -74.9, acc: 5 };
const phone = (name) => {
  const share = new LiveShare({ onChange() {} });
  return { name, share, me: { id: `test-${name}-${Math.random().toString(36).slice(2)}`, name, code: newCode() } };
};
const A = phone('A'), B = phone('B'), C = phone('C'), D = phone('D');
const sees = (p, who) => p.share.list().find((x) => x.name === who.name) ?? null;

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}

/** Keep everyone "moving" until the condition holds or time runs out. */
async function until(cond, seconds = 25) {
  for (let i = 0; i < seconds * 2; i++) {
    await Promise.all([
      A.share.update(here, { method: 'Walking', rec: true }), B.share.update(here), C.share.update(here), D.share.update(away),
    ]);
    if (cond()) return true;
    await sleep(500);
  }
  return false;
}

await A.share.configure({ mode: 'friends', me: A.me, friends: [] });
await B.share.configure({ mode: 'friends', me: B.me, friends: [{ code: A.me.code }] });
await C.share.configure({ mode: 'friends', me: C.me, friends: [] });
await D.share.configure({ mode: 'friends', me: D.me, friends: [] });

check('all four connect to a relay', await until(() => [A, B, C, D].every((p) => p.share.connected)),
  [A, B, C, D].map((p) => `${p.name}:${p.share.relays.filter((r) => r.up).length}/${p.share.relays.length}`).join(' '));

check('A shares with friends: B (has the code) sees A', await until(() => sees(B, A)));
const seen = sees(B, A);
check('  ...as a friend, at the right spot, with the method', !!seen && seen.friend && Math.abs(seen.lat - here.lat) < 1e-5 && seen.method === 'Walking' && seen.rec === true,
  seen ? `${seen.lat}, ${seen.lon} ${seen.method}` : 'not seen');
await sleep(3000);
check('  ...C (nearby, no code) does not', !sees(C, A));
check('  ...D (far away, no code) does not', !sees(D, A));
check('  ...and A does not see B (B never gave A a code)', !sees(A, B));

await A.share.configure({ mode: 'everyone', me: A.me, friends: [] });
check('A shares with everyone nearby: C now sees A', await until(() => sees(C, A)));
check('  ...as a stranger, not a friend', sees(C, A)?.friend === false);
check('  ...B still sees A as a friend', await until(() => sees(B, A)?.friend === true));
await sleep(3000);
check('  ...D (far away) still does not', !sees(D, A));

await A.share.configure({ mode: 'private', me: A.me, friends: [] });
check('A goes private: B and C lose A straight away', await until(() => !sees(B, A) && !sees(C, A), 10));
check('  ...and A is disconnected from every relay', !A.share.connected);

for (const p of [A, B, C, D]) await p.share.configure({ mode: 'private', me: p.me, friends: [] });
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
