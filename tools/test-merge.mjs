// Checks the merge engine against simulated rides with realistic GPS error.
// Usage: node tools/test-merge.mjs [path-to-reference.kml]
//
// Rides are simulated along the trails in the reference KML (if present) and
// along a few synthetic shapes, then merged. Each check compares the merged
// network with the true trail the simulated rider followed.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildNetwork } from '../js/merge.js';
import { makeProjection } from '../js/geo.js';
import { estimateWidth, GRIZZLY_WIDTH } from '../js/width.js';

const LAT0 = 44.9275, LON0 = -75.818;
const proj = makeProjection(LAT0, LON0);
const toXY = (p) => [proj.x(p.lon), proj.y(p.lat)];
const toLL = ([x, y]) => ({ lat: proj.lat(y), lon: proj.lon(x) });

// ---- deterministic random numbers -----------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  const uni = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uni() || 1e-12)) * Math.cos(2 * Math.PI * uni());
}

/** One GPS fix per second along `path` ([x, y] metres), with slowly drifting error plus jitter. */
function ride(path, seed, { speed = 4, sigma = 2.5, corr = 60, jitter = 0.4 } = {}) {
  const g = rng(seed);
  const rho = Math.exp(-speed / corr), k = Math.sqrt(1 - rho * rho) * sigma;
  let bx = g() * sigma, by = g() * sigma;
  const out = [];
  let need = 0;
  const emit = (x, y) => {
    bx = rho * bx + k * g();
    by = rho * by + k * g();
    // acc is what the phone would report: the radius holding 68% of fixes, 1.5 standard deviations.
    out.push({ ...toLL([x + bx + jitter * g(), y + by + jitter * g()]), alt: 100 + 0.01 * y, acc: 1.5 * Math.hypot(sigma, jitter) });
  };
  for (let i = 1; i < path.length; i++) {
    const [x0, y0] = path[i - 1], [x1, y1] = path[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    let at = need;
    while (at <= len) {
      emit(x0 + ((x1 - x0) * at) / len, y0 + ((y1 - y0) * at) / len);
      at += speed;
    }
    need = at - len;
  }
  return out;
}

const lengthOf = (path) => path.slice(1).reduce((d, p, i) => d + Math.hypot(p[0] - path[i][0], p[1] - path[i][1]), 0);

function distToPath(x, y, path) {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1], [bx, by] = path[i];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/** Mean and worst distance from the merged lines to the true trails, sampled every 2 m. */
function errorVs(segments, truths) {
  let sum = 0, n = 0, worst = 0;
  for (const s of segments) {
    const pts = s.points.map(toXY);
    for (let i = 1; i < pts.length; i++) {
      const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const steps = Math.max(1, Math.ceil(len / 2));
      for (let k = 0; k <= steps; k++) {
        const x = pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * k) / steps;
        const y = pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * k) / steps;
        const d = Math.min(...truths.map((t) => distToPath(x, y, t)));
        sum += d; n++; worst = Math.max(worst, d);
      }
    }
  }
  return { mean: n ? sum / n : 0, worst };
}

// ---- checks -----------------------------------------------------------------------
let failures = 0;
function check(name, tracks, truths, expect, opts = {}) {
  const t0 = performance.now();
  const net = buildNetwork(tracks, { threshold: 8, smoothing: 3, ...opts });
  const ms = performance.now() - t0;
  const truthLen = truths.reduce((d, t) => d + lengthOf(t), 0);
  const ratio = net.stats.mergedLength / truthLen;
  const err = errorVs(net.segments, truths);
  const problems = [];
  const [lo, hi] = expect.ratio ?? [0.95, 1.05];
  if (ratio < lo || ratio > hi) problems.push(`length ratio ${ratio.toFixed(3)} outside ${lo}-${hi}`);
  if (expect.segments && (net.segments.length < expect.segments[0] || net.segments.length > expect.segments[1])) {
    problems.push(`${net.segments.length} segments, expected ${expect.segments.join('-')}`);
  }
  if (err.mean > (expect.meanErr ?? 3)) problems.push(`mean error ${err.mean.toFixed(1)} m`);
  if (err.worst > (expect.worstErr ?? 10)) problems.push(`worst error ${err.worst.toFixed(1)} m`);
  if (problems.length) failures++;
  console.log(
    `${problems.length ? 'FAIL' : 'ok  '} ${name.padEnd(44)} ridden ${net.stats.rawLength.toFixed(0).padStart(6)} m -> merged ${net.stats.mergedLength.toFixed(0).padStart(5)} m`
    + ` (true ${truthLen.toFixed(0)} m, x${ratio.toFixed(3)})  segs ${String(net.segments.length).padStart(2)}  pts ${String(net.stats.rawPoints).padStart(5)}->${String(net.stats.mergedPoints).padStart(4)}`
    + `  err ${err.mean.toFixed(1)}/${err.worst.toFixed(1)} m  ${ms.toFixed(0)} ms`,
  );
  for (const p of problems) console.log(`       - ${p}`);
  return net;
}

