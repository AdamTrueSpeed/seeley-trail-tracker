// Steps and a rough calorie figure.
//
// Steps come from the phone's motion sensor while walking (each step is a
// bump in how hard the phone is being pushed about). Calories are the usual
// rule of thumb: effort level (MET) x body weight x time, with the effort
// level set by the method of travel and the speed.

// ---- steps ---------------------------------------------------------------------

const BUMP = 1.1;       // m/s² above steady: a step is under way
const SETTLED = 0.3;    // m/s²: back down, ready for the next one
const MIN_GAP = 280;    // ms: nobody steps faster than about 3.5 times a second
const STRIDE = 0.75;    // m: average walking step, for when there is no motion sensor

export class StepDetector {
  constructor() {
    this.count = 0;
    this.steady = null; // slow average of the reading: gravity
    this.bump = 0;      // quick average of what is left: movement
    this.high = false;
    this.lastStep = -Infinity;
    this.lastT = null;
  }

  /**
   * Feed one accelerometer reading (m/s², gravity included) with its time in
   * ms. Returns true if this reading completed a step.
   */
  feed(x, y, z, t) {
    const m = Math.hypot(x, y, z);
    const dt = this.lastT == null ? 0.016 : Math.min(0.2, Math.max(0.001, (t - this.lastT) / 1000));
    this.lastT = t;
    if (this.steady == null) this.steady = m;
    this.steady += (m - this.steady) * (1 - Math.exp(-dt / 1.0));
    this.bump += ((m - this.steady) - this.bump) * (1 - Math.exp(-dt / 0.06));
    if (!this.high && this.bump > BUMP && t - this.lastStep >= MIN_GAP) {
      this.high = true;
      this.lastStep = t;
      this.count++;
      return true;
    }
    if (this.high && this.bump < SETTLED) this.high = false;
    return false;
  }
}

/** Steps guessed from distance alone (no sensor, or permission refused). */
export const stepsFromDistance = (metres) => Math.round(metres / STRIDE);

/**
 * Start listening to the phone's motion sensor. iPhones ask the user first,
 * and only allow the question straight after a tap. Resolves with a function
 * that stops listening, or null if the sensor is not available or was refused.
 */
export async function watchMotion(onReading) {
  if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') return null;
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      if (await DeviceMotionEvent.requestPermission() !== 'granted') return null;
    } catch {
      return null;
    }
  }
  const handler = (e) => {
    const a = e.accelerationIncludingGravity;
    if (a && a.x != null) onReading(a.x, a.y, a.z, e.timeStamp || performance.now());
  };
  window.addEventListener('devicemotion', handler);
  return () => window.removeEventListener('devicemotion', handler);
}

// ---- calories --------------------------------------------------------------------

/**
 * Effort level (MET: 1 = sitting still) for a way of travelling at a speed.
 * Figures are from the Compendium of Physical Activities, rounded.
 * effort: 'foot' | 'bike' | 'atv' (straddling and steering a machine) | 'drive' (sitting in one)
 */
export function metFor(effort, kmh) {
  switch (effort) {
    case 'foot':
      return kmh < 1 ? 1.5 : kmh < 3.2 ? 2.8 : kmh < 4.8 ? 3.5 : kmh < 5.6 ? 4.3 : kmh < 6.4 ? 5 : kmh < 8 ? 7 : 9;
    case 'bike':
      return kmh < 2 ? 1.5 : kmh < 16 ? 4 : kmh < 19 ? 6.8 : kmh < 22.5 ? 8 : 10;
    case 'drive':
      return 2.5;
    default:
      return kmh < 1 ? 1.5 : 3.7;
  }
}

/** Which effort table a method of travel uses. */
export function effortOf(method) {
  if (method.effort) return method.effort;
  return method.kind === 'foot' ? 'foot' : method.kind === 'bike' ? 'bike' : 'atv';
}

/** kcal for travelling `seconds` at `kmh`. */
export const kcalFor = (effort, kmh, seconds, weightKg) => (metFor(effort, kmh) * weightKg * seconds) / 3600;

/**
 * Rough kcal for a whole ride, from its recorded points. Time spent stopped
 * (a gap between points) is not counted.
 * @param segments [[{ t, spd }]]  spd in m/s
 */
export function kcalOfRide(segments, method, weightKg) {
  const effort = effortOf(method);
  let kcal = 0;
  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) {
      const dt = (seg[i].t - seg[i - 1].t) / 1000;
      if (dt > 0 && dt <= 15) kcal += kcalFor(effort, (seg[i].spd ?? 0) * 3.6, dt, weightKg);
    }
  }
  return kcal;
}
