// Comparing GPS rides with an existing trail map (imported KML/KMZ):
// which named trail a surveyed segment follows, and how much of each named
// trail has been ridden so far.

import { makeProjection } from './geo.js';

const SAMPLE = 5; // metres between comparison points

/** Call fn(x, y) every `step` metres along a line of [x, y] points. */
function along(pts, step, fn) {
  if (!pts.length) return;
  fn(pts[0][0], pts[0][1]);
  let need = step;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
    const len = Math.hypot(dx, dy);
    let at = need;
    while (at <= len) {
      fn(pts[i - 1][0] + (dx * at) / len, pts[i - 1][1] + (dy * at) / len);
      at += step;
    }
    need = at - len;
  }
}

class PointGrid {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  key(ix, iy) { return (ix + 32768) * 65536 + (iy + 32768); }
  add(x, y, tag) {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    const list = this.map.get(k);
    if (list) list.push(x, y, tag); else this.map.set(k, [x, y, tag]);
  }
  /** Tag of the nearest point within `radius` (radius must not exceed the cell size), or -1. */
  nearest(x, y, radius) {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    let best = -1, bestD2 = radius * radius;
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iy = cy - 1; iy <= cy + 1; iy++) {
        const list = this.map.get(this.key(ix, iy));
        if (!list) continue;
        for (let m = 0; m < list.length; m += 3) {
          const d2 = (list[m] - x) ** 2 + (list[m + 1] - y) ** 2;
          if (d2 <= bestD2) { bestD2 = d2; best = list[m + 2]; }
        }
      }
    }
    return best;
  }
}

/** Index the named trails of an imported map (the property boundary is left out). */
export function prepareReference(ref) {
  const trails = (ref?.lines ?? []).filter((l) => !l.boundary);
  const origin = trails[0]?.parts[0]?.[0];
  if (!origin) return null;
  const proj = makeProjection(origin[0], origin[1]);
  const grid = new PointGrid(20);
  const out = trails.map((t, ti) => {
    const samples = [];
    for (const part of t.parts) {
      along(part.map(([lat, lon]) => [proj.x(lon), proj.y(lat)]), SAMPLE, (x, y) => {
        samples.push(x, y);
        grid.add(x, y, ti);
      });
    }
    return { name: t.name, color: t.color, samples };
  });
  return { proj, trails: out, grid };
}

/**
 * Set seg[field] to the name of the indexed trail each segment mostly follows
 * (or null). When two trails tie, the one listed first wins.
 */
export function nameSegments(segments, prepared, maxDist = 20, field = 'ref') {
  for (const seg of segments) {
    seg[field] = null;
    if (!prepared) continue;
    const votes = new Map();
    let total = 0;
    along(seg.points.map((p) => [prepared.proj.x(p.lon), prepared.proj.y(p.lat)]), SAMPLE, (x, y) => {
      total++;
      const ti = prepared.grid.nearest(x, y, maxDist);
      if (ti >= 0) votes.set(ti, (votes.get(ti) ?? 0) + 1);
    });
    let best = -1, bestN = 0;
    for (const [ti, n] of votes) if (n > bestN || (n === bestN && ti < best)) { bestN = n; best = ti; }
    if (best >= 0 && bestN >= total * 0.5) seg[field] = prepared.trails[best].name;
  }
}

/** Share (0 to 1) of line a that runs within maxDist metres of line b. Both are [[lat, lon]]. */
export function overlapShare(a, b, maxDist = 12) {
  if (!a.length || !b.length) return 0;
  const proj = makeProjection(a[0][0], a[0][1]);
  const xy = (pts) => pts.map(([lat, lon]) => [proj.x(lon), proj.y(lat)]);
  const near = new PointGrid(maxDist);
  along(xy(b), SAMPLE / 2, (x, y) => near.add(x, y, 1));
  let n = 0, hit = 0;
  along(xy(a), SAMPLE, (x, y) => {
    n++;
    if (near.nearest(x, y, maxDist) >= 0) hit++;
  });
  return n ? hit / n : 0;
}

/**
 * How much of each named trail has a GPS track within `maxDist` of it.
 * @param tracks [{ segments: [[{lat, lon}]] }]
 * @returns [{ name, color, length, pct }]
 */
export function coverage(prepared, tracks, maxDist = 15) {
  if (!prepared) return [];
  const ridden = new PointGrid(maxDist);
  for (const t of tracks) {
    for (const seg of t.segments) {
      along(seg.map((p) => [prepared.proj.x(p.lon), prepared.proj.y(p.lat)]), SAMPLE, (x, y) => ridden.add(x, y, 1));
    }
  }
  return prepared.trails.map((t) => {
    const n = t.samples.length / 2;
    let hit = 0;
    for (let m = 0; m < t.samples.length; m += 2) {
      if (ridden.nearest(t.samples[m], t.samples[m + 1], maxDist) >= 0) hit++;
    }
    return { name: t.name, color: t.color, length: Math.max(0, n - 1) * SAMPLE, pct: n ? Math.round((100 * hit) / n) : 0 };
  });
}