const track = (name, ...segments) => ({ name, segments });
const rev = (p) => p.slice().reverse();
const line = (x0, y0, x1, y1, n = 40) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);

// ---- synthetic shapes ---------------------------------------------------------------
{
  const a = line(-200, 0, 200, 0);
  check('straight out-and-back', [track('r', ride([...a, ...rev(a)], 1))], [a], { segments: [1, 1] });

  check('five passes, alternating direction',
    [1, 2, 3, 4, 5].map((s) => track('r' + s, ride(s % 2 ? a : rev(a), 10 + s))), [a], { segments: [1, 1], meanErr: 2 });

  const b = line(0, -150, 0, 150);
  check('crossing at 90 degrees', [track('a', ride(a, 21)), track('b', ride(b, 22))], [a, b], { segments: [2, 4] });

  const c = line(-170, -100, 170, 100);
  check('crossing at 30 degrees', [track('a', ride(a, 23)), track('c', ride(c, 24))], [a, c], { segments: [2, 5] });

  const far = line(-200, 25, 200, 25);
  check('parallel trails 25 m apart stay separate', [track('a', ride(a, 31)), track('far', ride(far, 32))], [a, far], { segments: [2, 2] });

  const near = line(-200, 3, 200, 3);
  check('same trail ridden 3 m off merges', [track('a', ride(a, 33)), track('near', ride(near, 34))], [a], { segments: [1, 1], ratio: [0.95, 1.05], meanErr: 4 });

  // T junction: ride the main trail, then a spur that leaves it half way along.
  const spur = line(0, 0, 60, 140);
  check('spur off a main trail (out and back)',
    [track('main', ride(a, 41)), track('spur', ride([...line(-120, 0, 0, 0), ...spur, ...rev(spur), ...line(0, 0, 120, 0)], 42))],
    [a, spur], { segments: [3, 3] });

  // Turn around in the middle of a trail and come back.
  const part = line(-200, 0, 40, 0);
  check('turn around part way', [track('r', ride([...part, ...rev(part)], 43))], [part], { segments: [1, 1] });

  // A loop ridden twice, starting from a stem.
  const loop = Array.from({ length: 73 }, (_, i) => [60 * Math.cos((i * 5 * Math.PI) / 180 + Math.PI) + 60, 60 * Math.sin((i * 5 * Math.PI) / 180 + Math.PI)]);
  const stem = line(-150, 0, 0, 0);
  check('stem + loop ridden twice + back',
    [track('r', ride([...stem, ...loop, ...loop, ...rev(stem)], 44))], [stem, loop], { segments: [2, 2] });

  // Stop for a while mid-trail (auto-pause off): a cluster of jittery fixes.
  const g = rng(99);
  const first = ride(line(-200, 0, 0, 0), 45), second = ride(line(0, 0, 200, 0), 46);
  const blob = Array.from({ length: 60 }, () => ({ ...toLL([g() * 2.5, g() * 2.5]), alt: 100 }));
  check('long stop mid-trail', [track('r', [...first, ...blob, ...second])], [a], { segments: [1, 1], ratio: [0.95, 1.08] });

  // Poor GPS needs a wider threshold: passes that disagree by more than the
  // threshold cannot be told apart from two separate trails.
  const noisy = [1, 2, 3].map((s) => track('n' + s, ride(a, 50 + s, { sigma: 5 })));
  check('poor GPS (5 m error), threshold 20 m', noisy, [a], { segments: [1, 1], ratio: [0.95, 1.1], meanErr: 6, worstErr: 15 }, { threshold: 20 });
}

