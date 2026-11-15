// Checks for the pieces that need no phone and no network: step counting,
// calories, friend codes and the sealing of shared positions.
// Usage: node tools/test-units.mjs

import { StepDetector, stepsFromDistance, metFor, kcalFor, kcalOfRide, effortOf, elevationOf, movingTimeOf } from '../js/activity.js';
import { natureHunt, placesHunt, placesReached, hintFor, foundCount, isComplete, encodeHunt, decodeHunt, NATURE_ITEMS, REACH } from '../js/hunt.js';
import { newCode, cleanCode, formatCode, channel, seal, unseal, Relay } from '../js/share.js';
import { indexConditions, conditionsAlong, conditionText } from '../js/reference.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}

// ---- steps: a simulated phone carried by a walker ----------------------------------
function walk({ seconds, stepsPerSecond, swing, noise = 0.25, hz = 60, seed = 3 }) {
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  const d = new StepDetector();
  for (let i = 0; i < seconds * hz; i++) {
    const t = (i * 1000) / hz;
    // Gravity mostly on one axis (phone tilted), plus the bounce of each step, plus sensor noise.
    const bounce = swing * Math.max(0, Math.sin((2 * Math.PI * stepsPerSecond * t) / 1000)) ** 3;
    d.feed(1.5 + rnd() * noise, 9.6 + bounce + rnd() * noise, 1.2 + rnd() * noise, t);
  }
  return d.count;
}
{
  const normal = walk({ seconds: 120, stepsPerSecond: 1.8, swing: 4 });
  check('steps: 2 minutes of normal walking (216 real steps)', Math.abs(normal - 216) <= 11, `${normal} counted`);
  const slow = walk({ seconds: 120, stepsPerSecond: 1.2, swing: 2.5 });
  check('steps: 2 minutes of slow walking (144 real steps)', Math.abs(slow - 144) <= 8, `${slow} counted`);
  const brisk = walk({ seconds: 60, stepsPerSecond: 2.4, swing: 6, hz: 100 });
  check('steps: 1 minute brisk, 100 readings a second (144 real steps)', Math.abs(brisk - 144) <= 8, `${brisk} counted`);
  const still = walk({ seconds: 120, stepsPerSecond: 0, swing: 0 });
  check('steps: standing still counts nothing', still <= 1, `${still} counted`);
  const pocket = walk({ seconds: 60, stepsPerSecond: 0, swing: 0, noise: 0.9 });
  check('steps: fidgeting with the phone counts almost nothing', pocket <= 4, `${pocket} counted`);
  check('steps: 1.5 km with no sensor is about 2000', stepsFromDistance(1500) === 2000);
}

// ---- calories ------------------------------------------------------------------------
{
  // An 80 kg person walking 5 km/h for an hour burns in the region of 300-350 kcal.
  const walkHour = kcalFor('foot', 5, 3600, 80);
  check('calories: 80 kg walking at 5 km/h for an hour', walkHour > 280 && walkHour < 380, `${walkHour.toFixed(0)} kcal`);
  const atvHour = kcalFor('atv', 20, 3600, 80);
  check('calories: 80 kg on an ATV for an hour', atvHour > 250 && atvHour < 340, `${atvHour.toFixed(0)} kcal`);
  check('calories: sitting in a side-by-side is less than riding an ATV', metFor('drive', 20) < metFor('atv', 20));
  check('calories: cycling harder burns more', metFor('bike', 25) > metFor('bike', 12));
  check('calories: heavier burns more', kcalFor('foot', 5, 600, 100) > kcalFor('foot', 5, 600, 60));
  check('calories: method picks the right table',
    effortOf({ kind: 'foot' }) === 'foot' && effortOf({ kind: 'bike' }) === 'bike' && effortOf({ kind: 'motor' }) === 'atv' && effortOf({ kind: 'motor', effort: 'drive' }) === 'drive');
  // 10 minutes of walking points one second apart, then a 5 minute stop, then 10 more minutes.
  const pts = (from, n) => Array.from({ length: n }, (_, i) => ({ t: (from + i) * 1000, spd: 1.3 }));
  const ride = kcalOfRide([[...pts(0, 600), ...pts(900, 600)]], { kind: 'foot' }, 80);
  const moving = kcalFor('foot', 1.3 * 3.6, 1198, 80);
  check('calories: a stop in the middle of a ride is not counted', Math.abs(ride - moving) < 0.5, `${ride.toFixed(1)} vs ${moving.toFixed(1)} kcal`);
}

// ---- time ------------------------------------------------------------------------------------
{
  // 10 minutes moving (a point a second), a 5 minute stop, 10 more minutes moving, in two pieces.
  const run = (from, n) => Array.from({ length: n }, (_, i) => ({ t: (from + i) * 1000 }));
  const moving = movingTimeOf([[...run(0, 600), ...run(900, 300)], run(1200, 300)]);
  check('time: moving time leaves out a 5 minute stop', moving === (599 + 299 + 299) * 1000, `${moving / 1000} s of ${1499} s elapsed`);
  check('time: no points, no moving time', movingTimeOf([]) === 0 && movingTimeOf([[{ t: 5 }]]) === 0);
}

