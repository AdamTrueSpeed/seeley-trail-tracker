// Geometry helpers shared by the tracker, the merge engine and the map.

export const EARTH_R = 6371008.8;
const RAD = Math.PI / 180;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Great-circle distance in metres. */
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Length in metres of a list of {lat, lon} points. */
export function pathLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    d += haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  return d;
}

/**
 * Flat local map in metres around (lat0, lon0). Accurate to a few centimetres
 * over a property-sized area, which is all the merge maths needs.
 */
export function makeProjection(lat0, lon0) {
  const k = Math.cos(lat0 * RAD);
  return {
    lat0,
    lon0,
    x: (lon) => (lon - lon0) * RAD * EARTH_R * k,
    y: (lat) => (lat - lat0) * RAD * EARTH_R,
    lon: (x) => lon0 + x / (EARTH_R * k * RAD),
    lat: (y) => lat0 + y / (EARTH_R * RAD),
  };
}

/**
 * Ramer-Douglas-Peucker. Returns a Uint8Array flagging which points to keep;
 * the first and last are always kept.
 */
export function rdp(xs, ys, eps) {
  const n = xs.length;
  const keep = new Uint8Array(n);
  if (n === 0) return keep;
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop();
    const a = stack.pop();
    const ax = xs[a], ay = ys[a];
    const dx = xs[b] - ax, dy = ys[b] - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      let px = xs[i] - ax, py = ys[i] - ay;
      if (len2 > 0) {
        const t = clamp((px * dx + py * dy) / len2, 0, 1);
        px -= t * dx;
        py -= t * dy;
      }
      const d = px * px + py * py;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx > 0 && maxD > eps * eps) {
      keep[idx] = 1;
      stack.push(a, idx, idx, b);
    }
  }
  return keep;
}

/**
 * Re-space a line so its points sit `step` metres apart. The z values and the
 * optional second set of values ws (either may hold NaN) are interpolated.
 * The last point is always kept.
 */
export function resample(xs, ys, zs, step, ws = null) {
  const X = [xs[0]], Y = [ys[0]], Z = [zs[0]], W = ws ? [ws[0]] : null;
  let need = step; // distance still to travel before the next sample
  for (let i = 1; i < xs.length; i++) {
    const dx = xs[i] - xs[i - 1], dy = ys[i] - ys[i - 1];
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    let at = need;
    while (at <= len) {
      const t = at / len;
      X.push(xs[i - 1] + dx * t);
      Y.push(ys[i - 1] + dy * t);
      Z.push(zs[i - 1] + (zs[i] - zs[i - 1]) * t);
      if (W) W.push(ws[i - 1] + (ws[i] - ws[i - 1]) * t);
      at += step;
    }
    need = at - len;
  }
  const last = xs.length - 1, m = X.length - 1;
  const tail = Math.hypot(xs[last] - X[m], ys[last] - Y[m]);
  if (tail > step * 0.25 || m === 0) {
    X.push(xs[last]); Y.push(ys[last]); Z.push(zs[last]);
    if (W) W.push(ws[last]);
  } else {
    X[m] = xs[last]; Y[m] = ys[last]; Z[m] = zs[last];
    if (W) W[m] = ws[last];
  }
  return { X, Y, Z, W };
}
