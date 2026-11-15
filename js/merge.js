// Turns many overlapping GPS tracks into one clean trail network.
//
// Each track is walked point by point. A point that falls within the merge
// threshold of trail already in the network is folded into that trail and
// nudges its centreline toward the average of every pass; a point that does
// not becomes new trail. Riding out and back, repeating a lap or crossing an
// earlier track therefore never adds a second line. The result is smoothed,
// split at junctions and simplified with Ramer-Douglas-Peucker.

import { makeProjection, haversine, rdp, resample, clamp } from './geo.js';

/**
 * @param tracks [{ name, segments: [[{lat, lon, alt}]] }] in the order ridden
 * @param opts   { threshold: metres, smoothing: 0..10 }
 * @returns { segments: [{ id, points, length, passes, sources, rides }], stats }
 */
export function buildNetwork(tracks, opts = {}) {
  const T = clamp(opts.threshold ?? 8, 1, 100);
  const level = clamp(opts.smoothing ?? 3, 0, 10);

  const step = clamp(T / 3, 1.5, 3);      // spacing of the working points
  const R_STAY = T * 1.5;                 // once following a trail, stay on it out to here
  const NEAR = T / 3;                     // "right on the trail"
  const LOOK = T * 3;                     // how far to look for a clean junction
  const S_EXCL = Math.max(3 * T, 25);     // the track's own last few metres are not "another trail"
  const HEAD_K = Math.max(1, Math.round(4 / step));
  const cell = R_STAY;

  const stats = { rawLength: 0, rawPoints: 0, mergedLength: 0, mergedPoints: 0, threshold: T };
  const origin = tracks.flatMap((t) => t.segments).find((s) => s.length)?.[0];
  if (!origin) return { segments: [], stats };
  const proj = makeProjection(origin.lat, origin.lon);

  // ---- network nodes (parallel arrays) -----------------------------------
  const nx = [], ny = [];                 // position when first laid down (used for matching)
  const sx = [], sy = [], sz = [], zw = [], w = [];  // one entry per completed pass over the node
  const cx = [], cy = [], cz = [], cn = [], czn = [], cPass = []; // the pass currently going over it
  const nChain = [], nIdx = [], nTrack = [], nS = [], nhx = [], nhy = [];
  const dead = [], junc = [], nUsers = [];
  const chains = [];
  const grid = new Map();
  const MAX_SKIP = 8;
  let passCounter = 0;

  /** Bank the pass in progress on a node as one vote for where the trail is. */
  const flush = (q) => {
    if (cn[q] > 0) {
      sx[q] += cx[q] / cn[q]; sy[q] += cy[q] / cn[q]; w[q]++;
      if (czn[q] > 0) { sz[q] += cz[q] / czn[q]; zw[q]++; }
    }
    cx[q] = cy[q] = cz[q] = cn[q] = czn[q] = 0;
    cPass[q] = -1;
  };

  const cellOf = (v) => Math.floor(v / cell) + 32768;

  /** Nearest live node within `radius`, ignoring the trail directly behind the rider. */
  function find(px, py, hx, hy, radius, ti, s) {
    let best = -1, bestD2 = radius * radius;
    const cx = cellOf(px), cy = cellOf(py);
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iy = cy - 1; iy <= cy + 1; iy++) {
        const arr = grid.get(ix * 65536 + iy);
        if (!arr) continue;
        for (let m = 0; m < arr.length; m++) {
          const q = arr[m];
          if (dead[q]) continue;
          const dx = nx[q] - px, dy = ny[q] - py;
          const d2 = dx * dx + dy * dy;
          if (d2 >= bestD2) continue;
          // Same ride, just laid, heading the same way: that is where we came
          // from, not a trail to merge with. (Opposite heading = doubling back.)
          if (nTrack[q] === ti && s - nS[q] < S_EXCL && hx * nhx[q] + hy * nhy[q] > -0.5) continue;
          best = q;
          bestD2 = d2;
        }
      }
    }
    return best < 0 ? null : { q: best, d: Math.sqrt(bestD2) };
  }

  function walk(X, Y, Z, S, HX, HY, ti) {
    const n = X.length;
    let state = 0;          // 0 start, 1 following existing trail, 2 laying new trail
    let chain = null;       // the new trail being laid
    let run = [];           // points folded into existing trail in the current stretch
    let pass = -1;          // id of that stretch: each stretch counts once per node
    let last = null;        // previous point folded in this stretch
    let convergeFrom = -1;  // where the current approach to an existing trail began

    const lay = (i) => {
      const q = nx.length;
      const hasZ = !Number.isNaN(Z[i]);
      nx.push(X[i]); ny.push(Y[i]);
      sx.push(X[i]); sy.push(Y[i]); sz.push(hasZ ? Z[i] : 0); zw.push(hasZ ? 1 : 0); w.push(1);
      cx.push(0); cy.push(0); cz.push(0); cn.push(0); czn.push(0); cPass.push(-1);
      nChain.push(chain.id); nIdx.push(chain.nodes.length);
      nTrack.push(ti); nS.push(S[i]); nhx.push(HX[i]); nhy.push(HY[i]);
      dead.push(0); junc.push(0); nUsers.push([ti]);
      const k = cellOf(X[i]) * 65536 + cellOf(Y[i]);
      const bucket = grid.get(k);
      if (bucket) bucket.push(q); else grid.set(k, [q]);
      const prev = chain.nodes[chain.nodes.length - 1];
      if (prev !== undefined) chain.len += Math.hypot(nx[prev] - X[i], ny[prev] - Y[i]);
      chain.nodes.push(q);
    };

    const foldAt = (e) => {
      const q = e.q;
      if (cPass[q] !== pass) { flush(q); cPass[q] = pass; }
      cx[q] += e.x; cy[q] += e.y; cn[q]++;
      if (!Number.isNaN(e.z)) { cz[q] += e.z; czn[q]++; }
      const users = nUsers[q];
      if (users[users.length - 1] !== ti) users.push(ti);
      run.push(e);
    };

    const fold = (q, i, d) => {
      // Nodes the track stepped over between the previous match and this one
      // get an in-between share, so every node hears from every pass.
      if (last && nChain[last.q] === nChain[q]) {
        const a = nIdx[last.q], b = nIdx[q], gap = Math.abs(b - a);
        if (gap > 1 && gap <= MAX_SKIP) {
          const nodes = chains[nChain[q]].nodes;
          for (let m = 1; m < gap; m++) {
            const node = nodes[a + (b > a ? m : -m)];
            if (node === undefined || dead[node] || nChain[node] !== nChain[q]) continue;
            const t = m / gap;
            foldAt({
              q: node, i: -1, s: S[i], d: Infinity,
              x: last.x + (X[i] - last.x) * t, y: last.y + (Y[i] - last.y) * t, z: last.z + (Z[i] - last.z) * t,
            });
          }
        }
      }
      last = { q, i, s: S[i], d, x: X[i], y: Y[i], z: Z[i] };
      foldAt(last);
      while (S[i] - run[0].s > LOOK) run.shift();
    };

    const unfold = (e) => {
      cx[e.q] -= e.x; cy[e.q] -= e.y; cn[e.q]--;
      if (!Number.isNaN(e.z)) { cz[e.q] -= e.z; czn[e.q]--; }
    };

    /** Finish the new trail being laid. q = the existing node it ran into, or -1 at the end of a track. */
    const closeChain = (q, i) => {
      const c = chain;
      chain = null;
      const first = c.j0 >= 0 ? 1 : 0;
      const kill = (from) => {
        if (from >= c.nodes.length) return;
        for (let m = from; m < c.nodes.length; m++) dead[c.nodes[m]] = 1;
        c.nodes.length = from;
      };
      const farthestFrom = (a, from) => {
        let best = from, bestD = -1;
        for (let m = from; m < c.nodes.length; m++) {
          const d = Math.hypot(nx[c.nodes[m]] - nx[a], ny[c.nodes[m]] - ny[a]);
          if (d > bestD) { bestD = d; best = m; }
        }
        return best;
      };

      if (q < 0) {
        // Track stopped right beside another trail: connect to it.
        const e = find(X[i], Y[i], HX[i], HY[i], T, ti, S[i]);
        if (e && nChain[e.q] !== c.id) { c.nodes.push(e.q); junc[e.q]++; }
      } else if (nChain[q] === c.id) {
        // Ran back into its own line: a turn-around hook, or a genuine loop.
        const iq = c.nodes.indexOf(q);
        let P = 0, A = 0;
        for (let m = iq; m < c.nodes.length; m++) {
          const a = c.nodes[m];
          const b = c.nodes[m + 1 < c.nodes.length ? m + 1 : iq];
          P += Math.hypot(nx[b] - nx[a], ny[b] - ny[a]);
          A += nx[a] * ny[b] - nx[b] * ny[a];
        }
        const compact = P > 0 ? (2 * Math.PI * Math.abs(A)) / (P * P) : 0;
        if (P < 3 * T || (compact < 0.2 && P < 12 * T)) kill(farthestFrom(q, iq + 1) + 1);
        else { c.nodes.push(q); junc[q]++; }
      } else if (c.j0 >= 0) {
        const last = c.nodes[c.nodes.length - 1];
        const len = c.len + Math.hypot(nx[last] - nx[q], ny[last] - ny[q]);
        if (len < 3 * T) {
          const gap = Math.hypot(nx[c.j0] - nx[q], ny[c.j0] - ny[q]);
          if (gap >= 0.5 * len) kill(first);                 // brief wobble off the trail and back
          else kill(farthestFrom(c.j0, first) + 1);          // short out-and-back spur
        } else { c.nodes.push(q); junc[q]++; }
      } else { c.nodes.push(q); junc[q]++; }

      if (c.nodes.length <= first) {
        if (c.j0 >= 0) junc[c.j0]--;
        c.nodes.length = 0;
      }
    };

    for (let i = 0; i < n; i++) {
      const found = find(X[i], Y[i], HX[i], HY[i], state === 1 ? R_STAY : T, ti, S[i]);
      let c = found;

      if (state === 2) {
        if (!found) convergeFrom = -1;
        else {
          if (convergeFrom < 0) convergeFrom = S[i];
          if (found.d > NEAR && S[i] - convergeFrom < LOOK && i + 1 < n) {
            // Closing in on an existing trail (or only brushing past it): keep
            // laying new trail until the two actually meet, so the junction is clean.
            const next = find(X[i + 1], Y[i + 1], HX[i + 1], HY[i + 1], T, ti, S[i + 1]);
            if (!next || next.d < found.d) c = null;
          }
        }
      }

      if (c) {
        if (state === 2) closeChain(c.q, i);
        if (state !== 1) { run = []; last = null; pass = ++passCounter; }
        state = 1;
        convergeFrom = -1;
        fold(c.q, i, c.d);
      } else {
        if (state !== 2) {
          chain = { id: chains.length, nodes: [], len: 0, j0: -1 };
          chains.push(chain);
          if (state === 1 && run.length) {
            // Leaving an existing trail: branch from where the track was last
            // right on it, and take back the points folded in after that.
            let k = run.length - 1;
            while (k >= 0 && run[k].d > NEAR) k--;
            if (k < 0) k = run.length - 1;
            for (let m = run.length - 1; m > k; m--) unfold(run[m]);
            chain.j0 = run[k].q;
            chain.nodes.push(chain.j0);
            junc[chain.j0]++;
            for (let m = k + 1; m < run.length; m++) if (run[m].i >= 0) lay(run[m].i);
          }
          run = [];
          last = null;
          state = 2;
          convergeFrom = -1;
        }
        lay(i);
      }
    }
    if (state === 2) closeChain(-1, n - 1);
  }

  // ---- walk every track ----------------------------------------------------
  let sBase = 0;
  tracks.forEach((track, ti) => {
    for (const seg of track.segments) {
      if (seg.length < 2) continue;
      stats.rawPoints += seg.length;
      const r = resample(
        seg.map((p) => proj.x(p.lon)),
        seg.map((p) => proj.y(p.lat)),
        seg.map((p) => (p.alt == null ? NaN : p.alt)),
        step,
      );
      const n = r.X.length;
      if (n < 2) continue;
      const S = new Float64Array(n);
      S[0] = sBase;
      for (let i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(r.X[i] - r.X[i - 1], r.Y[i] - r.Y[i - 1]);
      stats.rawLength += S[n - 1] - sBase;
      sBase = S[n - 1] + 10 * S_EXCL;
      const HX = new Float64Array(n), HY = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - HEAD_K), b = Math.min(n - 1, i + HEAD_K);
        const dx = r.X[b] - r.X[a], dy = r.Y[b] - r.Y[a];
        const len = Math.hypot(dx, dy);
        if (len > 0) { HX[i] = dx / len; HY[i] = dy / len; }
      }
      walk(r.X, r.Y, r.Z, S, HX, HY, ti);
    }
  });

  // ---- settle each node at the average of every pass ---------------------------
  const N = nx.length;
  const fx = new Float64Array(N), fy = new Float64Array(N), fz = new Float64Array(N);
  for (let q = 0; q < N; q++) {
    flush(q);
    fx[q] = sx[q] / w[q];
    fy[q] = sy[q] / w[q];
    fz[q] = zw[q] > 0 ? sz[q] / zw[q] : NaN;
  }

  // ---- smooth along each trail (ends and their junctions stay put) -----------
  const gx = Float64Array.from(fx), gy = Float64Array.from(fy), gz = Float64Array.from(fz);
  const half = Math.round((level * 1.2) / step);
  if (half > 0) {
    for (const c of chains) {
      const a = c.nodes;
      for (let m = 1; m < a.length - 1; m++) {
        const k = Math.min(half, m, a.length - 1 - m);
        let X = 0, Y = 0, Zs = 0, Zn = 0;
        for (let j = m - k; j <= m + k; j++) {
          const p = a[j];
          X += fx[p]; Y += fy[p];
          if (!Number.isNaN(fz[p])) { Zs += fz[p]; Zn++; }
        }
        gx[a[m]] = X / (2 * k + 1);
        gy[a[m]] = Y / (2 * k + 1);
        gz[a[m]] = Zn ? Zs / Zn : NaN;
      }
    }
  }

  // ---- split at junctions ---------------------------------------------------------
  let edges = [];
  for (const c of chains) {
    const a = c.nodes;
    let start = 0;
    for (let m = 1; m < a.length; m++) {
      if (m === a.length - 1 || junc[a[m]] > 0) {
        edges.push(a.slice(start, m + 1));
        start = m;
      }
    }
  }

  const edgeLen = (e) => {
    let d = 0;
    for (let m = 1; m < e.length; m++) d += Math.hypot(gx[e[m]] - gx[e[m - 1]], gy[e[m]] - gy[e[m - 1]]);
    return d;
  };

  // ---- tidy: join pass-through points, drop leftover stubs --------------------------
  for (let changed = true; changed;) {
    changed = false;
    const ends = new Map(); // node -> [[edge, atStart]]
    const note = (q, e, atStart) => {
      const list = ends.get(q);
      if (list) list.push([e, atStart]); else ends.set(q, [[e, atStart]]);
    };
    for (const e of edges) { note(e[0], e, true); note(e[e.length - 1], e, false); }

    for (const [, list] of ends) {
      if (list.length !== 2 || list[0][0] === list[1][0]) continue;
      const [[a, aStart], [b, bStart]] = list;
      const head = aStart ? a.slice().reverse() : a;   // ends at the shared node
      const tail = bStart ? b : b.slice().reverse();   // starts at the shared node
      edges = edges.filter((e) => e !== a && e !== b);
      edges.push(head.concat(tail.slice(1)));
      changed = true;
      break;
    }
    if (changed) continue;

    // Two junctions closer together than the threshold are one junction.
    for (const e of edges) {
      const a = e[0], b = e[e.length - 1];
      if (a === b || ends.get(a).length < 3 || ends.get(b).length < 3 || edgeLen(e) >= T) continue;
      gx[a] = (gx[a] + gx[b]) / 2;
      gy[a] = (gy[a] + gy[b]) / 2;
      if (Number.isNaN(gz[a])) gz[a] = gz[b];
      edges = edges.filter((x) => x !== e);
      for (const x of edges) {
        if (x[0] === b) x[0] = a;
        if (x[x.length - 1] === b) x[x.length - 1] = a;
      }
      changed = true;
      break;
    }
    if (changed) continue;

    const kept = edges.filter((e) => {
      const a = e[0], b = e[e.length - 1];
      if (a === b) return true;
      const freeA = ends.get(a).length === 1, freeB = ends.get(b).length === 1;
      if (freeA !== freeB) return edgeLen(e) >= T;       // stub hanging off a junction
      if (freeA && freeB) return edgeLen(e) >= 2 * step; // isolated speck
      return true;
    });
    if (kept.length !== edges.length) { edges = kept; changed = true; }
  }

  // ---- simplify and convert back to latitude / longitude -----------------------------
  const eps = 0.3 + level * 0.45;
  const segments = edges.map((e, idx) => {
    const xs = e.map((q) => gx[q]), ys = e.map((q) => gy[q]);
    const keep = rdp(xs, ys, eps);
    const points = [];
    const users = new Set();
    let passes = 0;
    for (let m = 0; m < e.length; m++) {
      const q = e[m];
      passes += w[q];
      for (const ti of nUsers[q]) users.add(ti);
      if (keep[m]) {
        points.push({
          lat: proj.lat(ys[m]),
          lon: proj.lon(xs[m]),
          alt: Number.isNaN(gz[q]) ? null : Math.round(gz[q] * 10) / 10,
        });
      }
    }
    let length = 0;
    for (let m = 1; m < points.length; m++) {
      length += haversine(points[m - 1].lat, points[m - 1].lon, points[m].lat, points[m].lon);
    }
    stats.mergedLength += length;
    stats.mergedPoints += points.length;
    return {
      id: 'S' + String(idx + 1).padStart(2, '0'),
      points,
      length,
      passes: Math.round(passes / e.length),
      sources: [...users].sort((a, b) => a - b), // indexes into `tracks`
      rides: [...users].sort((a, b) => a - b).map((ti) => tracks[ti].name),
    };
  });

  return { segments, stats };
}
