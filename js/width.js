// A rough trail width from repeated passes.
//
// Each pass is taken to clear a strip as wide as the vehicle, centred on the
// rider (where the phone is). So a trail is at least one vehicle wide, plus
// however far apart the passes ran from side to side.
//
// The catch is that GPS error pushes passes apart too, usually by more than
// the trail is wide. The phone reports how accurate each fix is, so the share
// of the side-to-side scatter that GPS error alone would produce is taken off
// first. What is left over, if anything, counts as real width.

/** Yamaha Grizzly EPS overall width: 48.4 in (2016-2023 models). */
export const GRIZZLY_WIDTH = 1.23;

/**
 * @param spread  { passes, range, sd, acc, length } from buildNetwork (metres)
 * @param vehicle vehicle width in metres
 * @returns { width, swept, passes, range, acc, vehicle, basis }
 *   width  best estimate of the trail width
 *   swept  outermost passes plus the vehicle, with no allowance for GPS error
 *   basis  'single'       ridden once: all that is known is the vehicle fitted
 *          'gps-limited'  passes differ by no more than GPS error explains
 *          'rough'        wider than GPS error explains, from 2 or 3 passes
 *          'measured'     wider than GPS error explains, from 4 or more passes
 *          'uncorrected'  no GPS accuracy on record, so nothing could be taken off
 */
export function estimateWidth(spread, vehicle = GRIZZLY_WIDTH) {
  const out = { vehicle, passes: spread?.passes ?? 1, range: spread?.range ?? 0, acc: spread?.acc ?? null };
  if (out.passes < 2) return { ...out, width: vehicle, swept: vehicle, basis: 'single' };
  const swept = vehicle + out.range;
  if (out.acc == null) return { ...out, width: swept, swept, basis: 'uncorrected' };
  // The phone's accuracy figure is the radius holding 68% of fixes; side to side
  // that is a standard deviation of accuracy / 1.5.
  const gps = out.acc / 1.5;
  // GPS error drifts slowly, so a pass gives roughly one independent reading per
  // 100 m, not one per point. With that few readings the scatter can come out
  // well above its average by luck alone; `ceiling` is the level it would rarely
  // pass (about 1 time in 40) if the passes really were on the same line.
  const readings = (out.passes - 1) * Math.max(1, (spread.length ?? 0) / 100);
  const ceiling = gps * Math.sqrt(1 + 2 * Math.sqrt(2 / readings));
  if (spread.sd <= ceiling) return { ...out, width: vehicle, swept, basis: 'gps-limited' };
  const real = Math.sqrt(spread.sd ** 2 - gps ** 2);
  const extra = out.range * (real / spread.sd);
  if (extra < 0.5) return { ...out, width: vehicle, swept, basis: 'gps-limited' };
  return { ...out, width: vehicle + extra, swept, basis: out.passes >= 4 ? 'measured' : 'rough' };
}

const m = (v) => `${v.toFixed(1)} m`;

/** A few words for a list, e.g. "about 3.4 m wide". */
export function widthLabel(w) {
  if (w.basis === 'single') return `${m(w.width)} wide (1 pass)`;
  if (w.basis === 'gps-limited') return `${m(w.width)} wide (GPS-limited)`;
  return `about ${m(w.width)} wide${w.basis === 'rough' ? ' (rough)' : ''}`;
}

/** A full sentence explaining where the figure came from. */
export function widthNote(w) {
  switch (w.basis) {
    case 'single':
      return 'Ridden once, so all that is known is that the vehicle fitted.';
    case 'gps-limited':
      return `The ${w.passes} passes ran ${m(w.range)} apart, which GPS error (about ±${Math.round(w.acc)} m) fully explains, so only the vehicle width can be claimed.`;
    case 'uncorrected':
      return `Outermost of ${w.passes} passes plus the vehicle. No GPS accuracy was recorded, so nothing was taken off for GPS error.`;
    default:
      return `The ${w.passes} passes ran ${m(w.range)} apart, more than GPS error (about ±${Math.round(w.acc)} m) explains.`
        + (w.basis === 'rough' ? ' Only a few passes: ride it again to firm this up.' : '');
  }
}
