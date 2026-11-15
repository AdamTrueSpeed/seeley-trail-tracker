// Simulated GPS, for trying the app at a desk: add ?demo to the address.
// It rides out and back along the first trail of the loaded map (or a made-up
// loop), with a few metres of GPS drift, one stop and the odd wild reading so
// the filters and the merge have something to do.

import { makeProjection } from './geo.js';

const SPEED = 5;      // metres per simulated second
const TICK = 150;     // real milliseconds per simulated second

function demoPath(ref) {
  const trail = ref?.lines.find((l) => !l.boundary)?.parts[0];
  if (trail?.length > 5) return [...trail, ...trail.slice().reverse()];
  const proj = makeProjection(44.9275, -75.818);
  const pts = [];
  for (let x = 0; x <= 300; x += 10) pts.push([x, 0]);
  for (let a = 0; a <= 360; a += 6) pts.push([360 - 60 * Math.cos((a * Math.PI) / 180), 60 * Math.sin((a * Math.PI) / 180)]);
  for (let x = 300; x >= 0; x -= 10) pts.push([x, 0]);
  return pts.map(([x, y]) => [proj.lat(y), proj.lon(x)]);
}

export function createDemoGeo(ref) {
  const path = demoPath(ref);
  const proj = makeProjection(path[0][0], path[0][1]);
  const xy = path.map(([lat, lon]) => [proj.x(lon), proj.y(lat)]);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const total = cum[cum.length - 1];
  const stopAt = total * 0.3;

  const timers = new Map();
  const t0 = Date.now();
  let nextId = 1, s = 0, k = 0, stopped = 0, bx = 2, by = -1.5, i = 1;

  const tick = (ok) => {
    k++;
    let v = SPEED;
    if (s >= stopAt && stopped < 14) { v = 0; stopped++; }
    if (s >= total) v = 0;
    s = Math.min(total, s + v);
    while (i < cum.length - 1 && cum[i] < s) i++;
    const f = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    const dx = xy[i][0] - xy[i - 1][0], dy = xy[i][1] - xy[i - 1][1];
    bx = bx * 0.94 + (Math.random() - 0.5) * 1.4;
    by = by * 0.94 + (Math.random() - 0.5) * 1.4;
    const leap = k % 47 === 0 ? 45 : 0;       // a fix that lands 45 m away
    const vague = k % 61 === 0;               // a fix the phone itself calls inaccurate
    ok({
      timestamp: t0 + k * 1000,
      coords: {
        latitude: proj.lat(xy[i - 1][1] + dy * f + by + leap),
        longitude: proj.lon(xy[i - 1][0] + dx * f + bx),
        altitude: 110 + 6 * Math.sin(s / 90),
        accuracy: vague ? 40 : 4 + Math.abs(bx),
        altitudeAccuracy: 6,
        speed: v,
        heading: v ? ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 : null,
      },
    });
  };

  return {
    watchPosition(ok) {
      const id = nextId++;
      timers.set(id, setInterval(() => tick(ok), TICK));
      return id;
    },
    clearWatch(id) {
      clearInterval(timers.get(id));
      timers.delete(id);
    },
  };
}