// ---- scavenger hunts ---------------------------------------------------------------------------
{
  let s = 9;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const nature = natureHunt(8, rnd);
  check('hunt: a nature hunt has the number of things asked for, all different',
    nature.items.length === 8 && new Set(nature.items.map((i) => i.name)).size === 8 && nature.items.every((i) => i.kind === 'photo' && NATURE_ITEMS.includes(i.name)));
  check('hunt: asking for more than exist gives them all', natureHunt(500, rnd).items.length === NATURE_ITEMS.length);

  const pins = [{ name: 'Old bridge', lat: 44.9300, lon: -75.8200 }, { name: 'Deer stand', lat: 44.9320, lon: -75.8200 }];
  const places = placesHunt(pins, 'Find the spots');
  const progress = { found: {} };
  const at = (lat, lon) => ({ lat, lon, acc: 5 });
  check('hunt: far from every place, nothing is found', placesReached(places, progress, at(44.9310, -75.8200)).length === 0);
  const near = placesReached(places, progress, at(44.9300 + (REACH - 5) / 111320, -75.8200));
  check('hunt: within reach of a place finds it', near.length === 1 && near[0].name === 'Old bridge');
  check('hunt: just outside reach does not', placesReached(places, progress, at(44.9300 + (REACH + 5) / 111320, -75.8200)).length === 0);
  progress.found[near[0].id] = { t: 1 };
  check('hunt: a place already found is not found twice', placesReached(places, progress, at(44.9300, -75.8200)).length === 0);
  check('hunt: progress counts', foundCount(places, progress) === 1 && !isComplete(places, progress));
  progress.found[places.items[1].id] = { t: 2 };
  check('hunt: finding everything completes it', isComplete(places, progress));
  check('hunt: hint gives distance and direction', hintFor(places.items[1], at(44.9300, -75.8200)) === 'about 220 m to the north', hintFor(places.items[1], at(44.9300, -75.8200)));
  check('hunt: hint to the south-west', /south-west$/.test(hintFor({ lat: 44.92, lon: -75.83 }, at(44.93, -75.82))), hintFor({ lat: 44.92, lon: -75.83 }, at(44.93, -75.82)));
  check('hunt: hint says so when very close', hintFor(places.items[0], at(44.93001, -75.8200)) === 'Very close: look around!');

  const mixed = { ...places, by: 'Adam', hints: false, items: [...places.items, { id: 'x', kind: 'photo', name: 'Mushroom', clue: 'Look under the pines & "oaks"' }] };
  const code = encodeHunt(mixed), back = decodeHunt(code);
  check('hunt: a shared code contains only link-safe characters', /^[A-Za-z0-9_-]+$/.test(code), `${code.length} characters`);
  check('hunt: a hunt survives being shared and joined',
    back.name === 'Find the spots' && back.by === 'Adam' && back.hints === false && back.items.length === 3
    && back.items[0].kind === 'place' && Math.abs(back.items[0].lat - 44.93) < 1e-6 && back.items[2].kind === 'photo' && back.items[2].clue === mixed.items[2].clue);
  check('hunt: it can be joined from a whole link', decodeHunt(`https://example.org/app/?x=1#hunt=${code}`)?.items.length === 3);
  check('hunt: nonsense is refused', decodeHunt('hello') === null && decodeHunt('') === null && decodeHunt(encodeHunt({ name: 'x', items: [] })) === null);
  const bad = btoa(JSON.stringify({ n: 'x', i: [[1, 'Nowhere', '', 999, 0]] })).replace(/=+$/, '');
  check('hunt: a place with impossible coordinates is refused', decodeHunt(bad) === null);
}

// ---- elevation: a walk over a 20 m hill, with GPS height jitter ---------------------------------
{
  let s = 11;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  // 600 points: starts at 100 m, climbs to 120 m, drops to 95 m. Each reading is up to 4 m out.
  const truth = (i) => (i < 300 ? 100 + (20 * i) / 300 : 120 - (25 * (i - 300)) / 300);
  const walk = Array.from({ length: 600 }, (_, i) => ({ alt: truth(i) + rnd() * 8 }));
  walk[150].alt = 190; // one wild reading must not become the summit
  const e = elevationOf([walk]);
  check('elevation: highest point of a noisy walk (true 120 m)', Math.abs(e.high - 120) < 3 || (e.high > 120 && e.high < 131), `${e.high.toFixed(1)} m`);
  check('elevation: lowest point (true 95 m)', Math.abs(e.low - 95) < 3, `${e.low.toFixed(1)} m`);
  check('elevation: one wild reading moves the high point by under 11 m, not 70', e.high < 131, `${e.high.toFixed(1)} m`);
  check('elevation: no height readings gives no answer', elevationOf([[{ alt: null }, { alt: null }]]) === null && elevationOf([]) === null);
  check('elevation: split rides are read as one', (() => { const x = elevationOf([walk.slice(0, 300), walk.slice(300)]); return x && x.low < 97 && x.high > 117; })());
}