// ---- trail width from repeated passes ---------------------------------------------------
// The rider's line is offset sideways by a known amount on each pass, so the true
// width (outermost lines apart + vehicle) is known and can be compared.
{
  const base = line(-200, 0, 200, 0);
  const lane = (dy) => base.map(([x, y]) => [x, y + dy]);
  function widthCheck(name, offsets, gps, expect, opts = {}) {
    const trueWidth = Math.max(...offsets) - Math.min(...offsets) + GRIZZLY_WIDTH;
    const widths = [], bases = new Set();
    for (let trial = 0; trial < 20; trial++) {
      const tracks = offsets.map((dy, k) => track('p' + k, ride(k % 2 ? rev(lane(dy)) : lane(dy), 900 + trial * 37 + k, gps)));
      const net = buildNetwork(tracks, { threshold: 8, smoothing: 3, ...opts });
      const seg = net.segments.reduce((a, b) => (b.length > a.length ? b : a));
      const w = estimateWidth(seg.spread);
      widths.push(w.width);
      bases.add(w.basis);
    }
    widths.sort((a, b) => a - b);
    const med = widths[widths.length >> 1], lo = widths[1], hi = widths[widths.length - 2];
    const ok = med >= expect[0] && med <= expect[1];
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} width: ${name.padEnd(42)} true ${trueWidth.toFixed(1)} m -> typical ${med.toFixed(1)} m`
      + ` (most runs ${lo.toFixed(1)}-${hi.toFixed(1)} m)  ${[...bases].join(', ')}`);
    if (!ok) console.log(`       - typical estimate outside ${expect[0]}-${expect[1]} m`);
  }
  const phone = { sigma: 2.5 }, good = { sigma: 0.6, jitter: 0.2 };
  widthCheck('one pass', [0], phone, [1.23, 1.23]);
  widthCheck('narrow trail, 2 passes, phone GPS', [0, 0], phone, [1.23, 3.5]);
  widthCheck('narrow trail, 6 passes, phone GPS', [0, 0.3, -0.3, 0.2, -0.2, 0], phone, [1.23, 3.5]);
  widthCheck('4 m track ridden edge to edge, phone GPS', [-1.4, 1.4, -1.4, 1.4, -1.4, 1.4], phone, [1.23, 5.5]);
  widthCheck('10 m wide lane, 6 passes, phone GPS', [-4.4, -2.6, -0.9, 0.9, 2.6, 4.4], phone, [6, 14], { threshold: 12 });
  widthCheck('10 m wide lane, 6 passes, survey-grade GPS', [-4.4, -2.6, -0.9, 0.9, 2.6, 4.4], good, [8, 12], { threshold: 12 });
  widthCheck('4 m track edge to edge, survey-grade GPS', [-1.4, 1.4, -1.4, 1.4, -1.4, 1.4], good, [3, 5]);
}

// ---- the real trail network -----------------------------------------------------------
const refPath = process.argv.slice(2).find((a) => !a.startsWith('--'))
  ?? fileURLToPath(new URL('../reference.kml', import.meta.url));
if (existsSync(refPath)) {
  const kml = readFileSync(refPath, 'utf8');
  const trails = {};
  for (const pm of kml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
    const name = /<name>(.*?)<\/name>/.exec(pm[1])?.[1];
    const parts = [...pm[1].matchAll(/<LineString>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)].map((m) =>
      m[1].trim().split(/\s+/).map((c) => { const [lon, lat] = c.split(',').map(Number); return toXY({ lat, lon }); }));
    if (parts.length) trails[name] = parts;
  }
  const T = (name, part = 0) => trails[name][part];
  /** The part of `path` between the points nearest to `from` and `to`. */
  const between = (path, from, to) => {
    const near = (p) => path.reduce((b, q, i) => (Math.hypot(q[0] - p[0], q[1] - p[1]) < Math.hypot(path[b][0] - p[0], path[b][1] - p[1]) ? i : b), 0);
    const i = near(from), j = near(to);
    return i <= j ? path.slice(i, j + 1) : path.slice(j, i + 1).reverse();
  };
  const end = (p) => p[p.length - 1];

  const teslin = T('Teslin');
  check('Teslin out and back', [track('r', ride([...teslin, ...rev(teslin)], 61))], [teslin], { segments: [1, 1] });

  // Three days of riding that overlap each other heavily.
  const hoot = T('Hootalinqua'), bucket = T('Bucket'), kluane = T('Kluane'), white = T('White Pass');
  const maple = T('Maple Meadow'), kings = T('Kings Throne'), moose = T('Moose Creek'), takhini = T('Takhini');
  const kluaneFromBucket = between(kluane, end(bucket), end(kluane));
  const whiteFromKluane = between(white, end(kluane), end(white));
  const teslinToHoot = between(teslin, teslin[0], hoot[0]);

  const day1 = [...teslin, ...rev(hoot), ...rev(teslinToHoot)];                       // Teslin, back up Hootalinqua, home along Teslin
  const day2 = [...bucket, ...kluaneFromBucket, ...whiteFromKluane, ...rev(maple)];   // Bucket, Kluane, White Pass, Maple Meadow
  const day3 = [...kings, ...moose, ...rev(takhini)];                                 // Kings Throne, Moose Creek, Takhini
  const day4 = [...rev(teslin), ...bucket, ...kluaneFromBucket];                      // repeat laps on another day
  const truths = [teslin, hoot, bucket, kluaneFromBucket, whiteFromKluane, maple, kings, moose, takhini,
    [end(kings), moose[0]], [teslin[0], bucket[0]]]; // plus the two straight hops between trail ends
  const days = [day1, day2, day3, day4].map((p, i) => track('Day ' + (i + 1), ride(p, 70 + i)));
  const net = check('four days over the real network', days, truths, { ratio: [0.95, 1.06], segments: [9, 22], worstErr: 12 });
  if (process.argv.includes('--list')) {
    for (const s of net.segments) console.log(`       ${s.id}  ${s.length.toFixed(0).padStart(5)} m  ${String(s.points.length).padStart(3)} pts  x${s.passes}  ${s.rides.join(', ')}`);
  }

  for (const threshold of [3, 5, 12, 20]) {
    check(`  same four days, threshold ${threshold} m`, days, truths,
      { ratio: threshold < 8 ? [0.95, 3] : [0.9, 1.06], worstErr: 25, meanErr: 5 }, { threshold });
  }
  for (const smoothing of [0, 10]) {
    check(`  same four days, smoothing ${smoothing}`, days, truths, { ratio: [0.93, 1.1], worstErr: 12 }, { smoothing });
  }
} else {
  console.log(`(no reference KML at ${refPath}: skipped the real-network checks)`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