// ---- trail conditions --------------------------------------------------------------------------
{
  const at = (m) => ({ lat: 44.93, lon: -75.82 + m / 78700 }); // m metres east along a straight trail
  const ride = (from, to, cond, t) => Array.from({ length: (to - from) / 4 + 1 }, (_, i) => ({ ...at(from + i * 4), cond, t: t + i }));
  // Day 1: 0-300 m grassy, 300-400 m muddy. Day 2 (later): 300-400 m ridden again, now dry.
  const day1 = [...ride(0, 300, 'Grassy', 1000), ...ride(300, 400, 'Muddy', 2000)];
  const day2 = ride(300, 400, 'Dry and firm', 900000);
  const trail = [at(0), at(400)];
  const first = conditionsAlong(trail, indexConditions([{ segments: [day1] }]));
  check('conditions: a trail takes them from the ride along it', first.parts[0].cond === 'Grassy' && Math.abs(first.parts[0].share - 0.75) < 0.05 && first.parts[1].cond === 'Muddy',
    conditionText(first));
  const later = conditionsAlong(trail, indexConditions([{ segments: [day1] }, { segments: [day2] }]));
  check('conditions: a newer ride replaces what an older one said', later.parts.map((p) => p.cond).join() === 'Grassy,Dry and firm' && later.asOf > 900000, conditionText(later));
  const untagged = conditionsAlong(trail, indexConditions([{ segments: [day1.map(({ cond, ...p }) => p)] }]));
  check('conditions: a ride with none recorded says nothing', untagged.parts.length === 0 && conditionText(untagged) === '');
  const elsewhere = conditionsAlong([{ lat: 44.94, lon: -75.82 }, { lat: 44.941, lon: -75.82 }], indexConditions([{ segments: [day1] }]));
  check('conditions: a trail a kilometre away is not affected', elsewhere.known === 0);
  const half = conditionsAlong([at(0), at(800)], indexConditions([{ segments: [day1] }]));
  check('conditions: a half-surveyed trail knows it is half surveyed', Math.abs(half.known - 0.5) < 0.06, `${Math.round(half.known * 100)}% known`);
  check('conditions: one condition throughout reads as a single word', conditionText({ parts: [{ cond: 'Rocky', share: 0.97 }] }) === 'Rocky');
}

// ---- friend codes and sealing -------------------------------------------------------------
{
  const codes = new Set(Array.from({ length: 500 }, newCode));
  check('codes: 500 new codes are all different and well formed', codes.size === 500 && [...codes].every((c) => cleanCode(c) === c));
  const code = [...codes][0];
  check('codes: formatted as XXXX-XXXX-XXXX', /^.{4}-.{4}-.{4}$/.test(formatCode(code)));
  check('codes: typed sloppily still reads back', cleanCode(` ${formatCode(code).toLowerCase().replace(/-/g, ' ')} `) === code);
  check('codes: nonsense is refused', cleanCode('hello') === null && cleanCode('0000-1111-OOOO') === null && cleanCode('') === null);

  const mine = await channel('u', code), other = await channel('u', [...codes][1]), again = await channel('u', code);
  check('sealing: the same code always gives the same channel', mine.topic === again.topic);
  check('sealing: different codes give different channels', mine.topic !== other.topic);
  check('sealing: the channel name does not contain the code', !mine.topic.includes(code));
  const message = { id: 'abc', name: 'Sam', lat: 44.93, lon: -75.82, t: 1 };
  const sealed = await seal(mine.key, message);
  check('sealing: a friend with the code can read it', JSON.stringify(await unseal(again.key, sealed)) === JSON.stringify(message));
  check('sealing: someone with another code cannot', await unseal(other.key, sealed) === null);
  check('sealing: the position is not readable in the sealed packet', !new TextDecoder().decode(sealed).includes('44.93'));
  const sealedTwice = await seal(mine.key, message);
  check('sealing: the same message never looks the same twice', sealed.join() !== sealedTwice.join());
  sealed[20] ^= 1;
  check('sealing: a tampered packet is rejected', await unseal(mine.key, sealed) === null);
}

// ---- relay packets arriving in awkward pieces ------------------------------------------------------
{
  const got = [];
  const relay = new Relay('wss://unused', (topic, payload) => got.push([topic, new TextDecoder().decode(payload)]), () => {});
  const str = (s) => { const b = new TextEncoder().encode(s); return [b.length >> 8, b.length & 255, ...b]; };
  const publish = (topic, text) => { const body = [...str(topic), ...new TextEncoder().encode(text)]; return [0x30, body.length, ...body]; };
  const long = 'x'.repeat(300); // needs a two-byte length
  const longBody = [...str('t/long'), ...new TextEncoder().encode(long)];
  const stream = new Uint8Array([...publish('t/one', 'first'), ...publish('t/two', 'second'), 0x30, (longBody.length % 128) | 128, longBody.length >> 7, ...longBody]);
  for (let i = 0; i < stream.length; i += 7) relay._feed(stream.subarray(i, i + 7)); // drip-fed 7 bytes at a time
  check('relay: three packets split across many frames are all read',
    got.length === 3 && got[0].join() === 't/one,first' && got[1].join() === 't/two,second' && got[2][0] === 't/long' && got[2][1] === long);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
