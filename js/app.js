// Seeley Trail Tracker: screens and glue. The heavy lifting lives in
// tracker.js (GPS), merge.js (de-duplication), kml.js (export) and db.js (storage).

import { db, keepStorage } from './db.js';
import { Tracker } from './tracker.js';
import { MapView } from './mapview.js';
import { buildNetwork } from './merge.js';
import { buildKml, buildKmz, parseKml, readKmlFile, TRAIL_COLORS } from './kml.js';
import { prepareReference, nameSegments, coverage, overlapShare, indexConditions, conditionsAlong, conditionText } from './reference.js';
import { estimateWidth, widthLabel, VEHICLES, vehicleOf } from './width.js';
import { LiveShare, newCode, cleanCode, formatCode } from './share.js';
import { StepDetector, stepsFromDistance, watchMotion, kcalFor, kcalOfRide, effortOf, elevationOf, movingTimeOf, STOP_GAP } from './activity.js';
import { natureHunt, placesHunt, photoItem, placesReached, hintFor, foundCount, isComplete, encodeHunt, decodeHunt, REACH, NATURE_ITEMS } from './hunt.js';
import { sendPackage, cleanTransferCode } from './transfer.js';
import { syncNow, newSyncCode, cleanSyncCode, forgetSync } from './sync.js';
import { haversine } from './geo.js';
import { NATIVE, nativeGeo, nativeSave, installShare, openAppSettings } from './native.js';
import {
  CHALLENGE_KINDS, countsFor, newChallengeId, dayOf, addDays, lastDayOf, inChallenge, isOver, dayLabel, totalsByDay, standings, winnerOf,
  dailyWinners, challengeLink, readChallengeLink, createChallenge, fetchChallenge, postScores, sendInvites, fetchInvites,
} from './challenge.js';

const VERSION = '1.43';
// Where friends get the app. icons/qr.svg and icons/qr.png are this address as a
// QR code: if it ever changes, the two pictures have to be made again.
const REF_VERSION = '19'; // raise whenever reference.kml changes, so phones pick up the corrected map
const SHARE_URL ='https://seeley-trail-tracker.seeley-trails.workers.dev/'; // keep in step with version.json (tools/check-release.mjs checks it)
const PARAMS = new URLSearchParams(location.search);
const DEMO = PARAMS.has('demo');
// iPhone or iPad (an iPad calls itself a Mac with a touch screen). Adding ?ios
// to the address forces the iPhone behaviour, for trying it on a computer.
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || PARAMS.has('ios');
const INSTALLED = NATIVE || navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
installShare(); // inside the Android app, "share" buttons use the phone's share sheet (see native.js)
const SCREEN_TIP = IOS
  ? 'This iPhone would not let the app keep the screen on. While riding, set Settings > Display & Brightness > Auto-Lock to Never.'
  : 'This browser cannot keep the screen on by itself. Set your phone\'s screen timeout as long as it goes while riding.';
// The HEADINGS a pin or a photo can be filed under (a description is written under the heading: see describePin).
const PIN_LABELS = ['Trailhead', 'Point of interest', 'Trail marker', 'Hazard', 'Bridge', 'Intersection', 'Gate', 'Water crossing', 'Fallen tree', 'Viewpoint', 'Deer stand'];
const PHOTO_LABELS = [
  'Trailhead', 'Point of interest', 'Trail marker', 'Cool sight', 'Deer stand', 'Mushroom', 'Wildlife', 'Animal tracks', 'Big tree', 'Wildflowers',
  'Berry patch', 'Beaver dam', 'Creek or pond', 'Lookout', 'Old ruins', 'Campsite', 'Boundary marker', 'Trail damage',
];
// What a trail can be like underfoot. The rider picks one while recording and it sticks until changed.
const CONDITIONS = [
  'Forest trail - rocky', 'Forest trail - wet', 'Forest trail - dirt', 'Forest trail - leafy',
  'Walking path - gravel', 'Walking path - dirt', 'Walking path - grass', 'Walking path - paved', 'Walking path - wood chips',
  'Dry and firm', 'Grassy', 'Muddy', 'Rocky', 'Water', 'Sandy', 'Gravel', 'Roots',
  'Rutted', 'Overgrown', 'Washed out', 'Swampy', 'Snow', 'Icy',
];
const SAVED_COLOR = '#2fbf9f';
const RAW_COLOR = '#8a97a6';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- settings ---------------------------------------------------------------

const DEFAULTS = {
  threshold: 8, smoothing: 3,             // merge
  maxAcc: 15, minDist: 3, autoPause: true, keepAwake: true, // recording
  autoDark: 60,                           // seconds without a touch before the dark screen comes on while recording (0 = never)
  sharing: 'private',                     // who can see my position: 'private' | 'friends' | 'everyone'
  friends: [],                            // [{ code, name }]
  weightKg: 80,                           // for the rough calorie figure
  vehicle: 'grizzly',                     // what the last ride was on (see VEHICLES in width.js)
  color: 'orange', showRaw: true, showMerged: true, showRef: true, showWalked: false,
};
const readJson = (key) => { try { return JSON.parse(localStorage.getItem(key)) ?? {}; } catch { return {}; } };
const settings = { ...DEFAULTS, ...readJson('tt-settings') };
settings.friends = [...settings.friends];
const saveSettings = () => localStorage.setItem('tt-settings', JSON.stringify(settings));
// A random label for this phone, so other phones can tell two people apart. It is not a secret.
if (!settings.deviceId) {
  settings.deviceId = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
  saveSettings();
}

// ---- state ------------------------------------------------------------------

const state = {
  rides: [],            // ride records, oldest first
  tracks: new Map(),    // ride id -> segments [[{seg, lat, lon, alt, t, acc, spd}]]
  pins: [],
  ref: null,            // imported existing trail map
  refIndex: null,
  current: null,        // ride being recorded
  network: null,        // last merge result
  focusRide: null,      // ride highlighted on the merge map
  focusSeg: null,       // or the segment highlighted there
  branches: [],         // branch names given in the app: [{ name, pts: [[lat, lon]] }], newest first
  branchIndex: null,
  view: 'ride',
  goodAt: 0,            // when the last usable fix arrived (wall clock)
  fixAt: 0,
  hiddenAt: 0,
  gpsWanted: false,
  lastKml: null,
};

let tracker;
const rideMap = new MapView($('map-ride'));
const netMap = new MapView($('map-net'));
for (const name of ['ref', 'saved']) rideMap.setLayer(name, []);
for (const name of ['ref', 'raw', 'merged', 'focus']) netMap.setLayer(name, []);

// ---- formatting -------------------------------------------------------------

const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);
const fmtDur = (ms) => {
  const min = Math.max(0, Math.round(ms / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
};
const fmtDate = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const stamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};
const rideName = (r) => r.name || 'In progress';
const doneRides = () => state.rides.filter((r) => r.status === 'done');
const byName = (x) => x.by || 'Unknown';

// ---- methods of travel -------------------------------------------------------

/** The built-in methods plus any the user has added on this phone. */
const allMethods = () => [...VEHICLES, ...(settings.customVehicles ?? [])];

/**
 * What a ride was made on. A ride carries its own copy of the name, width and
 * kind, so it still reads correctly on a phone that does not have that method
 * (after a backup is restored) or after the method is removed.
 */
function methodOf(ride) {
  const known = allMethods().find((m) => m.key === ride?.vehicle);
  if (known) return known;
  if (ride?.vehicleName) {
    return { key: ride.vehicle, name: ride.vehicleName, short: ride.vehicleName, width: ride.vehicleWidth ?? vehicleOf().width, kind: ride.vehicleKind ?? 'motor' };
  }
  return vehicleOf(ride?.vehicle);
}
/** What one outing by this method is called: "walk", "run", "jog", or "ride" for anything you sit on or in. */
const nounOf = (ride) => methodOf(ride).noun ?? 'ride';
const capital = (s) => s[0].toUpperCase() + s.slice(1);
/** `seat` ('driver' or 'passenger') is kept only for a method with two seats side by side (see `seats` in width.js). */
const setMethod = (ride, m, seat) => {
  Object.assign(ride, { vehicle: m.key, vehicleName: m.name, vehicleWidth: m.width, vehicleKind: m.kind });
  if (m.seats && seat) ride.seat = seat;
  else delete ride.seat;
  return ride;
};
const SEATS = { driver: 'Driver seat', passenger: 'Passenger seat' };
/** " (passenger seat)" for a side-by-side outing that knows its seat, otherwise "". */
const seatText = (ride) => (SEATS[ride?.seat] ? ` (${SEATS[ride.seat].toLowerCase()})` : '');

/** "1.5", "150 cm", "60 in", "5 ft" -> metres (null if it makes no sense). A bare number over 4 is taken as inches. */
function parseWidth(text) {
  const m = /^\s*([\d.]+)\s*(m|cm|in|inch|inches|"|ft|feet|')?\s*$/i.exec(text.replace(',', '.'));
  if (!m) return null;
  let v = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (!Number.isFinite(v) || v <= 0) return null;
  if (unit === 'cm') v /= 100;
  else if (unit.startsWith('in') || unit === '"') v *= 0.0254;
  else if (unit.startsWith('f') || unit === "'") v *= 0.3048;
  else if (!unit && v > 4) v *= 0.0254;
  return v >= 0.2 && v <= 5 ? Math.round(v * 100) / 100 : null;
}

// ---- time ---------------------------------------------------------------------------
//
// Two figures for every ride. "Time" is the stopwatch: from the first recorded
// point to FINISH, leaving out whatever was spent on PAUSE. "Moving time"
// counts only the stretches where the rider was actually going somewhere.

/** The stopwatch's clock: the phone's own. (The simulated GPS of demo mode runs fast, so there its clock is used.) */
const clockNow = () => (DEMO && tracker?.lastFix ? tracker.lastFix.t : Date.now());

/** How long a ride took, in ms. For the ride being recorded it runs up to now. */
function timeOf(ride) {
  const live = ride === state.current;
  if (live && !ride.count) return 0; // the clock starts with the first recorded point
  const end = live ? (ride.pausedAt ?? clockNow()) : (ride.finishedAt ?? ride.endedAt ?? 0);
  return Math.max(0, end - (ride.clockAt ?? ride.startedAt ?? 0) - (ride.pausedMs ?? 0));
}

/** Time spent actually moving, in ms, from the ride's recorded points. */
const movingOf = (ride) => movingTimeOf(state.tracks.get(ride.id) ?? []);

/** Close off a pause that is under way (the ride is resumed, finished, or picked up again after the app closed). */
function endPause(ride, until = clockNow(), since = ride.pausedAt) {
  if (since) ride.pausedMs = (ride.pausedMs ?? 0) + Math.max(0, until - since);
  ride.pausedAt = null;
}

const fmtSpeed = (metres, ms) => (ms > 0 ? `${(metres / (ms / 3600000) / 1000).toFixed(1)} km/h` : '');

/** Distance, time and ride count for each method of travel, furthest first. */
function totalsByMethod(rides) {
  const by = new Map();
  for (const r of rides) {
    const name = methodOf(r).name;
    const e = by.get(name) ?? by.set(name, { name, noun: nounOf(r), rides: 0, dist: 0, time: 0, moving: 0, kcal: 0, steps: 0 }).get(name);
    e.rides++;
    e.dist += r.dist ?? 0;
    e.time += timeOf(r);
    e.moving += movingOf(r);
    e.kcal += kcalOf(r);
    e.steps += stepsOf(r) ?? 0;
  }
  return [...by.values()].sort((a, b) => b.dist - a.dist);
}

// ---- steps and calories ------------------------------------------------------------

/** Rough kcal for a saved ride, worked out from its points and the user's weight. */
const kcalOf = (ride) => kcalOfRide(state.tracks.get(ride.id) ?? [], methodOf(ride), settings.weightKg);

/** Steps for a ride on foot (counted by the phone, or guessed from distance); null for anything else. */
function stepsOf(ride) {
  if (methodOf(ride).kind !== 'foot') return null;
  return ride.steps ?? stepsFromDistance(ride.dist ?? 0);
}
const stepsText = (ride) => {
  const n = stepsOf(ride);
  if (n == null) return '';
  return `${ride.steps == null || ride.stepsEstimated ? '~' : ''}${n.toLocaleString()} steps`;
};
const fmtKcal = (kcal) => `~${Math.round(kcal).toLocaleString()} kcal`;
const fmtClock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
/** The same, without the hours until there are some: "12:34", then "1:02:34". */
const fmtStopwatch = (ms) => fmtClock(ms).replace(/^0:0?/, '');

// While a ride is being recorded.
const activity = { detector: null, stopMotion: null, sensor: false, kcal: 0, moving: 0 };

/** Start counting for the current ride. Call straight after the tap that starts it (iPhones only allow the motion-sensor question then). */
async function startActivity(ride) {
  stopActivity();
  activity.kcal = kcalOf(ride); // not zero when an unfinished ride is being continued
  activity.moving = movingOf(ride);
  activity.sensor = false;
  if (methodOf(ride).kind !== 'foot') return;
  const detector = new StepDetector();
  if (!ride.stepsEstimated) detector.count = ride.steps ?? 0;
  activity.detector = detector;
  activity.stopMotion = await watchMotion((x, y, z, t) => {
    activity.sensor = true; // the phone has a working motion sensor
    if (tracker.state === 'recording') detector.feed(x, y, z, t);
  });
}

function stopActivity() {
  activity.stopMotion?.();
  activity.stopMotion = null;
  activity.detector = null;
}

/** Keep the ride's own step figure up to date (it is saved with the ride). */
function noteSteps(ride) {
  if (methodOf(ride).kind !== 'foot') return;
  ride.stepsEstimated = !activity.sensor;
  ride.steps = activity.sensor ? activity.detector.count : stepsFromDistance(tracker.dist);
}

function updateActivity() {
  const ride = state.current;
  $('activity').hidden = !ride;
  if (!ride) {
    $('cond-pill').hidden = true;
    return;
  }
  noteSteps(ride);
  $('act-moving').textContent = `moving ${fmtStopwatch(activity.moving)}`;
  $('act-steps').textContent = stepsText(ride);
  $('act-kcal').textContent = fmtKcal(activity.kcal);
  const elev = elevationOf(state.tracks.get(ride.id) ?? []);
  $('act-elev').textContent = elev ? `↕ ${Math.round(elev.diff)} m` : '';
  $('act-pts').textContent = `${tracker.count} pts`;
  const pill = $('cond-pill');
  pill.hidden = false;
  pill.textContent = `TRAIL: ${ride.cond ? ride.cond.toUpperCase() : 'NOT SET'}`;
  pill.classList.toggle('set', !!ride.cond);
}

// ---- elevation ---------------------------------------------------------------------

/** Highest and lowest point of a saved ride, from its GPS heights (null if there are too few). */
const elevOf = (ride) => elevationOf(state.tracks.get(ride.id) ?? []);

/** How far a ride went under each trail condition: [{ cond, dist }], longest first. */
function conditionsOfRide(ride) {
  const by = new Map();
  for (const seg of state.tracks.get(ride.id) ?? []) {
    for (let i = 1; i < seg.length; i++) {
      if (!seg[i].cond) continue;
      by.set(seg[i].cond, (by.get(seg[i].cond) ?? 0) + haversine(seg[i - 1].lat, seg[i - 1].lon, seg[i].lat, seg[i].lon));
    }
  }
  return [...by].map(([cond, dist]) => ({ cond, dist })).sort((a, b) => b.dist - a.dist);
}

/** The end-of-ride report, one fact per line. */
function reportLines(ride) {
  const m = methodOf(ride), elev = elevOf(ride), conds = conditionsOfRide(ride);
  const time = timeOf(ride), moving = movingOf(ride);
  return [
    `${m.name} · ${fmtDate(ride.startedAt)} · ${byName(ride)}`,
    `Distance: ${fmtDist(ride.dist)}`,
    `Time: ${fmtClock(time)}`,
    `Moving time: ${fmtClock(moving)}${time > moving + 30000 ? ` (stopped for ${fmtDur(time - moving)})` : ''}`,
    moving > 0 ? `Average speed while moving: ${fmtSpeed(ride.dist, moving)}` : null,
    stepsOf(ride) != null ? `Steps: ${stepsText(ride).replace(' steps', '')}` : null,
    `Calories: ${fmtKcal(kcalOf(ride))}`,
    elev ? `Highest point: ${Math.round(elev.high)} m` : 'Elevation: not enough GPS height readings',
    elev ? `Lowest point: ${Math.round(elev.low)} m` : null,
    elev ? `Elevation difference: ${Math.round(elev.diff)} m` : null,
    conds.length ? `Trail conditions: ${conds.map((c) => `${c.cond} ${fmtDist(c.dist)}`).join(', ')}` : null,
    elev ? 'Heights come from the phone\'s GPS and are rough: the difference is more reliable than the figures themselves.' : null,
  ].filter(Boolean);
}

/** @param dare offer to challenge friends to beat it (for an outing just finished) */
/**
 * The summary of a walk or ride. With `saved` it is also the confirmation that
 * the outing just finished has been kept: the "Saved" pop-up alone is hidden
 * behind this screen, which left it unclear whether FINISH had worked.
 */
async function showReport(ride, dare = false, saved = false) {
  const res = await ask({
    title: saved ? `Saved: ${ride.name}` : ride.name,
    body: (saved ? `✓ Finished and saved on this ${NATIVE ? 'phone' : 'device'}.\n\n` : '') + reportLines(ride).join('\n'),
    buttons: [{ label: 'OK', value: 'cancel', cls: 'go' }, ...(dare ? [{ label: 'CHALLENGE FRIENDS TO BEAT IT', value: 'dare', cls: 'info' }] : [])],
  });
  if (res.button === 'dare') await quickDare(ride);
  if (saved) await offerSync(ride);
}

/**
 * Straight after an outing is saved: ask whether to send it to the cloud now,
 * and say how that went. (It used to be left to a background sync, which this
 * very summary screen was holding up, so it often had to be done by hand.)
 */
async function offerSync(ride) {
  const noun = nounOf(ride), here = NATIVE ? 'phone' : 'device';
  const ok = [{ label: 'OK', value: 'cancel', cls: 'go' }];
  if (!navigator.onLine) {
    await ask({
      title: 'Stored on your ' + here,
      body: `Right now, this ${noun} is stored on your ${here} only, and there is no signal to upload it. `
        + (cloud.code ? 'It will go to the cloud by itself the next time the app is open with a signal.'
          : 'To keep a copy in the cloud, turn on cloud sync under Merge & export when you have a signal.'),
      buttons: ok,
    });
    return;
  }
  // Chosen "always": no question, it just goes (and says so). Changed under Merge & export > Cloud sync.
  if (cloud.code && settings.autoUpload) {
    toast('Uploading to the cloud…', 20000);
    await runSync(true);
    if (cloud.error) {
      await ask({
        title: 'The upload did not get through',
        body: `Your ${noun} is still safe on this ${here}. The app will keep trying by itself (${cloud.error}).`,
        buttons: ok,
      });
    } else toast(`✓ Uploaded: your ${noun} is now in the cloud as well as on this ${here}.`, 6000);
    return;
  }
  // Otherwise asked every time, whether or not cloud sync is on yet (the owner, 2026-11-18: with sync off nothing was asked at all).
  const res = await ask({
    title: 'Upload to the cloud?',
    body: `Right now, this ${noun} is stored on your ${here} only. Would you like to upload it to the cloud?`
      + (cloud.code ? '' : `\n\nCloud sync is not turned on yet on this ${here}. Uploading turns it on.`)
      + '\n\nALWAYS UPLOAD does this by itself after every walk or ride from now on. You can switch that off again under Merge & export > Cloud sync.',
    buttons: [{ label: 'UPLOAD NOW', value: 'save', cls: 'go' }, { label: 'ALWAYS UPLOAD', value: 'always', cls: 'info' }, { label: 'Not now', value: 'cancel' }],
  });
  if (res.button === 'always') {
    settings.autoUpload = true;
    saveSettings();
    res.button = 'save';
  }
  if (res.button !== 'save') {
    toast(cloud.code ? 'Not uploaded yet. It will upload by itself later, or use Merge & export > Cloud sync > Sync now.'
      : `Kept on your ${here} only. You can turn on cloud sync any time under Merge & export.`, 6000);
    return;
  }
  if (!cloud.code) {
    // First time on this device: a new cloud copy, or the one the family already has. Joining keeps everything together.
    const how = await ask({
      title: 'Are your walks already in the cloud?',
      body: 'If you already use cloud sync on another phone, a computer or the web version, choose I HAVE A CODE so everything stays together. '
        + 'You get the code there under Merge & export > Cloud sync > Add another phone or computer.\n\nIf this is your first time, choose START NEW.',
      buttons: [{ label: 'I HAVE A CODE', value: 'join', cls: 'go' }, { label: 'START NEW', value: 'save' }, { label: 'Cancel', value: 'cancel' }],
    });
    if (how.button === 'join') await joinSync();
    else if (how.button === 'save') await useSyncCode(cleanSyncCode(localStorage.getItem('tt-sync-code-last')) ?? newSyncCode());
    if (!cloud.code) { toast(`Kept on your ${here} only. You can turn on cloud sync any time under Merge & export.`, 6000); return; }
  } else {
    toast('Uploading…', 20000);
    await runSync(true);
  }
  await ask({
    title: cloud.error ? 'The upload did not get through' : 'Uploaded to the cloud',
    body: cloud.error
      ? `Your ${noun} is still safe on this ${here}. The app will keep trying by itself (${cloud.error}).`
      : `✓ Your ${noun} is now in the cloud as well as on this ${here}.`,
    buttons: ok,
  });
}

/**
 * Quick labels: the names typed most recently on this phone first, then the
 * standard ones for a pin or a photo.
 */
function quickLabels(standard) {
  const recent = Array.isArray(readJson('tt-pin-labels')) ? readJson('tt-pin-labels') : [];
  const seen = new Set();
  return [...recent, ...standard].filter((l) => !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()));
}
const pinLabels = () => quickLabels(PIN_LABELS);
const photoLabels = () => quickLabels(PHOTO_LABELS);

function rememberPinLabel(name) {
  const standard = [...PIN_LABELS, ...PHOTO_LABELS].map((l) => l.toLowerCase());
  if (/^(Pin|Photo) \d+$/.test(name) || standard.includes(name.toLowerCase())) return;
  const recent = quickLabels([]).filter((l) => l.toLowerCase() !== name.toLowerCase());
  localStorage.setItem('tt-pin-labels', JSON.stringify([name, ...recent].slice(0, 6)));
}

/** Who has recorded what: [{ name, rides, dist, pins }], busiest first. */
function contributorsOf(rides, pins) {
  const by = new Map();
  const entry = (name) => by.get(name) ?? by.set(name, { name, rides: 0, dist: 0, pins: 0 }).get(name);
  for (const r of rides) { const e = entry(byName(r)); e.rides++; e.dist += r.dist ?? 0; }
  for (const p of pins) entry(byName(p)).pins++;
  return [...by.values()].sort((a, b) => b.dist - a.dist || b.pins - a.pins);
}

// ---- small UI helpers -------------------------------------------------------

let toastTimer;
function toast(msg, ms = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function notice(msg) {
  const el = $('notice');
  el.textContent = msg ? `${msg}  (tap to hide)` : '';
  el.hidden = !msg;
}
$('notice').addEventListener('click', () => notice(''));

/**
 * Modal question. Resolves with { button, text }: the chosen button's value
 * (or 'cancel') and whatever is in the text box. Chips are quick answers:
 * tapping one puts it in the text box, where it can still be edited; with
 * `pick` set, tapping one is the answer ({ button: 'chip', text: the chip }).
 * A body with line breaks is shown as separate lines.
 */
function ask({ title, body = '', input = null, chips = [], buttons, focus = true, image = null, pick = false }) {
  const dlg = $('dlg'), inp = $('dlg-input');
  const make = (label, cls, type) => Object.assign(document.createElement('button'), { textContent: label, className: cls, type });
  $('dlg-title').textContent = title;
  $('dlg-body').textContent = body;
  $('dlg-body').hidden = !body;
  $('dlg-img').hidden = !image;
  if (image) $('dlg-img').src = image; else $('dlg-img').removeAttribute('src');
  inp.hidden = !input;
  inp.value = input?.value ?? '';
  inp.placeholder = input?.placeholder ?? '';
  return new Promise((resolve) => {
    // Answer the moment a button is tapped. (The dialog's own "close" event only
    // arrives with the next screen redraw, which is too late if the phone is
    // locked or the app is put away right after the tap.)
    const form = dlg.querySelector('form');
    const answer = (button) => {
      dlg.oncancel = form.onsubmit = null;
      if (dlg.open) dlg.close();
      resolve({ button, text: inp.value.trim() });
    };
    $('dlg-chips').classList.toggle('pick', pick);
    $('dlg-chips').replaceChildren(...chips.map((c) => {
      const b = make(c, '', 'button');
      b.addEventListener('click', () => {
        inp.value = c;
        if (pick) { answer('chip'); return; }
        for (const other of $('dlg-chips').children) other.classList.toggle('on', other === b);
      });
      return b;
    }));
    $('dlg-btns').replaceChildren(...buttons.map((b) => {
      const el = Object.assign(make(b.label, `big ${b.cls ?? 'ghost'}`, 'submit'), { value: b.value });
      el.addEventListener('click', (e) => {
        e.preventDefault();
        answer(b.value);
      });
      return el;
    }));
    // Enter / Done on the keyboard means the first button; Back or Esc means cancel.
    form.onsubmit = (e) => { e.preventDefault(); answer(buttons[0].value); };
    dlg.oncancel = () => answer('cancel');
    dlg.showModal();
    if (input && focus) { inp.focus(); inp.select(); } else dlg.focus();
  });
}

function download(name, text, type) {
  if (NATIVE) { // a page inside an app cannot download: hand the file to the share sheet instead
    nativeSave(name, text).catch(() => toast('That file could not be saved. Try again.', 5000));
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Hand a file to the user. On an iPhone that is the share sheet (Save to
 * Files, Google Earth, AirDrop, Mail), because downloads from an installed
 * web app are unreliable there; everywhere else it is a normal download.
 * Resolves 'shared', 'cancelled' or 'downloaded'.
 */
async function saveFile(name, text, type) {
  const file = new File([text], name, { type });
  if (IOS && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      // anything else: fall back to a download
    }
  }
  download(name, text, type);
  return 'downloaded';
}

// ---- loading ----------------------------------------------------------------

function toSegments(points) {
  const segs = [];
  let seg = null, id = null;
  for (const p of points) {
    if (p.seg !== id) { seg = []; segs.push(seg); id = p.seg; }
    seg.push(p);
  }
  return segs;
}

/** Totals for a ride, worked out from its points (used after a crash or a restore). */
function measure(segs) {
  let dist = 0, count = 0, first = null, last = null;
  for (const s of segs) {
    count += s.length;
    for (let i = 0; i < s.length; i++) {
      first ??= s[i];
      last = s[i];
      if (i) dist += haversine(s[i - 1].lat, s[i - 1].lon, s[i].lat, s[i].lon);
    }
  }
  return { dist, count, startedAt: first?.t, endedAt: last?.t, lastSeg: last?.seg ?? 0 };
}

async function loadAll() {
  state.rides = (await db.all('rides')).sort((a, b) => a.id - b.id);
  state.pins = (await db.all('pins')).sort((a, b) => a.t - b.t);
  state.tracks.clear();
  for (const r of state.rides) state.tracks.set(r.id, toSegments(await db.pointsOf(r.id)));
  state.ref = (await db.get('kv', 'reference')) ?? null;
  if (!localStorage.getItem('tt-ref-removed') && (!state.ref || localStorage.getItem('tt-ref-ver') !== REF_VERSION)) {
    // A trail map shipped alongside the app is loaded the first time, and again when
    // a corrected one is published. A different map the user loaded themself is left alone.
    try {
      const res = await fetch('reference.kml', { cache: 'no-store' });
      if (res.ok) {
        const fresh = parseKml(await res.text());
        if (!state.ref || state.ref.name === fresh.name) {
          state.ref = fresh;
          await db.put('kv', state.ref, 'reference');
          // With it comes a second file: the stretches of that map which have been walked or ridden with GPS.
          try {
            const walked = await fetch('walked.kml', { cache: 'no-store' });
            if (walked.ok) await db.put('kv', parseKml(await walked.text()), 'walked');
          } catch { /* none bundled: the GPS button stays hidden */ }
        }
        localStorage.setItem('tt-ref-ver', REF_VERSION);
      }
    } catch { /* none bundled, or offline: try again next time */ }
  }
  state.refIndex = prepareReference(state.ref);
  state.walked = state.ref ? ((await db.get('kv', 'walked')) ?? null) : null;
  state.branches = (await db.get('kv', 'branches')) ?? [];
  state.branchIndex = branchIndexOf(state.branches);
}

// ---- map layers -------------------------------------------------------------

function refLines(alpha) {
  if (!state.ref || !settings.showRef) return [];
  return state.ref.lines.flatMap((l) => l.parts.map((pts, i) => ({
    pts,
    color: l.boundary ? '#ffffff' : (l.color ?? '#9fb0c0'),
    width: l.boundary ? 1.5 : 2,
    dash: l.boundary ? null : [7, 5],
    alpha: l.boundary ? alpha * 0.7 : alpha,
    label: !l.boundary && i === 0 ? l.name : null,
  })));
}

/** A green glow under the stretches of the built-in map that GPS has been recorded along (the GPS button on the map). */
function walkedLines(alpha) {
  if (!state.walked || !state.ref || !settings.showRef || !settings.showWalked) return [];
  return state.walked.lines.flatMap((l) => l.parts.map((pts) => ({ pts, color: '#39ff14', width: 8, alpha })));
}

function refreshRideMap() {
  rideMap.setLayer('walked', walkedLines(0.6)); // first, so the map's own lines are drawn over it
  $('ride-walked').hidden = !state.walked || !state.ref;
  $('ride-walked').classList.toggle('on', !!settings.showWalked);
  rideMap.setLayer('ref', refLines(0.85));
  rideMap.setLabels(state.ref && settings.showRef ? state.ref.points : []);
  rideMap.setLayer('saved', doneRides().filter((r) => r.include).flatMap((r) =>
    (state.tracks.get(r.id) ?? []).map((pts) => ({ pts, color: SAVED_COLOR, width: 2.5 }))));
  rideMap.setPins(state.pins);
}

// ---- ride screen ------------------------------------------------------------

function updateStats() {
  const fresh = Date.now() - state.goodAt < 5000;
  const v = fresh && tracker.good && !tracker.autoPaused ? tracker.good.v * 3.6 : 0;
  $('st-speed').textContent = v < 10 ? v.toFixed(1) : Math.round(v);
  $('st-dist').textContent = ((state.current ? tracker.dist : 0) / 1000).toFixed(2);
  updateClock();
  updateActivity();
  updatePocket();
  const acc = $('st-acc'), fix = tracker.lastFix;
  if (!fix || Date.now() - state.fixAt > 10000) {
    acc.textContent = '--';
    acc.className = 'bad';
  } else {
    acc.textContent = fix.acc >= 100 ? '99+' : Math.round(fix.acc);
    acc.className = fix.acc <= settings.maxAcc * 0.55 ? 'good' : fix.acc <= settings.maxAcc ? 'fair' : 'bad';
  }
}

/** The stopwatch at the top of the ride screen. It has its own tick, once a second. */
function updateClock() {
  const el = $('st-time'), text = fmtStopwatch(state.current ? timeOf(state.current) : 0);
  el.textContent = text;
  el.classList.toggle('long', text.length > 5);
}

function updateStatus() {
  const el = $('status'), fix = tracker.lastFix, rec = tracker.state !== 'idle';
  const set = (text, cls) => { el.textContent = text; el.className = `status ${cls}`; };
  if (tracker.error === 'denied') set(NATIVE ? 'Location is off or blocked. Tap here to fix it.' : 'Location is blocked for this site', 'bad');
  else if (!state.gpsWanted) set('Press START to turn on GPS', 'wait');
  else if (!fix) set(tracker.error ? (NATIVE && tracker.errorText ? `GPS problem: ${tracker.errorText}` : 'No GPS signal yet') : 'Finding GPS…', tracker.error && NATIVE ? 'bad' : 'wait');
  else if (Date.now() - state.fixAt > 10000) set('GPS signal lost', 'bad');
  else if (tracker.state === 'paused') set('PAUSED', 'wait');
  else if (fix.acc > settings.maxAcc) set(rec ? `Weak GPS ±${Math.round(fix.acc)} m – not recording` : `Weak GPS ±${Math.round(fix.acc)} m`, 'bad');
  else if (rec && tracker.autoPaused) set('Stopped – auto-paused', 'wait');
  else if (rec) set(`● RECORDING · ${methodOf(state.current).short}`, 'rec');
  else set('GPS ready', 'ok');
}

function updateRideUi() {
  const rec = !!state.current;
  $('actions-idle').hidden = rec;
  $('actions-rec').hidden = !rec;
  const pause = $('btn-pause'), paused = tracker.state === 'paused';
  pause.textContent = paused ? 'RESUME' : 'PAUSE';
  pause.className = `big ${paused ? 'go' : 'warn'}`;
  updateStats();
  updateStatus();
}

let wake = null;
/** Hold (or let go of) the screen wake lock. Resolves false if the screen could not be kept on. */
async function setWake(on) {
  try {
    if (on && settings.keepAwake && !wake && document.visibilityState === 'visible') {
      if (!('wakeLock' in navigator)) return false;
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } else if (!on && wake) {
      const w = wake;
      wake = null;
      await w.release();
    }
    return true;
  } catch {
    return false; // refused, e.g. by battery saver
  }
}

/**
 * Inside the Android app: say plainly what location is used for, before the phone
 * asks for permission. Google Play requires this wording to be shown, and agreed to,
 * by anyone whose location is used with the screen off. Resolves true once agreed.
 */
async function discloseLocation() {
  if (!NATIVE || localStorage.getItem('tt-native-disclosed')) return true;
  const res = await ask({
    title: 'Your location',
    body: 'Seeley Trail Tracker collects location data to record the line of your walk or ride on the map, even when the app is closed or not in use, such as when the screen is off or another app is in front.\n\nThis only happens while you are recording: from the moment you press START until you press FINISH. A notification is shown the whole time.\n\nYour location stays on this phone unless you turn on cloud sync or location sharing yourself.',
    buttons: [{ label: 'I AGREE', value: 'save', cls: 'go' }, { label: 'No thanks', value: 'cancel' }],
  });
  if (res.button !== 'save') return false;
  localStorage.setItem('tt-native-disclosed', '1');
  return true;
}

function startGps() {
  if (NATIVE && !localStorage.getItem('tt-native-disclosed')) return; // not before the explanation above has been agreed to
  state.gpsWanted = true;
  if (NATIVE) localStorage.setItem('tt-native-gps', '1'); // asked for once: next time GPS comes on by itself
  tracker.watch();
  updateStatus();
}

/**
 * Ask what a ride is (or was) on. The one used last is the green button, and
 * a new method can be added on the spot. Resolves with the method, or null if
 * cancelled.
 */
async function chooseVehicle(title, current) {
  const res = await ask({
    title,
    body: 'This sets how wide a strip each pass counts for, and tunes the GPS to your speed.',
    buttons: [
      ...allMethods().map((v) => ({ label: v.name, value: v.key, cls: v.key === current ? 'go' : 'ghost' })),
      { label: '+ Add another…', value: 'add', cls: 'info' },
      { label: 'Cancel', value: 'cancel' },
    ],
  });
  if (res.button === 'add') return addMethod();
  return allMethods().find((v) => v.key === res.button) ?? null;
}

/**
 * In a side-by-side, which seat the phone rides on. The phone is off the
 * vehicle's middle, and the trail map allows for it. Resolves with 'driver',
 * 'passenger', or null if cancelled.
 */
async function chooseSeat(method, current) {
  const res = await ask({
    title: 'Which seat is the phone on?',
    body: `In the ${method.short}, the phone sits to one side of the middle. The map allows for it.`,
    buttons: [
      ...Object.entries(SEATS).map(([value, label]) => ({ label, value, cls: value === current ? 'go' : 'ghost' })),
      { label: 'Cancel', value: 'cancel' },
    ],
  });
  return SEATS[res.button] ? res.button : null;
}

/** Three quick questions (name, width, how it moves) to add a method of travel. Resolves with it, or null. */
async function addMethod() {
  const next = [{ label: 'NEXT', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }];
  const named = await ask({
    title: 'New method of travel',
    body: 'What is it called?',
    input: { placeholder: 'e.g. Tractor, Horse, Snowmobile' },
    buttons: next,
  });
  if (named.button !== 'save' || !named.text) return null;
  const name = named.text.slice(0, 30);
  const existing = allMethods().find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    toast(`"${existing.name}" is already on the list.`);
    return existing;
  }
  let width = null;
  while (width == null) {
    const res = await ask({
      title: `How wide is ${name}?`,
      body: 'In metres, or in inches like "60 in". Each pass counts as a strip this wide, centred on the phone.',
      input: { placeholder: 'e.g. 1.5 or 60 in' },
      chips: ['0.5 m', '0.8 m', '1.2 m', '1.5 m', '1.8 m', '2.2 m'],
      buttons: next,
    });
    if (res.button !== 'save') return null;
    width = parseWidth(res.text);
    if (width == null) toast('Type a width such as 1.5 or 60 in.');
  }
  const moves = await ask({
    title: `How does ${name} travel?`,
    body: `${width.toFixed(2)} m wide. This last answer tunes the GPS for its speed.`,
    buttons: [
      { label: 'Engine or motor', value: 'motor', cls: 'go' },
      { label: 'Pedal power (bike pace)', value: 'bike' },
      { label: 'On foot (walking pace)', value: 'foot' },
      { label: 'Cancel', value: 'cancel' },
    ],
  });
  if (moves.button === 'cancel') return null;
  const method = { key: `c${Date.now()}`, name, short: name, width, kind: moves.button, basis: 'added on this phone' };
  settings.customVehicles = [...(settings.customVehicles ?? []), method];
  saveSettings();
  prefsChanged();
  renderSettings();
  toast(`Added ${name}`);
  return method;
}

// ---- which trail system an outing belongs to -----------------------------------------
//
// The app grew up on one property, so every outing went into one trail network. An
// outing started well away from every trail system the phone knows (5 km) is asked
// about: another system already known, a new trail system, a new urban walk, a park,
// or a one-off. It is filed under that name (ride.system, ride.place) and is merged
// and exported with its own system, not with the home trails. Outings with no
// `system` belong to the home system.
const AWAY_KM = 5;
const PLACES = { trail: 'trail system', urban: 'urban walk', park: 'park or public trail', oneoff: 'one-off outings' };
const ONE_OFF = 'One-off outings';
const homeName = () => settings.systemName || suggestSystemName();

/** The middle of the home trails: of the loaded map, or else where the first home outing began. */
function homeSpot() {
  const pts = state.ref ? state.ref.lines.flatMap((l) => l.parts.flat()) : [];
  if (pts.length) return { lat: pts.reduce((a, p) => a + p[0], 0) / pts.length, lon: pts.reduce((a, p) => a + p[1], 0) / pts.length };
  const first = doneRides().find((r) => !r.system && state.tracks.get(r.id)?.[0]?.[0]);
  const p = first && state.tracks.get(first.id)[0][0];
  return p ? { lat: p.lat, lon: p.lon } : null;
}

/** Every system this phone knows: home first, then each one named on a saved outing (placed where its first outing began). */
function knownSystems() {
  const out = [{ name: homeName(), place: 'trail', home: true, ...(homeSpot() ?? {}) }];
  for (const r of doneRides()) {
    if (!r.system || out.some((s) => s.name === r.system)) continue;
    const p = state.tracks.get(r.id)?.[0]?.[0];
    out.push({ name: r.system, place: r.place ?? 'trail', lat: p?.lat, lon: p?.lon });
  }
  return out;
}

/** The system being looked at on the Merge & export screen: null means home. */
const activeSystem = () => (settings.viewSystem && knownSystems().some((s) => !s.home && s.name === settings.viewSystem) ? settings.viewSystem : null);
const inActiveSystem = (ride) => (ride.system ?? null) === activeSystem();

/**
 * Decide what an outing starting at `spot` belongs to.
 * @param late true when asked after recording has begun (no position was known at START): then there is no Cancel
 * @returns {} for the home system, { system, place } for another, or 'cancel'
 */
async function whichSystem(spot, noun, late = false) {
  const placed = knownSystems().filter((s) => s.lat != null)
    .map((s) => ({ ...s, km: haversine(spot.lat, spot.lon, s.lat, s.lon) / 1000 })).sort((a, b) => a.km - b.km);
  if (!placed.length) return {}; // nothing to be far from yet
  const near = placed[0];
  if (near.km <= AWAY_KM) return near.home ? {} : { system: near.name, place: near.place };
  const others = knownSystems().filter((s) => !s.home && s.name !== ONE_OFF);
  const res = await ask({
    title: 'Where are you?',
    body: `You are about ${Math.round(near.km)} km from ${near.name}, the nearest trails this app knows. What is this ${noun} part of?`,
    buttons: [
      ...others.map((s) => ({ label: s.name, value: `sys:${s.name}` })),
      { label: 'NEW TRAIL SYSTEM', value: 'trail', cls: 'go' },
      { label: 'NEW URBAN WALK', value: 'urban', cls: 'info' },
      { label: 'NEW PARK OR PUBLIC TRAIL', value: 'park', cls: 'info' },
      { label: 'Just a one-off, no name', value: 'oneoff' },
      { label: `It is part of ${homeName()}`, value: 'home' },
      ...(late ? [] : [{ label: 'Cancel', value: 'cancel' }]),
    ],
  });
  if (res.button === 'home') return {};
  if (res.button === 'cancel') return late ? { system: ONE_OFF, place: 'oneoff' } : 'cancel';
  if (res.button === 'oneoff') return { system: ONE_OFF, place: 'oneoff' };
  if (res.button.startsWith('sys:')) {
    const s = others.find((o) => `sys:${o.name}` === res.button);
    return { system: s.name, place: s.place };
  }
  const named = await ask({
    title: `Name this ${PLACES[res.button]}`,
    body: `Every ${noun} you file under this name is merged into its own map, separate from ${homeName()}.`,
    input: { placeholder: res.button === 'urban' ? 'e.g. Merrickville village loop' : res.button === 'park' ? 'e.g. Limerick Forest' : 'e.g. Camp trails' },
    buttons: [{ label: 'SAVE', value: 'save', cls: 'go' }, { label: late ? 'Skip' : 'Cancel', value: 'cancel' }],
  });
  if (named.button !== 'save' || !named.text) return late ? { system: ONE_OFF, place: 'oneoff' } : 'cancel';
  return { system: named.text.slice(0, 60), place: res.button };
}

/** No position was known at START: ask at the first recorded point instead (waiting for any other question to be answered first). */
async function placeLate(ride, p) {
  while ($('dlg').open) await new Promise((r) => setTimeout(r, 3000));
  if (state.current !== ride) return;
  const where = await whichSystem(p, nounOf(ride), true);
  if (where.system) {
    Object.assign(ride, { system: where.system, place: where.place });
    await db.put('rides', ride);
    toast(`Filed under ${where.system}`);
  }
}

let starting = false;
/** START. Whatever goes wrong is said on screen, and START can always be pressed again. */
async function startRide() {
  try {
    await beginRide();
  } catch (err) {
    starting = false;
    updateRideUi();
    toast(`Could not start: ${err?.message ?? err}. Please try again.`, 8000);
  }
}
async function beginRide() {
  if (!tracker.geo) { toast('This browser cannot use GPS.'); return; }
  if (starting || state.current) return;
  starting = true;
  let vehicle, seat = null;
  try {
    if (!(await discloseLocation())) return;
    vehicle = await chooseVehicle('How are you travelling?', settings.vehicle);
    if (vehicle?.seats) {
      seat = await chooseSeat(vehicle, settings.seat);
      if (!seat) return;
    }
  } finally {
    starting = false;
  }
  if (!vehicle) return;
  settings.vehicle = vehicle.key;
  if (seat) settings.seat = seat;
  saveSettings();
  // Far from every trail system this phone knows? Then ask what this outing belongs to (see whichSystem).
  const here = Date.now() - state.fixAt < 60000 ? (tracker.good ?? tracker.lastFix) : null;
  const where = here ? await whichSystem(here, vehicle.noun ?? 'ride') : null;
  if (where === 'cancel') return;
  const ride = setMethod({
    id: Date.now(), name: '', by: settings.userName,
    startedAt: Date.now(), endedAt: Date.now(), status: 'recording', include: true, dist: 0, count: 0,
  }, vehicle, seat);
  if (where?.system) Object.assign(ride, { system: where.system, place: where.place });
  else if (!here) ride.placeLate = true; // no position yet: asked at the first recorded point
  startActivity(ride); // straight after the tap: an iPhone only lets the motion sensor be asked for then
  await db.put('rides', ride);
  state.rides.push(ride);
  state.tracks.set(ride.id, []);
  state.current = ride;
  state.network = null;
  rideMap.clearLive();
  startGps();
  tracker.start();
  rideMap.center();
  notice('');
  setWake(true).then((ok) => {
    if (NATIVE) { // the Android app records with the screen off, so none of the screen advice applies
      if (!localStorage.getItem('tt-native-tip')) {
        localStorage.setItem('tt-native-tip', '1');
        notice('You can turn the screen off or put the phone in your pocket. Recording carries on, and a notification shows while it does.');
      }
      return;
    }
    if (!ok) { notice(SCREEN_TIP); return; }
    // For the first few rides, say how to pocket the phone without losing GPS.
    const shown = Number(localStorage.getItem('tt-dark-tip') ?? 0);
    if (shown < 3) {
      localStorage.setItem('tt-dark-tip', shown + 1);
      notice('Pocketing the phone? Tap DARK SCREEN. It goes black and locks but keeps recording. Pressing the power button stops GPS.');
    }
  });
  touched();
  keepStorage();
  updateRideUi();
}

let storageWarned = false;
function onPoint(p, newSeg) {
  const ride = state.current;
  if (!ride) return;
  const segs = state.tracks.get(ride.id);
  if (ride.placeLate) { delete ride.placeLate; placeLate(ride, p).catch(() => {}); }
  if (newSeg || !segs.length) segs.push([]);
  const seg = segs[segs.length - 1];
  const prev = seg[seg.length - 1];
  if (ride.cond) p.cond = ride.cond; // the trail condition in force when this point was recorded
  seg.push(p);
  if (prev) { // moving time and calories for the stretch just covered (a long gap means a stop, which is not counted)
    const dt = (p.t - prev.t) / 1000;
    if (dt > 0 && dt <= STOP_GAP) {
      activity.moving += dt * 1000;
      activity.kcal += kcalFor(effortOf(methodOf(ride)), (p.spd ?? 0) * 3.6, dt, settings.weightKg);
    }
  }
  rideMap.addLive(p.lat, p.lon, newSeg);
  if (tracker.count === 1) { // the clock starts here, not at the tap on START
    ride.startedAt = p.t;
    ride.clockAt = clockNow();
    ride.pausedMs = 0;
  }
  ride.endedAt = p.t;
  ride.dist = tracker.dist;
  ride.count = tracker.count;
  db.addPoint({ ride: ride.id, ...p }).catch(() => {
    if (!storageWarned) notice('Could not save to the phone\'s storage. Free up some space, then press FINISH.');
    storageWarned = true;
  });
  if (ride.count % 20 === 0) db.put('rides', ride);
  updateStats();
}

function onFix(fix, verdict) {
  state.fixAt = Date.now();
  if (verdict === 'ok') state.goodAt = state.fixAt;
  rideMap.setPosition(fix.lat, fix.lon, fix.acc, fix.spd != null && fix.spd > 0.7 ? fix.hdg : null, verdict === 'ok');
  if (state.view === 'net') netMap.setPosition(fix.lat, fix.lon, fix.acc, null, verdict === 'ok');
  // Does nothing at all in private mode.
  if (verdict === 'ok') {
    share.update(fix, { method: methodOf(state.current ?? { vehicle: settings.vehicle }).short, rec: tracker.state === 'recording' }).catch(() => {});
    checkHuntPlaces(fix);
  }
  updateStats();
  updateStatus();
  updateHuntLive();
}

async function finishRide() {
  const ride = state.current;
  if (!ride) return;
  const tappedAt = clockNow(), countAtTap = tracker.count;
  const noun = nounOf(ride);
  const n = doneRides().filter((r) => nounOf(r) === noun).length + 1;
  noteSteps(ride);
  const effort = [stepsText(ride), fmtKcal(activity.kcal)].filter(Boolean).join(' · ');
  const res = tracker.count < 2
    ? await ask({
      title: 'Nothing recorded yet',
      body: `This ${noun} has no GPS points, so there is nothing to save.`,
      buttons: [{ label: 'KEEP GOING', value: 'cancel', cls: 'go' }, { label: 'End without saving', value: 'discard', cls: 'stop' }],
    })
    : await ask({
      title: `Save this ${noun}`,
      body: `${fmtDist(tracker.dist)} in ${fmtClock(timeOf(ride))} · ${methodOf(ride).name}${seatText(ride)} · ${effort}. Give it a name, such as the trail or loop you covered.`,
      input: { value: `${capital(noun)} ${n}`, placeholder: `e.g. ${capital(noun)} 1 - North Loop` },
      buttons: [
        { label: `SAVE ${noun.toUpperCase()}`, value: 'save', cls: 'go' },
        { label: 'Keep going', value: 'cancel' },
        { label: `Throw this ${noun} away`, value: 'discard', cls: 'stop' },
      ],
    });
  if (res.button === 'cancel') return;
  if (res.button === 'discard' && tracker.count >= 2) {
    const sure = await ask({
      title: `Throw this ${noun} away?`,
      body: `${fmtDist(tracker.dist)} of recording will be deleted. This cannot be undone.`,
      buttons: [{ label: 'Keep it', value: 'cancel', cls: 'go' }, { label: `DELETE ${noun.toUpperCase()}`, value: 'yes', cls: 'stop' }],
    });
    if (sure.button !== 'yes') return;
  }
  noteSteps(ride); // steps taken while the question was on screen
  stopActivity();
  tracker.stop();
  setWake(false);
  state.current = null;
  state.network = null;
  if (res.button === 'discard') {
    await db.deleteRide(ride.id);
    state.rides = state.rides.filter((r) => r !== ride);
    state.tracks.delete(ride.id);
  } else {
    // The clock stops at the tap on FINISH, unless more was recorded while the question was on screen.
    ride.finishedAt = tracker.count > countAtTap ? clockNow() : tappedAt;
    endPause(ride, ride.finishedAt);
    ride.name = res.text || `${capital(noun)} ${n}`;
    ride.status = 'done';
    await db.put('rides', ride);
    toast(`Saved "${ride.name}"`);
  }
  rideMap.clearLive();
  refreshRideMap();
  notice('');
  updateRideUi();
  if (ride.status === 'done') {
    refreshChallenges(true); // today's distance goes on the board of any challenge under way
    await showReport(ride, true, true); // says it is saved, then offers to sync it
  } else syncSoon();
}

/** Say what the trail is like from here on. It is stored with every point until it is changed. */
async function chooseCondition() {
  const ride = state.current;
  if (!ride) return;
  const res = await ask({
    title: 'What is the trail like here?',
    body: `Tap one. It applies to everything you record from now until you change it.${ride.cond ? ` Now: ${ride.cond}.` : ''}`,
    chips: CONDITIONS,
    pick: true,
    input: { placeholder: 'Or type your own' },
    focus: false,
    buttons: [
      { label: 'USE WHAT I TYPED', value: 'save', cls: 'go' },
      { label: 'Clear (not set)', value: 'clear' },
      { label: 'Cancel', value: 'cancel' },
    ],
  });
  if (res.button === 'cancel' || (res.button === 'save' && !res.text)) return;
  if (res.button === 'clear') delete ride.cond; else ride.cond = res.text.slice(0, 30);
  await db.put('rides', ride);
  updateActivity();
  toast(ride.cond ? `Trail from here: ${ride.cond}` : 'Trail condition cleared');
}
$('cond-pill').addEventListener('click', chooseCondition);

/**
 * The position to stamp on a pin or photo right now: the latest good fix, or
 * failing that the latest fix of any quality. Null (with a message) if there
 * is nothing recent.
 */
function spotNow() {
  const fresh = Date.now() - state.goodAt < 15000;
  const fix = fresh ? tracker.good : (Date.now() - state.fixAt < 15000 ? tracker.lastFix : null);
  if (fix) return { fix, fresh };
  if (!state.gpsWanted) startGps();
  toast('No GPS position yet – try again in a moment.');
  return null;
}

/**
 * What a pin or photo is, asked in two steps (the owner, 2026-11-18): first the
 * HEADING, picked from a list ("Trailhead", "Point of interest" ...), then a short
 * DESCRIPTION written under that heading ("Trespassing sign").
 *
 * @param o { photo, image, where, head, desc }: `where` is the line about the position;
 *          `head` and `desc` are the present values when something is being renamed
 * @returns { head, desc } (desc may be ''), or null if it was backed out of at the heading,
 *          or 'discard' if the photo is to be thrown away
 */
async function describePin(o) {
  const what = o.photo ? 'photo' : 'pin';
  // Headings typed on this phone before come first, then the standard ones.
  const own0 = (Array.isArray(readJson('tt-pin-heads')) ? readJson('tt-pin-heads') : []).filter((h) => typeof h === 'string');
  const list = [...own0, ...(o.photo ? PHOTO_LABELS : PIN_LABELS).filter((l) => !own0.includes(l))];
  const picked = await ask({
    title: o.rename ? `Change this ${what}'s heading` : `What is this ${what}?`,
    body: `${o.where ? `${o.where} ` : ''}Choose a heading. You can add a few words of your own next.`,
    image: o.image ?? null,
    chips: [...(o.head && !list.includes(o.head) ? [o.head] : []), ...list, 'Something else…'],
    pick: true,
    focus: false,
    buttons: o.photo && !o.rename
      ? [{ label: 'Throw it away', value: 'discard', cls: 'stop' }]
      : [{ label: 'Cancel', value: 'cancel' }],
  });
  if (picked.button === 'discard') return 'discard';
  if (picked.button !== 'chip') return null;
  let head = picked.text;
  if (head === 'Something else…') {
    const own = await ask({
      title: 'Your own heading',
      body: 'One or two words that say what kind of thing this is.',
      image: o.image ?? null,
      input: { placeholder: 'e.g. Sugar shack' },
      buttons: [{ label: 'NEXT', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
    });
    if (own.button !== 'save' || !own.text) return null;
    head = own.text.slice(0, 30);
    localStorage.setItem('tt-pin-heads', JSON.stringify([head, ...own0.filter((h) => h.toLowerCase() !== head.toLowerCase())].slice(0, 6)));
  }
  const said = await ask({
    title: head,
    body: `Add a short description under "${head}", or leave it empty.`,
    image: o.image ?? null,
    input: { value: o.desc ?? '', placeholder: head === 'Trailhead' ? 'e.g. Trespassing sign' : 'e.g. By the old fence' },
    buttons: [{ label: o.photo ? 'SAVE PHOTO' : 'SAVE PIN', value: 'save', cls: 'info' }],
  });
  return { head, desc: said.button === 'save' ? said.text.slice(0, 60) : (o.desc ?? '') };
}
/** The one-line name used on the map and in exports: "Trailhead - Trespassing sign". */
const pinName = (head, desc) => (desc ? `${head} - ${desc}` : head);

async function dropPin() {
  const spot = spotNow();
  if (!spot) return;
  const { fix, fresh } = spot;
  // The position is taken now; saying what it is can wait until you have stopped.
  const pin = {
    id: Date.now(), ride: state.current?.id ?? null, name: '', by: settings.userName,
    lat: fix.lat, lon: fix.lon, alt: fix.alt, acc: fix.acc, t: Date.now(),
  };
  const said = await describePin({
    where: fresh ? `Position locked (±${Math.round(fix.acc)} m).` : `GPS is weak right now (±${Math.round(fix.acc)} m), so this pin may be off.`,
  });
  if (!said) return;
  Object.assign(pin, { head: said.head, desc: said.desc, name: pinName(said.head, said.desc) });
  await db.put('pins', pin);
  state.pins.push(pin);
  rideMap.setPins(state.pins);
  if (state.view === 'net') renderRides();
  toast(`Pin saved: ${pin.name}`);
}

// ---- photos -----------------------------------------------------------------------
//
// A photo is a pin with a picture. The position is taken at the tap on PHOTO,
// before the phone's camera opens, because the app sits in the background (and
// gets no GPS) while the camera is up.

let photoSpot = null;
/** @param huntItem the id of the scavenger-hunt item this photo is for, if it is for one */
function takePhoto(huntItem = null) {
  const spot = spotNow();
  if (!spot) return;
  photoSpot = { ...spot, t: Date.now(), ride: state.current?.id ?? null, huntItem };
  $('photo-input').click(); // must happen inside the tap, or the phone refuses to open the camera
}

/**
 * Scale a camera picture down to a sensible size for keeping (phones shoot
 * far bigger than a trail record needs) and make a small thumbnail for lists.
 */
async function readPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    // Wait on the load event rather than img.decode(): decode() only settles when
    // the screen is being redrawn, which is not a given just after the camera closes.
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('not a picture'));
      img.src = url;
    });
    const draw = (maxSide) => {
      const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c;
    };
    const blob = await new Promise((resolve, reject) =>
      draw(2048).toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode'))), 'image/jpeg', 0.85));
    return { blob, thumb: draw(160).toDataURL('image/jpeg', 0.7) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

$('photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const spot = photoSpot;
  photoSpot = null;
  if (!file || !spot) return;
  let picture;
  try {
    picture = await readPhoto(file);
  } catch {
    toast('That photo could not be read.', 5000);
    return;
  }
  const n = state.pins.filter((p) => p.photo).length + 1;
  const preview = URL.createObjectURL(picture.blob);
  // A photo taken for a scavenger hunt already has its name: the thing that was being looked for.
  const quarry = spot.huntItem && game?.status === 'active'
    ? game.hunt.items.find((it) => it.id === spot.huntItem && !game.found[it.id]) : null;
  const res = quarry
    ? await ask({
      title: `Found: ${quarry.name}?`,
      body: 'Use this photo as your find? It is pinned to the map where you took it.',
      image: preview,
      buttons: [{ label: 'YES, FOUND IT', value: 'save', cls: 'go' }, { label: 'Throw it away', value: 'discard', cls: 'stop' }],
    })
    : null;
  // Any other photo: a heading, then a few words under it (see describePin).
  const said = quarry ? null : await describePin({
    photo: true, image: preview,
    where: spot.fresh ? `Pinned where you took it (±${Math.round(spot.fix.acc)} m).`
      : `Pinned where you took it, but GPS was weak (±${Math.round(spot.fix.acc)} m), so the spot may be off.`,
  });
  URL.revokeObjectURL(preview);
  if (res?.button === 'discard' || said === 'discard') return;
  // Backing out of the question keeps the photo, under a plain name: it cannot be retaken.
  const pin = {
    id: Date.now(), ride: spot.ride, name: quarry?.name ?? (said ? pinName(said.head, said.desc) : `Photo ${n}`), by: settings.userName,
    lat: spot.fix.lat, lon: spot.fix.lon, alt: spot.fix.alt, acc: spot.fix.acc, t: spot.t,
    photo: true, thumb: picture.thumb,
  };
  if (said) Object.assign(pin, { head: said.head, desc: said.desc });
  try {
    await db.put('photos', { id: pin.id, type: picture.blob.type, data: await picture.blob.arrayBuffer() });
    await db.put('pins', pin);
  } catch {
    notice('Could not save the photo to the phone\'s storage. Free up some space and try again.');
    return;
  }
  state.pins.push(pin);
  rideMap.setPins(state.pins);
  if (state.view === 'net') renderRides();
  if (quarry) markFound(quarry, { pin: pin.id });
  else toast(`Photo saved: ${pin.name}`);
});

/** The full picture of a photo pin as a Blob, or null if it is missing. */
async function photoOf(pin) {
  const rec = await db.get('photos', pin.id);
  return rec ? new Blob([rec.data], { type: rec.type || 'image/jpeg' }) : null;
}

async function viewPhoto(pin) {
  const blob = await photoOf(pin);
  if (!blob) { toast('The picture for this pin is missing.'); return; }
  const url = URL.createObjectURL(blob);
  await showPicture(url, pin.name, `${byName(pin)} · ${fmtDate(pin.t)} · ±${Math.round(pin.acc)} m · pinch or double-tap to zoom`);
  URL.revokeObjectURL(url);
}

/** A picture at full screen. Pinch, drag, double-tap or use the mouse wheel to zoom. Resolves when closed. */
function showPicture(url, title, info) {
  const box = $('viewer'), stage = $('viewer-stage'), img = $('viewer-img');
  $('viewer-title').textContent = title;
  $('viewer-info').textContent = info;
  img.style.transform = '';
  img.src = url;
  let s = 1, x = 0, y = 0, lastTap = 0, moved = 0;
  const fingers = new Map();
  const apply = () => {
    s = Math.min(8, Math.max(1, s));
    // never let the picture be dragged off the screen
    const mx = Math.max(0, (img.offsetWidth * s - stage.clientWidth) / 2);
    const my = Math.max(0, (img.offsetHeight * s - stage.clientHeight) / 2);
    x = Math.min(mx, Math.max(-mx, x));
    y = Math.min(my, Math.max(-my, y));
    img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  };
  /** Zoom to `next`, keeping the spot under (px, py) where it is. */
  const zoomAt = (px, py, next) => {
    next = Math.min(8, Math.max(1, next));
    const r = stage.getBoundingClientRect();
    const dx = px - (r.left + r.width / 2), dy = py - (r.top + r.height / 2);
    const k = next / s;
    x = dx - k * (dx - x);
    y = dy - k * (dy - y);
    s = next;
    apply();
  };
  const pair = () => {
    const [a, b] = [...fingers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };
  const stop = new AbortController();
  const on = (el, type, fn, opts = {}) => el.addEventListener(type, fn, { signal: stop.signal, ...opts });
  on(stage, 'pointerdown', (e) => {
    stage.setPointerCapture?.(e.pointerId);
    if (!fingers.size) moved = 0;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  on(stage, 'pointermove', (e) => {
    const was = fingers.get(e.pointerId);
    if (!was) return;
    if (fingers.size === 1) {
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved += Math.abs(e.clientX - was.x) + Math.abs(e.clientY - was.y);
      if (s > 1) { x += e.clientX - was.x; y += e.clientY - was.y; apply(); }
    } else if (fingers.size === 2) {
      const before = pair();
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const after = pair();
      moved = 99;
      x += after.x - before.x;
      y += after.y - before.y;
      zoomAt(after.x, after.y, s * after.d / before.d);
    }
  });
  const lift = (e) => {
    if (!fingers.delete(e.pointerId) || fingers.size || e.type !== 'pointerup' || moved > 10) return;
    const now = performance.now();
    if (now - lastTap < 320) { zoomAt(e.clientX, e.clientY, s > 1 ? 1 : 3); lastTap = 0; } else lastTap = now;
  };
  on(stage, 'pointerup', lift);
  on(stage, 'pointercancel', lift);
  on(stage, 'wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, s * (e.deltaY < 0 ? 1.25 : 0.8)); }, { passive: false });
  return new Promise((resolve) => {
    const done = () => {
      stop.abort();
      img.removeAttribute('src');
      img.style.transform = '';
      resolve();
    };
    // Finish on the tap itself: the dialog's own "close" event can arrive late (see ask()).
    on($('viewer-close'), 'click', () => { box.close(); done(); });
    on(box, 'close', done);
    box.showModal();
  });
}

/** A ride left "recording" means the app was closed mid-ride. Its points are all on disk. */
async function recoverUnfinished() {
  for (const ride of state.rides.filter((r) => r.status === 'recording')) {
    const segs = state.tracks.get(ride.id) ?? [];
    const m = measure(segs);
    if (!m.count) {
      await db.deleteRide(ride.id);
      state.rides = state.rides.filter((r) => r !== ride);
      state.tracks.delete(ride.id);
      continue;
    }
    Object.assign(ride, { dist: m.dist, count: m.count, startedAt: m.startedAt, endedAt: m.endedAt });
    const res = await ask({
      title: `Unfinished ${nounOf(ride)} found`,
      body: `The app closed during a ${nounOf(ride)} on ${fmtDate(m.startedAt)} (${fmtDist(m.dist)}). Nothing was lost.`,
      buttons: [{ label: `CONTINUE THIS ${nounOf(ride).toUpperCase()}`, value: 'resume', cls: 'go' }, { label: 'Save it as it is', value: 'save' }],
    });
    if (res.button === 'resume' && !state.current) {
      endPause(ride, Date.now(), ride.pausedAt ?? m.endedAt); // the time the app was closed does not count
      state.current = ride;
      rideMap.clearLive();
      for (const s of segs) s.forEach((p, i) => rideMap.addLive(p.lat, p.lon, i === 0));
      startGps();
      tracker.start({ seg: m.lastSeg, dist: m.dist, count: m.count });
      startActivity(ride);
      setWake(true);
    } else {
      // Saved the same way FINISH & SAVE does it: a name is asked for, and the summary is shown,
      // so there is no doubt it was kept. (It used to be saved silently as "... (recovered)".)
      const noun = nounOf(ride);
      const n = doneRides().filter((r) => nounOf(r) === noun).length + 1;
      const named = await ask({
        title: `Save this ${noun}`,
        body: `${fmtDist(m.dist)} recorded, all of it kept. Give it a name, such as the trail or loop you covered.`,
        input: { value: ride.name || `${capital(noun)} ${n}`, placeholder: `e.g. ${capital(noun)} 1 - North Loop` },
        buttons: [{ label: `SAVE ${noun.toUpperCase()}`, value: 'save', cls: 'go' }],
      });
      ride.name = named.text || ride.name || `${capital(noun)} ${n}`;
      ride.status = 'done';
    }
    await db.put('rides', ride);
    if (ride.status === 'done') {
      refreshRideMap();
      await showReport(ride, true, true);
    }
  }
}

// ---- saved rides screen -----------------------------------------------------

function renderRides() {
  const rides = doneRides().filter(inActiveSystem).reverse(); // the trail system being looked at (see activeSystem)
  $('rides-details').querySelector('summary').textContent = knownSystems().length > 1 ? `Your walks and rides: ${systemName()}` : 'Your walks and rides';
  $('ride-list').replaceChildren(...rides.map((r) => {
    const li = document.createElement('li');
    li.dataset.id = r.id;
    if (!r.include) li.className = 'off';
    li.innerHTML = `
      <label class="switch"><input type="checkbox" data-act="include" ${r.include ? 'checked' : ''} aria-label="Use this ride in the trail network"><span></span></label>
      <div data-act="report"><div class="name">${esc(r.name)}</div>
        <div class="meta"><b>${esc(byName(r))}</b> · ${esc(methodOf(r).short + seatText(r))} · ${fmtDate(r.startedAt)} · ${fmtDist(r.dist)} · ${fmtDur(timeOf(r))} · ${
  [stepsText(r), fmtKcal(kcalOf(r)), elevOf(r) ? `↕ ${Math.round(elevOf(r).diff)} m` : ''].filter(Boolean).join(' · ')}</div></div>
      <div class="acts five"><button data-act="report">Report</button><button data-act="rename">Rename</button><button data-act="vehicle">Method</button><button data-act="show">Show on map</button><button data-act="delete" class="del">Delete</button></div>`;
    return li;
  }));
  $('ride-empty').hidden = rides.length > 0;

  // Every saved ride counts here, whether or not it is switched into the trail network.
  const totals = totalsByMethod(rides);
  if (totals.length > 1) {
    totals.push(totals.reduce((a, t) => ({
      ...a, rides: a.rides + t.rides, dist: a.dist + t.dist, time: a.time + t.time, moving: a.moving + t.moving, kcal: a.kcal + t.kcal, steps: a.steps + t.steps,
    }), { name: 'All travel', noun: 'outing', rides: 0, dist: 0, time: 0, moving: 0, kcal: 0, steps: 0, all: true }));
  }
  $('totals').hidden = !rides.length;
  $('totals-list').innerHTML = totals.map((t) => `
    <li class="${t.all ? 'all' : ''}"><span class="dot" style="background:${t.all ? '#fff' : 'var(--live)'}"></span>
      <span>${esc(t.name)} <span class="sub">${t.rides} ${t.noun ?? 'ride'}${t.rides === 1 ? '' : 's'} · moving ${fmtDur(t.moving)} · ${fmtKcal(t.kcal)}${t.steps ? ` · ${t.steps.toLocaleString()} steps` : ''}</span></span>
      <span class="pct two">${fmtDist(t.dist)}<i>${fmtDur(t.time)}</i></span></li>`).join('');

  $('pin-list').replaceChildren(...state.pins.map((p) => {
    const ride = state.rides.find((r) => r.id === p.ride);
    const li = document.createElement('li');
    li.dataset.id = p.id;
    li.innerHTML = `
      ${p.photo ? `<img class="thumb" src="${esc(p.thumb ?? '')}" alt="" data-act="view">` : '<div class="pinmark"></div>'}
      <div><div class="name">${esc(p.head ?? p.name)}</div>${p.head && p.desc ? `<div class="desc">${esc(p.desc)}</div>` : ''}
        <div class="meta"><b>${esc(byName(p))}</b> · ${fmtDate(p.t)} · ±${Math.round(p.acc)} m${ride ? ` · ${esc(rideName(ride))}` : ''}</div></div>
      <div class="acts">${p.photo ? '<button data-act="view">View</button>' : ''}<button data-act="rename">Rename</button><button data-act="delete" class="del">Delete</button></div>`;
    return li;
  }));
  $('pin-empty').hidden = state.pins.length > 0;
}

$('ride-list').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const ride = state.rides.find((r) => r.id === Number(e.target.closest('li')?.dataset.id));
  if (!act || !ride) return;
  if (act === 'report') {
    await showReport(ride);
    return;
  }
  if (act === 'include') {
    ride.include = e.target.checked;
  } else if (act === 'rename') {
    const res = await ask({ title: `Rename ${nounOf(ride)}`, input: { value: ride.name }, buttons: [{ label: 'SAVE', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }] });
    if (res.button !== 'save' || !res.text) return;
    ride.name = res.text;
  } else if (act === 'vehicle') {
    const vehicle = await chooseVehicle(`What was "${ride.name}" on?`, methodOf(ride).key);
    if (!vehicle) return;
    const seat = vehicle.seats ? await chooseSeat(vehicle, ride.seat ?? settings.seat) : null;
    if (vehicle.seats && !seat) return;
    setMethod(ride, vehicle, seat);
  } else if (act === 'show') {
    state.focusRide = ride.id;
    showView('net');
    $('view-net').querySelector('.panel').scrollTop = 0; // the map is at the top of this same screen
    return;
  } else if (act === 'delete') {
    const res = await ask({
      title: `Delete "${ride.name}"?`,
      body: `${fmtDist(ride.dist)} recorded ${fmtDate(ride.startedAt)}. This cannot be undone.`,
      buttons: [{ label: 'Keep it', value: 'cancel', cls: 'go' }, { label: `DELETE ${nounOf(ride).toUpperCase()}`, value: 'yes', cls: 'stop' }],
    });
    if (res.button !== 'yes') return;
    state.rides = state.rides.filter((r) => r !== ride);
    state.tracks.delete(ride.id);
  }
  state.network = null;
  if (act === 'delete') await db.deleteRide(ride.id); else await db.put('rides', ride);
  renderRides();
  refreshRideMap();
  syncSoon();
});

$('pin-list').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const pin = state.pins.find((p) => p.id === Number(e.target.closest('li')?.dataset.id));
  if (!act || !pin) return;
  if (act === 'view') {
    await viewPhoto(pin);
    return;
  }
  if (act === 'rename') {
    // Heading first, then the description. An older pin has only a name: "Heading - words" is split, anything else becomes the description.
    const old = /^(.{1,30}?) - (.+)$/.exec(pin.name);
    const head = pin.head ?? old?.[1] ?? ([...PIN_LABELS, ...PHOTO_LABELS].includes(pin.name) ? pin.name : null);
    const said = await describePin({
      rename: true, photo: !!pin.photo, image: pin.photo ? pin.thumb : null,
      head, desc: pin.desc ?? old?.[2] ?? (head ? '' : pin.name),
    });
    if (!said || said === 'discard') return;
    Object.assign(pin, { head: said.head, desc: said.desc, name: pinName(said.head, said.desc) });
    await db.put('pins', pin);
  } else if (act === 'delete') {
    const res = await ask({
      title: `Delete ${pin.photo ? 'photo' : 'pin'} "${pin.name}"?`,
      body: pin.photo ? 'The picture is deleted with it. This cannot be undone.' : '',
      image: pin.photo ? pin.thumb : null,
      buttons: [{ label: 'Keep it', value: 'cancel', cls: 'go' }, { label: pin.photo ? 'DELETE PHOTO' : 'DELETE PIN', value: 'yes', cls: 'stop' }],
    });
    if (res.button !== 'yes') return;
    await db.del('pins', pin.id);
    if (pin.photo) await db.del('photos', pin.id);
    state.pins = state.pins.filter((p) => p !== pin);
  }
  renderRides();
  rideMap.setPins(state.pins);
  syncSoon();
});

// ---- merge & export screen --------------------------------------------------

function computeNetwork() {
  const tracks = state.rides
    .filter((r) => r.include && inActiveSystem(r) && state.tracks.get(r.id)?.length) // one trail system at a time
    .map((r) => ({
      id: r.id, name: rideName(r), by: byName(r), dist: r.dist, startedAt: r.startedAt, segments: state.tracks.get(r.id),
      vehicle: methodOf(r), vehicleWidth: r.vehicleWidth ?? methodOf(r).width,
    }));
  const net = buildNetwork(tracks, settings);
  nameSegments(net.segments, state.refIndex);                 // names from the existing map -> s.ref
  nameSegments(net.segments, state.branchIndex, 12, 'named'); // names given in this app -> s.named
  const conditions = indexConditions(tracks);
  for (const s of net.segments) {
    s.branch = s.named ?? s.ref ?? null;
    s.conditions = conditionsAlong(s.points, conditions); // what the trail is like, newest report winning
    s.contributors = [...new Set(s.sources.map((i) => tracks[i].by))];
    // The trail is at least as wide as the widest thing that travelled it. A
    // ride that only touched the segment (crossing at a junction) does not count.
    let through = s.sources.filter((_, k) => s.shares[k] >= 0.5);
    if (!through.length) through = s.sources;
    const widest = through.map((i) => tracks[i]).reduce((a, b) => (b.vehicleWidth > a.vehicleWidth ? b : a));
    s.vehicles = [...new Set(through.map((i) => tracks[i].vehicle.name))];
    s.width = { ...estimateWidth(s.spread, widest.vehicleWidth), via: widest.vehicle.name };
    const what = s.branch ?? (s.rides.length === 1 ? s.rides[0] : 'New trail');
    s.name = `${what} · ${s.id}`;
  }
  net.tracks = tracks;
  net.branches = branchesOf(net.segments);
  state.network = net;
  state.lastKml = null;
  $('btn-share').hidden = true;
}

// ---- the trail system and its branches -------------------------------------------
//
// The whole network is one trail system with a name. Inside it, each named
// stretch is a branch; several segments can share a branch name. Branch names
// come from the existing map where a segment follows one of its trails, or
// from the user. A name the user gives is stored with the line it was given to,
// so it finds its segment again however the network is re-merged later.

/** A name for the whole system: the existing map's own name, without a trailing "System" or "Map". */
function suggestSystemName() {
  const fromMap = state.ref?.name?.replace(/\s+(trails?\s+)?(system|map|network)$/i, (m, trail) => (trail ? ' Trail' : '')).trim();
  if (fromMap) return /trail/i.test(fromMap) ? fromMap : `${fromMap} Trail`;
  return settings.userName ? `${settings.userName}'s Trail` : 'My Trail';
}
/** The name of the system on screen: the home one, or another one picked on the Merge & export screen. */
const systemName = () => activeSystem() ?? homeName();

async function askSystemName() {
  const away = activeSystem(); // renaming another system renames it on every outing filed under it
  const suggestion = suggestSystemName();
  const res = await ask({
    title: 'Name of the trail system',
    body: 'The whole network of trails. Each named stretch inside it is a branch.',
    input: { value: systemName(), placeholder: 'e.g. MacGregor Estates Trail' },
    chips: !away && suggestion !== systemName() ? [suggestion] : [],
    buttons: [{ label: 'SAVE', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
  });
  if (res.button !== 'save' || !res.text) return false;
  const name = res.text.slice(0, 60);
  if (away) {
    for (const r of state.rides.filter((x) => x.system === away)) { r.system = name; await db.put('rides', r); }
    settings.viewSystem = name;
    syncSoon();
  } else {
    settings.systemName = name;
    prefsChanged();
  }
  saveSettings();
  state.lastKml = null;
  if (state.view === 'net') { renderRides(); renderNetwork(false); }
  return true;
}
/** "Change" beside the trail system: with more than one system, pick which one to look at; otherwise rename. */
$('btn-sys').addEventListener('click', async () => {
  const systems = knownSystems();
  if (systems.length < 2) { await askSystemName(); return; }
  const now = systemName();
  const res = await ask({
    title: 'Which trail system?',
    body: 'The map, the list of walks and the export below show one system at a time.',
    buttons: [
      ...systems.map((s) => ({ label: `${s.name}${s.home ? '' : ` (${PLACES[s.place] ?? 'trail system'})`}`, value: `sys:${s.name}`, cls: s.name === now ? 'go' : 'ghost' })),
      { label: `Rename "${now}"`, value: 'rename', cls: 'info' },
      { label: 'Cancel', value: 'cancel' },
    ],
  });
  if (res.button === 'rename') { await askSystemName(); return; }
  if (!res.button.startsWith('sys:')) return;
  const pick = systems.find((s) => `sys:${s.name}` === res.button);
  settings.viewSystem = pick.home ? null : pick.name;
  saveSettings();
  state.network = null;
  state.focusRide = state.focusSeg = null;
  renderRides();
  renderNetwork(true);
});

const branchIndexOf = (branches) => prepareReference({ lines: branches.map((b) => ({ name: b.name, parts: [b.pts], boundary: false })) });

/** Segments grouped by branch name, longest first; segments with no name come last under `name: null`. */
function branchesOf(segments) {
  const by = new Map();
  for (const s of segments) {
    const e = by.get(s.branch) ?? by.set(s.branch, { name: s.branch, length: 0, segments: [], narrow: Infinity, wide: 0 }).get(s.branch);
    e.length += s.length;
    e.segments.push(s);
    e.narrow = Math.min(e.narrow, s.width.width);
    e.wide = Math.max(e.wide, s.width.width);
  }
  for (const b of by.values()) {
    // A branch's conditions are its segments' conditions, weighted by how long each segment is.
    const tally = new Map();
    for (const s of b.segments) {
      for (const p of s.conditions.parts) tally.set(p.cond, (tally.get(p.cond) ?? 0) + p.share * s.length);
    }
    b.conditions = {
      parts: [...tally].map(([cond, metres]) => ({ cond, share: metres / b.length })).sort((x, y) => y.share - x.share),
    };
  }
  return [...by.values()].sort((a, b) => (a.name === null) - (b.name === null) || b.length - a.length);
}

async function nameBranch(seg) {
  const known = [...new Set([
    ...state.network.segments.map((s) => s.branch),
    ...(state.ref?.lines.filter((l) => !l.boundary).map((l) => l.name) ?? []),
  ].filter(Boolean))].sort();
  const res = await ask({
    title: 'Name this branch',
    body: `${seg.id}, ${fmtDist(seg.length)} of ${systemName()}. Stretches given the same name are grouped as one branch.`,
    input: { value: seg.branch ?? '', placeholder: 'e.g. Creek Loop' },
    chips: known,
    buttons: [
      { label: 'SAVE', value: 'save', cls: 'go' },
      ...(seg.named ? [{ label: 'Remove this name', value: 'clear', cls: 'stop' }] : []),
      { label: 'Cancel', value: 'cancel' },
    ],
  });
  if (res.button === 'cancel' || (res.button === 'save' && !res.text)) return;
  const pts = seg.points.map((p) => [p.lat, p.lon]);
  // A new name replaces any earlier one given to (mostly) this same stretch.
  state.branches = state.branches.filter((b) => overlapShare(b.pts, pts) < 0.6);
  if (res.button === 'save') state.branches.unshift({ name: res.text.slice(0, 40), pts });
  await db.put('kv', state.branches, 'branches');
  state.branchIndex = branchIndexOf(state.branches);
  state.network = null;
  renderNetwork(false);
  syncSoon();
}

$('seg-list').addEventListener('click', (e) => {
  const seg = state.network?.segments.find((s) => s.id === e.target.closest('li')?.dataset.seg);
  if (!seg) return;
  if (e.target.closest('[data-act=name]')) { nameBranch(seg); return; }
  // Tapping a row shows that stretch on the map (tap again to go back to everything).
  state.focusSeg = state.focusSeg === seg.id ? null : seg.id;
  state.focusRide = null;
  renderNetwork(true);
});

function renderNetwork(fit) {
  if (!state.network) computeNetwork();
  const net = state.network;
  const css = (TRAIL_COLORS[settings.color] ?? TRAIL_COLORS.orange).css;
  $('key-merged').style.background = css;
  $('show-ref-wrap').hidden = !state.ref;

  netMap.setLayer('walked', walkedLines(0.45));
  netMap.setLayer('ref', refLines(0.5));
  netMap.setLabels(state.ref && settings.showRef ? state.ref.points : []);
  netMap.setLayer('raw', settings.showRaw
    ? net.tracks.flatMap((t) => t.segments.map((pts) => ({ pts, color: RAW_COLOR, width: 1.5 }))) : []);
  netMap.setLayer('merged', settings.showMerged
    ? net.segments.map((s) => ({ pts: s.points, color: css, width: 4, outline: true })) : []);
  const focusSeg = net.segments.find((s) => s.id === state.focusSeg);
  const focus = focusSeg ? [focusSeg.points] : state.tracks.get(state.focusRide);
  netMap.setLayer('focus', focus ? focus.map((pts) => ({ pts, color: '#ffffff', width: focusSeg ? 6 : 2.5, outline: !!focusSeg })) : []);
  netMap.setPins(state.pins);

  $('sys-val').textContent = systemName();
  $('sys-note').textContent = knownSystems().length > 1 ? 'Showing this system only. Tap Change to look at another one.'
    : settings.systemName ? 'Used as the name of the Google Earth file and map.'
      : (state.ref ? 'Suggested from your existing map. Tap Change if it is not right.' : 'Suggested name. Tap Change to set your own.');

  const st = net.stats;
  $('net-stats').innerHTML = `
    <div><b>${(st.rawLength / 1000).toFixed(2)}</b><i>km ridden</i></div>
    <div class="hl"><b style="color:${css}">${(st.mergedLength / 1000).toFixed(2)}</b><i>km of trail</i></div>
    <div><b>${st.rawPoints} → ${st.mergedPoints}</b><i>GPS → map points</i></div>`;
  $('btn-export').disabled = !net.segments.length;

  const cov = coverage(state.refIndex, net.tracks);
  $('coverage').hidden = !cov.length;
  $('coverage-list').innerHTML = cov.map((c) => `
    <li><span class="dot" style="background:${esc(c.color ?? '#9fb0c0')}"></span>
      <span>${esc(c.name)} <span class="sub">${fmtDist(c.length)}</span></span>
      <span class="pct ${c.pct >= 90 ? 'done' : ''}">${c.pct}%</span></li>`).join('');

  const named = net.branches.filter((b) => b.name !== null);
  $('branch-details').hidden = !net.segments.length;
  $('branch-details').querySelector('summary').textContent = `Branches of ${systemName()} (${named.length})`;
  $('branch-list').innerHTML = net.branches.map((b) => `
    <li><span class="dot" style="background:${b.name === null ? '#555' : css}"></span>
      <span>${b.name === null ? 'Not named yet' : esc(b.name)} <span class="sub">${b.segments.length} segment${b.segments.length === 1 ? '' : 's'} · ${
  b.wide - b.narrow < 0.05 ? `${b.wide.toFixed(1)} m wide` : `${b.narrow.toFixed(1)} to ${b.wide.toFixed(1)} m wide`}${
  conditionText(b.conditions) ? ` · ${esc(conditionText(b.conditions))}` : ''}</span></span>
      <span class="pct">${fmtDist(b.length)}</span></li>`).join('');

  $('seg-details').hidden = !net.segments.length;
  $('seg-details').querySelector('summary').textContent = `Trail segments (${net.segments.length})`;
  $('seg-list').innerHTML = net.segments.map((s) => `
    <li class="tap ${s.id === state.focusSeg ? 'sel' : ''}" data-seg="${s.id}"><span class="dot" style="background:${s.id === state.focusSeg ? '#fff' : css}"></span>
      <span>${esc(s.name)} <span class="sub">${fmtDist(s.length)} · ${widthLabel(s.width)}${
  conditionText(s.conditions) ? ` · ${esc(conditionText(s.conditions))}` : ''} · ridden ×${s.passes} · ${esc(s.contributors.join(', '))}</span></span>
      <button class="mini" data-act="name">Name</button></li>`).join('');

  const who = contributorsOf(net.tracks, state.pins);
  $('who-details').hidden = !who.length;
  $('who-details').querySelector('summary').textContent = `Contributors (${who.length})`;
  $('who-list').innerHTML = who.map((c) => `
    <li><span class="dot" style="background:#fff"></span>
      <span>${esc(c.name)} <span class="sub">${c.rides} ride${c.rides === 1 ? '' : 's'} · ${c.pins} pin${c.pins === 1 ? '' : 's'}</span></span>
      <span class="pct">${fmtDist(c.dist)}</span></li>`).join('');

  if (fit) {
    if (focus) netMap.fit(['focus']);
    else if (!netMap.fit(['raw', 'merged'])) netMap.fit();
  }
}

let mergeTimer;
function remergeSoon() {
  clearTimeout(mergeTimer);
  mergeTimer = setTimeout(() => {
    state.network = null;
    renderNetwork(false);
  }, 60);
}

/**
 * The Google Earth file: a .kml, or a .kmz (the same thing zipped together
 * with the pictures) when there are photo pins. Resolves { name, data, type }.
 */
async function makeExport() {
  const net = state.network;
  const system = systemName();
  const slug = system.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'trail-network';
  const pictures = [], waypoints = [];
  for (const p of state.pins) {
    const w = { ...p, rideName: state.rides.find((r) => r.id === p.ride)?.name };
    const rec = p.photo ? await db.get('photos', p.id) : null;
    if (rec) {
      w.image = `files/photo-${p.id}.jpg`;
      pictures.push({ name: w.image, data: new Uint8Array(rec.data) });
    }
    waypoints.push(w);
  }
  const text = buildKml({
    name: system,
    branches: net.branches,
    travel: totalsByMethod(state.rides.filter((r) => net.tracks.some((t) => t.id === r.id))),
    segments: net.segments,
    waypoints,
    rides: net.tracks,
    contributors: contributorsOf(net.tracks, state.pins),
    color: settings.color,
    settings,
  });
  return pictures.length
    ? { name: `${slug}_${stamp()}.kmz`, data: buildKmz(text, pictures), type: 'application/vnd.google-earth.kmz' }
    : { name: `${slug}_${stamp()}.kml`, data: text, type: 'application/vnd.google-earth.kml+xml' };
}

$('btn-export').addEventListener('click', async () => {
  if (!state.network) computeNetwork(); // a ride was saved or changed since the last merge
  if (!state.network.segments.length) { toast('Nothing to export yet – record a ride first.'); return; }
  // The first export settles what the trail system is called (the suggestion is filled in).
  if (!settings.systemName && !(await askSystemName())) return;
  const kml = await makeExport();
  if (await saveFile(kml.name, kml.data, kml.type) !== 'downloaded') return;
  state.lastKml = new File([kml.data], kml.name, { type: kml.type });
  $('btn-share').hidden = !navigator.canShare?.({ files: [state.lastKml] });
  toast(`Saved ${kml.name} to Downloads`, 4500);
});

$('btn-share').addEventListener('click', async () => {
  try { await navigator.share({ files: [state.lastKml], title: state.lastKml.name }); } catch { /* cancelled */ }
});

// ---- settings screen --------------------------------------------------------

function renderSettings() {
  $('thr').value = settings.threshold;
  $('thr-val').textContent = `${settings.threshold} m (~${Math.round(settings.threshold * 3.281)} ft)`;
  $('smo').value = settings.smoothing;
  $('smo-val').textContent = settings.smoothing === 0 ? 'off' : settings.smoothing;
  $('acc').value = settings.maxAcc;
  $('acc-val').textContent = `${settings.maxAcc} m`;
  $('mind').value = settings.minDist;
  $('mind-val').textContent = `${settings.minDist} m`;
  const added = new Set((settings.customVehicles ?? []).map((v) => v.key));
  $('veh-list').innerHTML = allMethods().map((v) => `
    <li data-key="${esc(v.key)}"><span class="dot" style="background:${v.key === settings.vehicle ? 'var(--go)' : '#555'}"></span>
      <span>${esc(v.name)} <span class="sub">${added.has(v.key) ? `${v.width.toFixed(2)} m wide · ` : ''}${esc(v.basis ?? '')}</span></span>
      ${added.has(v.key) ? '<button class="mini del" data-act="remove">Remove</button>' : `<span class="pct">${v.width.toFixed(2)} m</span>`}</li>`).join('');
  $('autopause').checked = settings.autoPause;
  $('awake').checked = settings.keepAwake;
  $('autodark').value = String(settings.autoDark);
  $('show-raw').checked = settings.showRaw;
  $('show-merged').checked = settings.showMerged;
  $('show-ref').checked = settings.showRef;
  $('color').value = settings.color;

  const trails = state.ref?.lines.filter((l) => !l.boundary).length ?? 0;
  $('ref-info').innerHTML = state.ref
    ? `<b>${esc(state.ref.name)}</b> – ${trails} trail${trails === 1 ? '' : 's'}. Shown as dashed lines behind your rides, and used to name what you survey.`
    : 'None loaded. Load your current trail map (KML or KMZ from Google Earth) to see it behind your rides and track which trails you have covered.';
  $('btn-ref-clear').hidden = !state.ref;

  const points = [...state.tracks.values()].reduce((n, segs) => n + segs.reduce((m, s) => m + s.length, 0), 0);
  const photoCount = state.pins.filter((p) => p.photo).length;
  $('storage-info').textContent = `${doneRides().length} ride(s), ${points} GPS points, ${state.pins.length - photoCount} pin(s) and ${photoCount} photo(s) are stored on this phone. A backup file holds all of it, pictures included.`;
  $('name-val').textContent = settings.userName || 'Not set yet';
  $('avatar-img').src = settings.avatar ?? blankAvatar();
  $('btn-avatar').textContent = settings.avatar ? 'Change your picture' : 'Choose your picture';
  $('btn-avatar-clear').hidden = !settings.avatar;
  $('weight').value = settings.weightKg;
  $('weight-val').textContent = `${settings.weightKg} kg (${Math.round(settings.weightKg * 2.2046)} lb)`;
  renderSharing();
  renderCloud();
  const checked = update.checkedAt ? ` (checked ${new Date(update.checkedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })})` : '';
  $('version').textContent = `Version ${VERSION}${DEMO ? ' · demo mode' : ''} · ${{
    unknown: 'not checked yet',
    checking: 'checking for a newer version…',
    current: `up to date${checked}`,
    offline: 'could not check for updates (no signal)',
    waiting: `version ${update.latest} will install when you are not in the middle of something`,
    updating: `installing version ${update.latest}…`,
    stuck: `version ${update.latest} is available but did not install; tap Check for updates`,
  }[update.status]}`;
}

// ---- who is using this phone ---------------------------------------------------

/**
 * Save the user's name and put it on everything recorded on this phone that
 * has no name yet (or carries the name being replaced).
 */
async function setUserName(name) {
  const old = settings.userName;
  settings.userName = name;
  saveSettings();
  for (const [store, list] of [['rides', state.rides], ['pins', state.pins]]) {
    for (const item of list) {
      if (item.by && item.by !== old) continue;
      item.by = name;
      await db.put(store, item);
    }
  }
  state.network = null;
  renderSettings();
  if (state.view === 'net') renderRides();
  if (state.view === 'net') renderNetwork(false);
}

async function askName(first) {
  const res = await ask({
    title: first ? 'Welcome! What is your name?' : 'Your name',
    body: 'It is saved with the rides and pins you record, so you can see who mapped what when rides from more than one phone are combined.',
    input: { value: settings.userName ?? '', placeholder: 'Your first name' },
    buttons: first
      ? [{ label: 'CONTINUE', value: 'save', cls: 'go' }]
      : [{ label: 'SAVE', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
  });
  if (res.button === 'save' && res.text) await setUserName(res.text.slice(0, 40));
}
$('btn-name').addEventListener('click', () => askName(false));

// ---- profile picture ---------------------------------------------------------------

/** What to show when no picture has been chosen: the user's initial on a plain disc. */
function blankAvatar() {
  const letter = esc((settings.userName || '?')[0].toUpperCase());
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#1b2530"/>`
    + `<text x="48" y="64" font-family="sans-serif" font-size="52" font-weight="700" fill="#18ffff" text-anchor="middle">${letter}</text></svg>`)}`;
}

/** A picture cut to a centred square and scaled down, as a small JPEG data URL. */
async function squarePicture(file, size) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('not a picture'));
      img.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.8);
  } finally {
    URL.revokeObjectURL(url);
  }
}

$('btn-avatar').addEventListener('click', () => $('avatar-file').click());
$('avatar-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    settings.avatar = await squarePicture(file, 96);
  } catch {
    toast('That picture could not be read.', 5000);
    return;
  }
  saveSettings();
  renderSettings();
  applySharing(); // friends see the new picture
});
$('btn-avatar-clear').addEventListener('click', () => {
  delete settings.avatar;
  saveSettings();
  renderSettings();
  applySharing();
});

// ---- live sharing: private unless the user chooses otherwise ---------------------------
//
// See share.js for how it works. In private mode nothing is connected and
// nothing is sent.

const MODES = {
  private: { label: 'Private', pill: 'PRIVATE', note: 'Nothing leaves this phone. Nobody can see you, and you see nobody.' },
  friends: { label: 'Friends only', pill: 'FRIENDS', note: 'People you have given your friend code to can see you while this app is open.' },
  everyone: { label: 'Everyone nearby', pill: 'EVERYONE', note: 'Anyone using this app within roughly 5 km can see you while this app is open.' },
};
const share = new LiveShare({ onChange: () => renderPeople() });

function myCode() {
  if (!settings.friendCode) {
    settings.friendCode = newCode();
    saveSettings();
  }
  return settings.friendCode;
}

function applySharing() {
  return share.configure({
    mode: settings.sharing,
    me: { id: settings.deviceId, name: settings.userName || 'Someone', code: myCode(), avatar: settings.avatar ?? null },
    friends: settings.friends,
  }).then(renderPeople, () => {});
}

function renderPeople() {
  const people = share.list();
  rideMap.setPeople(people);
  const pill = $('share-pill');
  pill.className = `sharepill ${settings.sharing}`;
  pill.textContent = settings.sharing === 'private' ? MODES.private.pill
    : `${MODES[settings.sharing].pill} · ${share.connected ? `${people.length} on map` : 'connecting…'}`;
  // A friend's name arrives with their position: remember it for the list.
  let learned = false;
  for (const p of people) {
    const friend = settings.friends.find((f) => f.code === p.code);
    if (friend && friend.name !== p.name) { friend.name = p.name; learned = true; }
  }
  if (learned) saveSettings();
  if (state.view === 'settings') renderSharing();
}

function renderSharing() {
  const people = share.list(), me = tracker?.good;
  const where = (p) => `${me ? `${fmtDist(haversine(me.lat, me.lon, p.lat, p.lon))} away · ` : ''}${Math.max(0, Math.round((Date.now() - p.at) / 1000))} s ago`;
  $('mode-val').textContent = MODES[settings.sharing].label;
  $('mode-note').textContent = MODES[settings.sharing].note;
  $('code-val').textContent = formatCode(myCode());
  $('friend-list').innerHTML = settings.friends.map((f) => {
    const p = people.find((x) => x.code === f.code);
    const status = p ? `on the map now · ${where(p)}` : settings.sharing === 'private' ? 'hidden while you are in private mode' : 'not sharing right now';
    return `<li data-code="${f.code}"><span class="dot" style="background:${p ? '#ff2bd6' : '#555'}"></span>
      <span>${esc(f.name || `Friend ${formatCode(f.code).slice(0, 4)}…`)} <span class="sub">${status}</span></span>
      <button class="mini del" data-act="remove">Remove</button></li>`;
  }).join('');
  $('people-details').hidden = !people.length;
  $('people-details').querySelector('summary').textContent = `On the map now (${people.length})`;
  $('people-list').innerHTML = people.map((p) => `
    <li><span class="dot" style="background:${p.friend ? '#ff2bd6' : '#fff'}"></span>
      <span>${esc(p.name)} <span class="sub">${p.friend ? 'friend' : 'nearby'}${p.method ? ` · ${esc(p.method)}` : ''}${p.rec ? ' · recording' : ''}</span></span>
      <span class="pct">${where(p)}</span></li>`).join('');
}

async function chooseSharing() {
  const res = await ask({
    title: 'Who can see where you are?',
    body: 'Your position is only sent while this app is open. It is scrambled on this phone before it leaves, and travels through a public relay service on the internet.',
    buttons: [
      ...Object.entries(MODES).map(([key, m]) => ({ label: m.label, value: key, cls: key === settings.sharing ? 'go' : 'ghost' })),
      { label: 'Cancel', value: 'cancel' },
    ],
  });
  if (res.button === 'cancel' || res.button === settings.sharing) return;
  if (res.button === 'everyone') {
    const sure = await ask({
      title: 'Share with everyone nearby?',
      body: 'Anyone using this app within roughly 5 km, including people you do not know, will see your name, picture and position on their map while your app is open.',
      buttons: [{ label: 'Keep it to friends', value: 'friends', cls: 'go' }, { label: 'Yes, everyone nearby', value: 'everyone', cls: 'warn' }, { label: 'Cancel', value: 'cancel' }],
    });
    if (sure.button === 'cancel') return;
    res.button = sure.button;
  }
  settings.sharing = res.button;
  saveSettings();
  await applySharing();
  if (state.view === 'settings') renderSettings();
  toast(`Sharing: ${MODES[settings.sharing].label}`);
}
$('share-pill').addEventListener('click', chooseSharing);
$('btn-mode').addEventListener('click', chooseSharing);

async function addFriend(typed = '') {
  const res = await ask({
    title: 'Add a friend\'s code',
    body: 'Type the 12-character code your friend sent you. You will see them on your map whenever they are sharing. For them to see you, send them your code as well.',
    input: { value: typed, placeholder: 'XXXX-XXXX-XXXX' },
    buttons: [{ label: 'ADD FRIEND', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
  });
  if (res.button !== 'save') return;
  const code = cleanCode(res.text);
  if (!code) { toast('That does not look like a friend code: it is 12 letters and numbers.', 5000); return; }
  if (code === myCode()) { toast('That is your own code.'); return; }
  if (settings.friends.some((f) => f.code === code)) { toast('That friend is already on your list.'); return; }
  settings.friends.push({ code });
  saveSettings();
  await applySharing();
  if (state.view === 'settings') renderSettings();
  toast(settings.sharing === 'private' ? 'Friend added. Turn sharing on to see each other.' : 'Friend added.', 4500);
}
$('btn-friend-add').addEventListener('click', () => addFriend());

$('friend-list').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-act=remove]')) return;
  const friend = settings.friends.find((f) => f.code === e.target.closest('li')?.dataset.code);
  if (!friend) return;
  const res = await ask({
    title: `Remove ${friend.name || 'this friend'}?`,
    body: 'You will stop seeing them. They can still see you if they have your code: to stop that, make yourself a new code.',
    buttons: [{ label: 'Keep', value: 'cancel', cls: 'go' }, { label: 'Remove', value: 'yes', cls: 'stop' }],
  });
  if (res.button !== 'yes') return;
  settings.friends = settings.friends.filter((f) => f !== friend);
  saveSettings();
  await applySharing();
  renderSettings();
});

$('btn-code-share').addEventListener('click', async () => {
  const code = formatCode(myCode());
  const message = {
    title: 'Seeley Trail Tracker friend code',
    text: `Add me on Seeley Trail Tracker so we can see each other on the trail map. My friend code is ${code} (Settings > Friends and sharing > Add a friend's code).`,
    url: `${SHARE_URL}#friend=${code}`,
  };
  if (navigator.share) {
    try { await navigator.share(message); } catch { /* cancelled */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(`${message.text} ${message.url}`);
    toast('Copied. Paste it into a message to your friend.', 4500);
  } catch {
    toast(`Your code is ${code}`, 8000);
  }
});

$('btn-code-new').addEventListener('click', async () => {
  const res = await ask({
    title: 'Make a new friend code?',
    body: 'Everyone who has your current code stops seeing you. You will need to send the new code to the friends you still want.',
    buttons: [{ label: 'Keep my code', value: 'cancel', cls: 'go' }, { label: 'New code', value: 'yes', cls: 'stop' }],
  });
  if (res.button !== 'yes') return;
  settings.friendCode = newCode();
  saveSettings();
  await applySharing();
  renderSettings();
});

$('btn-add-method').addEventListener('click', addMethod);
$('veh-list').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-act=remove]')) return;
  const method = (settings.customVehicles ?? []).find((v) => v.key === e.target.closest('li')?.dataset.key);
  if (!method) return;
  const res = await ask({
    title: `Remove "${method.name}"?`,
    body: 'It will no longer be offered when you start a ride. Rides already recorded with it keep it, and still count in the totals.',
    buttons: [{ label: 'Keep it', value: 'cancel', cls: 'go' }, { label: 'Remove', value: 'yes', cls: 'stop' }],
  });
  if (res.button !== 'yes') return;
  settings.customVehicles = settings.customVehicles.filter((v) => v !== method);
  if (settings.vehicle === method.key) settings.vehicle = 'grizzly';
  saveSettings();
  prefsChanged();
  renderSettings();
});

// ---- scavenger hunt ------------------------------------------------------------------
//
// See hunt.js for what a hunt is. This phone keeps one hunt at a time, with
// what has been found so far, so it is still there after the app is closed:
//   game = { hunt, status: 'draft' | 'active' | 'done', joined, found: { [itemId]: { t, pin } }, startedAt, finishedAt }
// "joined" means the hunt came from someone else and is played as it was sent.

const MAX_HUNT_ITEMS = 40;
let game = readJson('tt-hunt');
if (!game.hunt) game = null;

const huntHistory = () => (Array.isArray(readJson('tt-hunt-history')) ? readJson('tt-hunt-history') : []);
const huntTime = () => (game?.startedAt ? (game.finishedAt ?? Date.now()) - game.startedAt : 0);
const huntScore = () => `${foundCount(game.hunt, game)} of ${game.hunt.items.length}`;
const huntLink = () => `${SHARE_URL}#hunt=${encodeHunt(game.hunt)}`;

function setGame(next) {
  game = next;
  if (game) localStorage.setItem('tt-hunt', JSON.stringify(game)); else localStorage.removeItem('tt-hunt');
  renderHunt();
}

/** The latest position of any quality, or null: for hints, which are not worth a "no GPS" message. */
function hereNow() {
  if (!tracker || Date.now() - state.fixAt > 15000) return null;
  return Date.now() - state.goodAt < 15000 ? tracker.good : tracker.lastFix;
}

async function newNatureHunt() {
  const res = await ask({
    title: 'How many things to find?',
    body: 'Each one is found by taking its photo. The list is picked at random, and you can change it before you start.',
    chips: ['5 things', '8 things', '12 things'],
    pick: true,
    buttons: [{ label: 'Cancel', value: 'cancel' }],
  });
  if (res.button !== 'chip') return;
  setGame({ hunt: { ...natureHunt(parseInt(res.text, 10)), by: settings.userName ?? '' }, status: 'draft', found: {} });
}

function newPlacesHunt() {
  if (state.pins.length < 2) {
    toast('Drop at least two pins first: each pin becomes a place to find.', 5000);
    return;
  }
  // With a great many pins, the newest ones.
  const hunt = placesHunt(state.pins.slice(-MAX_HUNT_ITEMS), `${systemName()} hunt`);
  setGame({ hunt: { ...hunt, by: settings.userName ?? '' }, status: 'draft', found: {} });
}

/** Open a hunt someone sent. `text` is their link or code; without it, ask for one. */
async function joinHunt(text = null) {
  if (text == null) {
    const res = await ask({
      title: 'Join a hunt',
      body: 'Paste the link or the code a friend sent you.',
      input: { placeholder: 'Paste it here' },
      buttons: [{ label: 'JOIN', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
    });
    if (res.button !== 'save' || !res.text) return;
    text = res.text;
  }
  const hunt = decodeHunt(text);
  if (!hunt) {
    toast('That is not a hunt link or code. Ask your friend to send it again.', 5000);
    return;
  }
  if (game?.status === 'active') {
    const sure = await ask({
      title: 'Swap to the new hunt?',
      body: `You are in the middle of "${game.hunt.name}" (${huntScore()} found). Opening "${hunt.name}" ends it.`,
      buttons: [{ label: 'Keep my hunt', value: 'cancel', cls: 'go' }, { label: 'Swap', value: 'yes', cls: 'warn' }],
    });
    if (sure.button !== 'yes') return;
    if (game?.status === 'active') finishHunt();
  }
  setGame({ hunt, status: 'draft', joined: true, found: {} });
  showView('hunt');
}

/** Changes to a hunt that has not started yet. */
async function editHunt(act, item) {
  const hunt = game.hunt;
  const save = [{ label: 'SAVE', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }];
  if (act === 'remove') {
    hunt.items = hunt.items.filter((it) => it !== item);
  } else if (act === 'clue') {
    const res = await ask({
      title: `Clue for "${item.name}"`,
      body: 'One line to help people find it. Leave it empty for no clue.',
      input: { value: item.clue ?? '', placeholder: 'e.g. Where the creek crosses the trail' },
      buttons: save,
    });
    if (res.button !== 'save') return;
    item.clue = res.text.slice(0, 120);
  } else if (act === 'add') {
    if (hunt.items.length >= MAX_HUNT_ITEMS) {
      toast(`A hunt holds up to ${MAX_HUNT_ITEMS} things.`);
      return;
    }
    const have = new Set(hunt.items.map((it) => it.name.toLowerCase()));
    const res = await ask({
      title: 'Add something to photograph',
      input: { placeholder: 'e.g. A red leaf' },
      chips: NATURE_ITEMS.filter((n) => !have.has(n.toLowerCase())).slice(0, 8),
      focus: false,
      buttons: [{ label: 'ADD IT', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
    });
    if (res.button !== 'save' || !res.text) return;
    hunt.items.push(photoItem(res.text.slice(0, 60)));
  } else if (act === 'rename') {
    const res = await ask({ title: 'Name of this hunt', input: { value: hunt.name }, buttons: save });
    if (res.button !== 'save' || !res.text) return;
    hunt.name = res.text.slice(0, 60);
  } else if (act === 'hints') {
    hunt.hints = !hunt.hints;
  }
  setGame(game);
}

function startHunt() {
  if (game?.status !== 'draft') return;
  if (!game.hunt.items.length) {
    toast('Add something to find first.');
    return;
  }
  Object.assign(game, { status: 'active', found: {}, startedAt: Date.now(), finishedAt: null });
  setGame(game);
  if (tracker.geo && !state.gpsWanted) startGps(); // places are found by GPS, and photos are pinned by it
  toast('The hunt is on!');
  const here = hereNow();
  if (here && Date.now() - state.goodAt < 15000) checkHuntPlaces(here);
}

/** Close the hunt that is being played and put it in the list of finished ones. */
function finishHunt() {
  game.status = 'done';
  game.finishedAt = Date.now();
  const entry = { name: game.hunt.name, found: foundCount(game.hunt, game), total: game.hunt.items.length, ms: huntTime(), at: game.finishedAt };
  localStorage.setItem('tt-hunt-history', JSON.stringify([entry, ...huntHistory()].slice(0, 20)));
  setGame(game);
}

function markFound(item, how = {}) {
  if (game?.status !== 'active' || game.found[item.id]) return;
  game.found[item.id] = { t: Date.now(), ...how };
  try { navigator.vibrate?.(200); } catch { /* not allowed, or no buzzer */ }
  if (!isComplete(game.hunt, game)) {
    setGame(game);
    toast(`Found: ${item.name} (${huntScore()})`);
    return;
  }
  finishHunt();
  const line = `All ${game.hunt.items.length} found in ${fmtClock(huntTime())}.`;
  // No question on top of another question, and nothing bright while the phone is in a pocket.
  if ($('dlg').open || !$('pocket').hidden) {
    toast(`Hunt complete! ${line}`, 8000);
    return;
  }
  ask({
    title: 'Hunt complete!',
    body: line,
    buttons: [{ label: 'SHARE MY RESULT', value: 'share', cls: 'go' }, { label: 'OK', value: 'cancel' }],
  }).then((res) => { if (res.button === 'share') shareResult(); });
}

/** Called with every good GPS position: has it brought us to one of the places? */
function checkHuntPlaces(fix) {
  if (game?.status !== 'active') return;
  for (const item of placesReached(game.hunt, game, fix)) markFound(item);
}

async function endHunt() {
  const res = await ask({
    title: 'End this hunt?',
    body: `${huntScore()} found so far. It goes in your list of finished hunts as it stands.`,
    buttons: [{ label: 'Keep hunting', value: 'cancel', cls: 'go' }, { label: 'End hunt', value: 'yes', cls: 'stop' }],
  });
  if (res.button === 'yes' && game?.status === 'active') finishHunt();
}

/** Hand a message to the phone's share sheet, or copy it where there is none. */
async function shareMessage(message, copied) {
  if (navigator.share) {
    try { await navigator.share(message); } catch { /* cancelled */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(`${message.text} ${message.url}`);
    toast(copied, 4500);
  } catch {
    toast(message.url, 8000);
  }
}

const HOW_TO_JOIN = 'Open this link to play. (If it opens outside the app, copy the link and use Play > Join a hunt in the app.)';
const sendHunt = () => shareMessage({
  title: game.hunt.name,
  text: `Join my scavenger hunt "${game.hunt.name}" on Seeley Trail Tracker: ${game.hunt.items.length} things to find. ${HOW_TO_JOIN}`,
  url: huntLink(),
}, 'Copied. Paste it into a message to your friends.');
const shareResult = () => shareMessage({
  title: game.hunt.name,
  text: `I found ${huntScore()} in the scavenger hunt "${game.hunt.name}" on Seeley Trail Tracker, in ${fmtClock(huntTime())}. Can you beat that? ${HOW_TO_JOIN}`,
  url: huntLink(),
}, 'Copied. Paste it into a message.');

function huntRow(item, i) {
  const found = game.found[item.id], playing = game.status === 'active', editing = game.status === 'draft' && !game.joined;
  const pin = found?.pin ? state.pins.find((p) => p.id === found.pin) : null;
  const how = item.kind === 'place' ? `Get yourself there (within ${REACH} m)` : 'Take its photo';
  const when = found ? ` · found at ${new Date(found.t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : '';
  const acts = editing ? '<button data-act="clue">Clue</button><button data-act="remove" class="del">Remove</button>'
    : playing && !found && item.kind === 'photo' ? '<button data-act="photo" class="go">TAKE PHOTO</button><button data-act="tick">Just tick it</button>' : '';
  return `
    <li class="hunt-item ${found ? 'found' : ''}" data-id="${esc(item.id)}">
      ${pin?.thumb ? `<img class="thumb" src="${esc(pin.thumb)}" alt="" data-act="view">` : `<div class="mark">${found ? '✓' : i + 1}</div>`}
      <div><div class="name">${esc(item.name)}</div>
        <div class="meta">${how}${when}</div>
        ${item.clue ? `<div class="meta">Clue: <b>${esc(item.clue)}</b></div>` : ''}
        ${playing && !found && item.kind === 'place' && game.hunt.hints ? `<div class="hintline" data-hint="${esc(item.id)}"></div>` : ''}</div>
      ${acts ? `<div class="acts">${acts}</div>` : ''}
    </li>`;
}

function renderHunt() {
  const pill = $('hunt-pill');
  pill.hidden = game?.status !== 'active';
  if (!pill.hidden) pill.textContent = `HUNT ${foundCount(game.hunt, game)}/${game.hunt.items.length}`;
  if (state.view !== 'hunt') return;

  const past = huntHistory();
  $('hunt-past').hidden = !past.length;
  $('hunt-history').innerHTML = past.map((h) => `
    <li><span class="dot" style="background:${h.found === h.total ? 'var(--go)' : '#555'}"></span>
      <span>${esc(h.name)} <span class="sub">${fmtDate(h.at)} · ${fmtClock(h.ms)}</span></span>
      <span class="pct">${h.found} of ${h.total}</span></li>`).join('');

  const body = $('hunt-body');
  if (!game) {
    body.innerHTML = `
      <p class="hint">A list of things to find out on the trail. Photograph each one, or get yourself to each place. Send the same hunt to friends and family and see who finishes first.</p>
      <div class="hunt-btns">
        <button class="big go" data-act="nature">NATURE PHOTO HUNT</button>
        <p class="hint">Things to spot and photograph: a mushroom, animal tracks, a bird nest. Each photo is pinned to the map where you took it.</p>
        <button class="big info" data-act="places">PLACES HUNT FROM MY PINS</button>
        <p class="hint">Every pin you have dropped becomes a place to find. The app ticks each one off when you get within ${REACH} m of it.</p>
        <button class="big ghost" data-act="join">JOIN A HUNT A FRIEND SENT</button>
      </div>
      <p class="hint">Want the walk recorded too? Press <b>START</b> on the Record screen first. The hunt carries on either way.</p>`;
    return;
  }
  const { hunt, status } = game;
  const count = `${hunt.items.length} thing${hunt.items.length === 1 ? '' : 's'} to find`;
  const from = hunt.by && (game.joined || hunt.by !== settings.userName) ? ` · from ${esc(hunt.by)}` : '';
  const places = hunt.items.some((it) => it.kind === 'place');
  const list = `<ul class="list">${hunt.items.map(huntRow).join('')}</ul>`;
  if (status === 'draft') {
    body.innerHTML = `
      <div class="hunt-head"><b>${esc(hunt.name)}</b><small>${count}${from} · not started yet</small></div>
      <div class="hunt-btns">
        <button class="big go" data-act="start">START HUNT</button>
        <button class="big info" data-act="send">SEND THIS HUNT TO FRIENDS</button>
      </div>
      ${places ? `<p class="hint">${hunt.hints ? 'Distance hints are on: players see how far away each place is, and in which direction.' : 'Distance hints are off: players get the names and clues only.'}${game.joined ? '' : ' Sending this hunt sends the positions of these places to whoever you send it to.'}</p>` : ''}
      ${list}
      ${game.joined ? '' : `<div class="btnrow">
        <button class="mid" data-act="add">Add something to photograph</button>
        <button class="mid ghost" data-act="rename">Rename</button>
        ${places ? `<button class="mid ghost" data-act="hints">Turn hints ${hunt.hints ? 'off' : 'on'}</button>` : ''}
      </div>`}
      <div class="btnrow"><button class="mid ghost" data-act="cancel">Throw this hunt away</button></div>`;
  } else if (status === 'active') {
    body.innerHTML = `
      <div class="hunt-head"><b>${esc(hunt.name)}</b><div class="score">${huntScore()} found</div>
        <small><span id="hunt-clock">${fmtClock(huntTime())}</span>${from}</small></div>
      ${list}
      <div class="btnrow">
        <button class="mid" data-act="send">Send this hunt to friends</button>
        <button class="mid stop" data-act="end">End hunt</button>
      </div>`;
    updateHuntLive();
  } else {
    body.innerHTML = `
      <div class="hunt-head"><b>${esc(hunt.name)}</b><div class="score">${huntScore()} found</div>
        <small>in ${fmtClock(huntTime())} · finished ${fmtDate(game.finishedAt)}${from}</small></div>
      <div class="hunt-btns"><button class="big go" data-act="result">SHARE MY RESULT</button></div>
      ${list}
      <div class="btnrow">
        <button class="mid" data-act="again">Play it again</button>
        <button class="mid ghost" data-act="new">Start a different hunt</button>
      </div>`;
  }
}

/** The parts of the hunt screen that change by themselves: the clock, and how far away each place is. */
function updateHuntLive() {
  if (state.view !== 'hunt' || game?.status !== 'active') return;
  const clock = $('hunt-clock');
  if (clock) clock.textContent = fmtClock(huntTime());
  const here = hereNow();
  for (const el of $('hunt-body').querySelectorAll('[data-hint]')) {
    const item = game.hunt.items.find((it) => it.id === el.dataset.hint);
    el.textContent = !item ? '' : here ? hintFor(item, here) : 'Waiting for a GPS position…';
  }
}

$('hunt-body').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'nature') { await newNatureHunt(); return; }
  if (act === 'places') { newPlacesHunt(); return; }
  if (act === 'join') { await joinHunt(); return; }
  if (!game) return;
  const item = game.hunt.items.find((it) => it.id === e.target.closest('li')?.dataset.id);
  if (act === 'photo' && item) {
    takePhoto(item.id); // straight from the tap, or the phone refuses to open the camera
  } else if (act === 'tick' && item) {
    markFound(item);
  } else if (act === 'view' && item) {
    const pin = state.pins.find((p) => p.id === game.found[item.id]?.pin);
    if (pin) await viewPhoto(pin);
  } else if (act === 'start') {
    startHunt();
  } else if (act === 'send') {
    await sendHunt();
  } else if (act === 'result') {
    await shareResult();
  } else if (act === 'end') {
    await endHunt();
  } else if (act === 'again') {
    setGame({ hunt: game.hunt, status: 'draft', joined: game.joined, found: {} });
  } else if (act === 'new') {
    setGame(null);
  } else if (act === 'cancel') {
    if (!game.joined && game.hunt.items.some((it) => it.clue)) {
      const res = await ask({
        title: 'Throw this hunt away?',
        body: 'The clues you wrote go with it.',
        buttons: [{ label: 'Keep it', value: 'cancel', cls: 'go' }, { label: 'Throw it away', value: 'yes', cls: 'stop' }],
      });
      if (res.button !== 'yes') return;
    }
    setGame(null);
  } else if (game.status === 'draft' && !game.joined && ['remove', 'clue', 'add', 'rename', 'hints'].includes(act)) {
    await editHunt(act, item);
  }
});
$('hunt-pill').addEventListener('click', () => showView('hunt'));

// ---- challenges ----------------------------------------------------------------------------
//
// "I did a 3 km walk today. Can you beat me?" A challenge is a shared scoreboard
// in the cloud (rules and cloud calls: challenge.js). This phone posts how far
// its owner went each day, worked out from the saved outings; nothing else leaves it.
// Each entry here: { ch: the challenge, team, scores: the board as last fetched, at, sent, announced }.

let chal = readJson('tt-challenges');
if (!Array.isArray(chal.list)) chal = { list: [], seen: [] };
chal.seen ??= [];
const saveChal = () => localStorage.setItem('tt-challenges', JSON.stringify(chal));
const today = () => dayOf(Date.now());
const myName = () => settings.userName || 'Someone';
const outings = () => doneRides().map((r) => ({ t: r.startedAt ?? r.id, dist: r.dist ?? 0, ms: movingOf(r) || timeOf(r), method: methodOf(r), noun: nounOf(r) }));
const lengthText = (ch) => (ch.days === 1 ? `${dayLabel(ch.start)} only` : ch.days ? `${dayLabel(ch.start)} to ${dayLabel(lastDayOf(ch))}` : `from ${dayLabel(ch.start)}, no end date`);
const NEEDS_SIGNAL = 'That needs a signal. Try again when you have one.';

/** What this phone's owner did today that counts: { by, dist, noun }, or null if nothing yet. */
function myDare(ch) {
  const mine = outings().filter((o) => dayOf(o.t) === today() && countsFor(ch.kind, o.method));
  const dist = mine.reduce((sum, o) => sum + o.dist, 0);
  if (!(dist > 0)) return null;
  const nouns = [...new Set(mine.map((o) => o.noun))];
  return { by: myName(), dist, noun: nouns.length === 1 ? nouns[0] : ch.kind === 'wheels' ? 'ride' : 'outing' };
}
const dareText = (dare) => `${fmtDist(dare.dist)} ${dare.noun}`;

/** Post this phone's daily totals to one challenge and fetch the board. Throws with no signal. */
async function refreshChallenge(entry) {
  const { ch } = entry, t = today();
  if (isOver(ch, addDays(t, -7))) return; // long finished: the board no longer changes
  const totals = totalsByDay(ch, outings());
  if (inChallenge(ch, t)) totals[t] ??= { dist: 0, ms: 0 }; // on the board from the moment of joining
  const days = Object.entries(totals).filter(([day]) => day >= addDays(t, -6))
    .map(([day, v]) => ({ day, dist: Math.round(v.dist), ms: Math.round(v.ms) }));
  const key = JSON.stringify([myName(), entry.team, days]);
  if (days.length && key !== entry.sent) {
    await postScores(ch.id, settings.deviceId, myName(), entry.team, days);
    entry.sent = key;
  }
  const got = await fetchChallenge(ch.id);
  if (got) { entry.scores = got.scores; entry.at = Date.now(); }
  saveChal();
}

let chalBusy = false, chalAt = 0;
/** Bring every challenge up to date, then say who won yesterday (once). Quietly does nothing with no signal. */
async function refreshChallenges(force = false) {
  if (chalBusy || !chal.list.length || !navigator.onLine || (!force && Date.now() - chalAt < 60000)) return;
  chalBusy = true;
  chalAt = Date.now();
  try {
    for (const entry of chal.list) await refreshChallenge(entry).catch(() => {});
  } finally {
    chalBusy = false;
  }
  renderChallenges();
  const yesterday = addDays(today(), -1), news = [];
  for (const entry of chal.list) {
    if (!entry.at || entry.announced === yesterday || !inChallenge(entry.ch, yesterday)) continue;
    entry.announced = yesterday;
    const w = winnerOf(entry.ch, entry.scores ?? [], yesterday);
    if (w) news.push(`Yesterday's winner in "${entry.ch.name}": ${w.name}, ${fmtDist(w.dist)}${w.tie ? ' each' : ''}.`);
  }
  saveChal();
  if (news.length && !$('dlg').open) toast(news.join(' '), 9000);
}

function challengeCard(entry, t) {
  const { ch } = entry, scores = entry.scores ?? [], over = isOver(ch, t);
  const day = over ? null : t; // a finished challenge shows its final totals
  const board = standings(ch, scores, day);
  const row = (name, sub, dist, mine, i, you = '(you)') => `
    <li><span class="dot" style="background:${mine ? 'var(--go)' : '#555'}"></span>
      <span>${i + 1}. ${esc(name)}${mine ? ` <b>${you}</b>` : ''}${sub ? ` <span class="sub">${esc(sub)}</span>` : ''}</span>
      <span class="pct">${fmtDist(dist)}</span></li>`;
  // One plain sentence on where this phone's owner stands today.
  const rows = ch.teams?.length ? board.teams.map((x) => ({ me: x.team === entry.team, name: x.team, dist: x.dist })) : board.people.map((p) => ({ me: p.player === settings.deviceId, name: p.name, dist: p.dist }));
  const me = rows.find((x) => x.me), top = rows[0], next = rows.find((x) => !x.me);
  const us = ch.teams?.length ? 'Your team is' : 'You are';
  const standing = over || !me ? ''
    : !(me.dist > 0) ? `Nothing counted for you yet today. Press <b>START</b> on the Record screen, then <b>FINISH</b> when you are back: it is added here by itself.`
      : rows.length < 2 || !(next?.dist > 0) ? `You have ${fmtDist(me.dist)} today. Nobody else has gone out yet.`
        : top.me ? `${us} in the lead today, ${fmtDist(me.dist - next.dist)} ahead of ${esc(next.name)}.`
          : `${esc(top.name)} is ${fmtDist(top.dist - me.dist)} ahead of ${ch.teams?.length ? 'your team' : 'you'} today.`;
  const teams = ch.teams?.length
    ? `<ul class="coverage card">${board.teams.map((x, i) => row(x.team, `${x.players} ${x.players === 1 ? 'person' : 'people'}`, x.dist, x.team === entry.team, i, '(your team)')).join('')}</ul>` : '';
  const people = board.people.length
    ? `<ul class="coverage card">${board.people.map((p, i) => row(p.name, p.team, p.dist, p.player === settings.deviceId, i)).join('')}</ul>`
    : '<p class="hint">Nobody is on the board yet.</p>';
  const overall = !over && ch.days !== 1 ? standings(ch, scores).people.slice(0, 3).map((p) => `${esc(p.name)} ${fmtDist(p.dist)}`).join(' · ') : '';
  const won = dailyWinners(ch, scores, t, 1)[0];
  const final = over ? (ch.teams?.length ? board.teams[0] && { name: board.teams[0].team, dist: board.teams[0].dist } : board.people[0]) : null;
  return `
    <div class="chal" data-id="${ch.id}">
      <div class="hunt-head"><b>${esc(ch.name)}</b>
        <small>${CHALLENGE_KINDS[ch.kind].label} · ${lengthText(ch)}${ch.by && ch.by !== myName() ? ` · from ${esc(ch.by)}` : ''}${entry.team ? ` · you are on ${esc(entry.team)}` : ''}</small></div>
      ${over ? `<p class="hint"><b>Finished.</b> ${final?.dist > 0 ? `${esc(final.name)} won with ${fmtDist(final.dist)}.` : 'Nobody went anywhere.'} Final totals:</p>` : `<p class="chal-now">${standing}</p><p class="hint"><b>Today so far</b></p>`}
      ${teams}${people}
      ${overall ? `<p class="hint">Whole challenge so far: ${overall}</p>` : ''}
      ${won && !over ? `<p class="hint">${dayLabel(won.day)}: <b>${esc(won.name)}</b> won with ${fmtDist(won.dist)}${won.tie ? ' each' : ''}.</p>` : ''}
      <div class="btnrow">
        ${over ? '' : '<button class="mid" data-act="invite">Invite more people</button>'}
        <button class="mid ghost" data-act="days">Past winners</button>
        <button class="mid ghost" data-act="leave">${over ? 'Remove' : 'Leave challenge'}</button>
      </div>
    </div>`;
}

function renderChallenges() {
  if (state.view !== 'hunt') return;
  const t = today();
  $('chal-body').innerHTML = `
    ${chal.list.map((entry) => challengeCard(entry, t)).join('')}
    ${chal.list.length ? '' : `<p class="hint">See who can go furthest: you, your friends or your family.</p>
      <ol class="steps">
        <li>Tap <b>START A CHALLENGE</b> and send it to people.</li>
        <li>Everyone records their walks and rides as usual. The app adds up how far each person goes.</li>
        <li>A winner is named every day.</li>
      </ol>
      <p class="hint">Only names and distances are shared. Nobody sees where you are.</p>`}
    <div class="hunt-btns">
      <button class="big go" data-act="new">${chal.list.length ? 'START ANOTHER CHALLENGE' : 'START A CHALLENGE'}</button>
      <button class="big ghost" data-act="join">I WAS SENT A CHALLENGE LINK</button>
    </div>
    <p class="hint">Sent a challenge? Just tap the link in the message. Use the second button only if the link did not open the app.</p>`;
}

/** Make a challenge. With `quick` ({ name, kind, days }) nothing is asked. Returns its entry, or null. */
async function newChallenge(quick = null) {
  let { name, kind, days } = quick ?? {};
  let teams = [], team = '';
  if (!quick) {
    // Two ready-made challenges cover most people; the questions below are only for "set it up myself".
    const easy = await ask({
      title: 'Start a challenge',
      body: 'Pick one. You can invite people as soon as it is made.',
      buttons: [
        { label: 'WHO GOES FURTHEST TODAY', value: 'today', cls: 'go' },
        { label: 'WHO GOES FURTHEST THIS WEEK', value: 'week', cls: 'info' },
        { label: 'Set it up myself (teams, length…)', value: 'custom' },
        { label: 'Cancel', value: 'cancel' },
      ],
    });
    if (easy.button === 'cancel') return null;
    if (easy.button === 'today') quick = { name: `${myName()}'s challenge for today`, kind: 'any', days: 1 };
    if (easy.button === 'week') quick = { name: `${myName()}'s 7-day challenge`, kind: 'any', days: 7 };
    if (quick) ({ name, kind, days } = quick);
  }
  if (!quick) {
    const named = await ask({
      title: 'New challenge',
      body: 'Give it a name your friends will recognise.',
      input: { value: `${myName()}'s challenge`, placeholder: 'e.g. November walking challenge' },
      buttons: [{ label: 'NEXT', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
    });
    if (named.button !== 'save') return null;
    name = named.text || `${myName()}'s challenge`;
    const what = await ask({
      title: 'What counts?',
      body: 'Each person\'s distance for the day is added up from the outings they save.',
      buttons: [...Object.entries(CHALLENGE_KINDS).map(([key, k], i) => ({ label: k.label, value: key, cls: i ? 'ghost' : 'go' })), { label: 'Cancel', value: 'cancel' }],
    });
    if (what.button === 'cancel') return null;
    kind = what.button;
    const long = await ask({
      title: 'How long does it run?',
      body: 'It starts today. A winner is named for every day.',
      buttons: [{ label: 'Today only', value: '1', cls: 'go' }, { label: '7 days', value: '7' }, { label: '30 days', value: '30' }, { label: 'No end date', value: '0' }, { label: 'Cancel', value: 'cancel' }],
    });
    if (long.button === 'cancel') return null;
    days = Number(long.button);
    const sides = await ask({
      title: 'Teams?',
      body: 'With teams, each team\'s distances are added together and the team that goes furthest wins the day.',
      buttons: [{ label: 'Everyone for themselves', value: 'solo', cls: 'go' }, { label: 'Set up teams', value: 'teams' }, { label: 'Cancel', value: 'cancel' }],
    });
    if (sides.button === 'cancel') return null;
    if (sides.button === 'teams') {
      const res = await ask({
        title: 'Team names',
        body: 'Type the team names with commas between them. Two to six teams.',
        input: { value: 'Red, Blue', placeholder: 'e.g. Red, Blue' },
        buttons: [{ label: 'NEXT', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
      });
      if (res.button !== 'save') return null;
      teams = [...new Set(res.text.split(',').map((s) => s.trim().slice(0, 24)).filter(Boolean))].slice(0, 6);
      if (teams.length < 2) { toast('A team challenge needs at least two team names.', 5000); return null; }
      const mine = await ask({ title: 'Which team are you on?', buttons: [...teams.map((x, i) => ({ label: x, value: x, cls: i ? 'ghost' : 'go' })), { label: 'Cancel', value: 'cancel' }] });
      if (mine.button === 'cancel') return null;
      team = mine.button;
    }
  }
  const entry = { ch: { id: newChallengeId(), name: name.slice(0, 60), kind, start: today(), days, teams, by: myName() }, team, scores: [] };
  try { await createChallenge(entry.ch); } catch (err) { toast(err.refused ? err.message : NEEDS_SIGNAL, 5000); return null; }
  chal.list.unshift(entry);
  saveChal();
  await refreshChallenge(entry).catch(() => {});
  renderChallenges();
  return entry;
}

/** Straight from a finished outing: "beat my 3 km walk", today only. */
async function quickDare(ride) {
  const kind = methodOf(ride).kind === 'foot' ? 'foot' : 'wheels';
  const entry = await newChallenge({ name: `Beat ${myName()}'s ${nounOf(ride)} today`, kind, days: 1 });
  if (entry) await inviteTo(entry);
}

/** Send a challenge out: to friends inside the app, or as a link by any other means. */
async function inviteTo(entry) {
  const { ch } = entry, dare = myDare(ch), friends = settings.friends;
  const pitch = dare ? `I did a ${dareText(dare)} today on Seeley Trail Tracker. Can you beat me?` : `Join my challenge "${ch.name}" on Seeley Trail Tracker. Can you beat me?`;
  const res = await ask({
    title: 'Send this challenge',
    body: `Your message will say:\n"${pitch}"\n\n${friends.length ? 'Friends on your list see it the next time they open the app. For anyone else, send it by text or email.' : 'Send it the way you send any message.'} When they tap the link they are in. If they do not have the app yet, the link gets it for them first.`,
    buttons: [
      ...(friends.length ? [{ label: `SEND TO MY ${friends.length === 1 ? 'FRIEND' : `${friends.length} FRIENDS`} IN THE APP`, value: 'app', cls: 'go' }] : []),
      { label: 'SEND BY TEXT OR EMAIL', value: 'link', cls: friends.length ? 'info' : 'go' },
      { label: 'Not now', value: 'cancel' },
    ],
  });
  if (res.button === 'app') {
    try {
      const title = dare ? `${dare.by} did a ${dareText(dare)} today. Can you beat that?` : `${myName()} invites you to "${ch.name}".`;
      await sendInvites(friends.map((f) => f.code), ch.id, myName(), title);
      toast(`Sent to ${friends.length === 1 ? 'your friend' : `${friends.length} friends`}. They see it when they next open the app.`, 6000);
    } catch (err) { toast(err.refused ? err.message : NEEDS_SIGNAL, 5000); }
  } else if (res.button === 'link') {
    await shareMessage({ title: ch.name, text: `${pitch} Open this link to join in:`, url: challengeLink(SHARE_URL, ch.id, dare) }, 'Copied. Paste it into a message to your friends.');
  }
}

/**
 * Join a challenge from a link (…#challenge=ID), a pasted link, or an invitation left by a friend.
 * @returns true if the question was answered either way (so an invitation is not asked about again)
 */
async function joinChallenge(text = null, intro = '') {
  if (text == null) {
    const res = await ask({
      title: 'Join a challenge',
      body: 'Paste the link your friend sent you.',
      input: { value: '', placeholder: 'Paste the link here' },
      buttons: [{ label: 'JOIN', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
    });
    if (res.button !== 'save') return false;
    text = res.text;
  }
  const link = readChallengeLink(text);
  if (!link) { toast('That is not a challenge link. Ask your friend to send it again.', 5000); return false; }
  if (chal.list.some((e) => e.ch.id === link.id)) {
    showView('hunt');
    toast('You are already in that challenge.');
    return true;
  }
  let got;
  try { got = await fetchChallenge(link.id); } catch { toast(NEEDS_SIGNAL, 5000); return false; }
  if (!got) { toast('That challenge no longer exists.', 5000); return true; }
  const ch = got.challenge, people = new Set(got.scores.map((s) => s.player)).size;
  if (isOver(ch, today())) { toast(`"${ch.name}" has already finished.`, 5000); return true; }
  const dare = link.dare ? `${link.dare.by} did a ${dareText(link.dare)}. Can you beat that?\n\n` : intro ? `${intro}\n\n` : '';
  const res = await ask({
    title: ch.name,
    body: `${dare}Counts: ${CHALLENGE_KINDS[ch.kind].text}. Runs ${lengthText(ch)}. ${people ? `${people} ${people === 1 ? 'person is' : 'people are'} in so far.` : ''}\n\nJoining shares your name and how far you go each day with the others in it. It never shares where you are.${ch.teams.length ? '\n\nPick your team:' : ''}`,
    buttons: [
      ...(ch.teams.length ? ch.teams.map((x, i) => ({ label: x, value: `team:${x}`, cls: i ? 'ghost' : 'go' })) : [{ label: 'I\'M IN', value: 'team:', cls: 'go' }]),
      { label: 'Not now', value: 'cancel' },
    ],
  });
  if (!res.button.startsWith('team:')) return true;
  const entry = { ch: { id: ch.id, name: ch.name, kind: ch.kind, start: ch.start, days: ch.days, teams: ch.teams, by: ch.by }, team: res.button.slice(5), scores: got.scores };
  chal.list.unshift(entry);
  saveChal();
  showView('hunt');
  toast('You are in. Save a walk or ride today and it counts.', 5000);
  refreshChallenge(entry).then(renderChallenges, () => {});
  return true;
}

/** Challenges friends sent through the app: asked about once each. */
async function checkInbox() {
  if (!settings.friendCode || !navigator.onLine || state.current || $('dlg').open) return;
  let invites;
  try { invites = await fetchInvites(settings.friendCode); } catch { return; }
  for (const inv of invites) {
    if (chal.seen.includes(inv.challenge) || chal.list.some((e) => e.ch.id === inv.challenge) || $('dlg').open) continue;
    if (await joinChallenge(inv.challenge, inv.title || `${inv.from} sent you a challenge.`)) {
      chal.seen = [...chal.seen, inv.challenge].slice(-100);
      saveChal();
    }
  }
}

$('chal-body').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'new') {
    const entry = await newChallenge();
    if (entry) await inviteTo(entry);
    return;
  }
  if (act === 'join') { await joinChallenge(); return; }
  const entry = chal.list.find((x) => x.ch.id === e.target.closest('.chal')?.dataset.id);
  if (!entry) return;
  if (act === 'invite') await inviteTo(entry);
  else if (act === 'days') {
    const days = dailyWinners(entry.ch, entry.scores ?? [], today());
    await ask({
      title: `${entry.ch.name}: daily winners`,
      body: days.length ? days.map((d) => `${dayLabel(d.day)}: ${d.name}, ${fmtDist(d.dist)}${d.tie ? ' each' : ''}`).join('\n') : 'No day has finished yet. The first winner is named tomorrow.',
      buttons: [{ label: 'OK', value: 'cancel', cls: 'go' }],
    });
  } else if (act === 'leave') {
    const res = await ask({
      title: `Leave "${entry.ch.name}"?`,
      body: 'It comes off this phone and your later outings stop counting. What you already did stays on the board for the others.',
      buttons: [{ label: 'Stay in', value: 'cancel', cls: 'go' }, { label: 'Leave', value: 'yes', cls: 'stop' }],
    });
    if (res.button !== 'yes') return;
    chal.list = chal.list.filter((x) => x !== entry);
    saveChal();
    renderChallenges();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tracker) refreshChallenges().then(checkInbox, () => {});
});

// ---- sending rides to the owner's map ---------------------------------------------------
//
// See transfer.js. The computer that keeps the trail map listens with a
// one-time code, which reaches this phone in a link (…#map=CODE). Nothing is
// sent until the user says so here.

let sendingMap = false;

/** What the map needs: every saved ride with its points, the pins (without pictures) and the branch names. */
const mapPackage = () => ({
  app: 'trail-tracker', format: 1, kind: 'rides-for-map', version: VERSION, sentAt: new Date().toISOString(),
  contributor: settings.userName, system: systemName(),
  rides: doneRides().map((r) => ({ ...r, points: (state.tracks.get(r.id) ?? []).flat() })),
  pins: state.pins.map(({ thumb, ...pin }) => pin),
  branches: state.branches,
});

async function sendToMap(code = localStorage.getItem('tt-map-code')) {
  if (sendingMap) return;
  const rides = doneRides();
  if (!rides.length) {
    toast('There are no saved rides to send yet.');
    return;
  }
  if (!code) {
    const res = await ask({
      title: 'Send rides to my map',
      body: 'Paste the send link from the computer that keeps your trail map.',
      input: { placeholder: 'Paste the link here' },
      buttons: [{ label: 'NEXT', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
    });
    if (res.button !== 'save') return;
    code = cleanTransferCode(res.text);
    if (!code) {
      toast('That is not a send link. Ask for a new one.', 5000);
      return;
    }
  }
  localStorage.setItem('tt-map-code', code);
  const res = await ask({
    title: 'Send your rides to your map?',
    body: `${rides.length} ride${rides.length === 1 ? '' : 's'} (${fmtDist(rides.reduce((d, r) => d + (r.dist ?? 0), 0))}) and ${state.pins.length} pin${state.pins.length === 1 ? '' : 's'} go to the computer that keeps your trail map. They are scrambled on this phone and pass through a public relay service on the internet. Photos stay on this phone.`,
    buttons: [{ label: 'SEND', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
  });
  if (res.button !== 'save') return;
  sendingMap = true;
  toast('Sending… 0%', 600000);
  let failure = null;
  try {
    const got = await sendPackage(code, new TextEncoder().encode(JSON.stringify(mapPackage())), {
      onProgress: (p) => toast(`Sending… ${Math.round(p * 100)}%`, 600000),
    });
    toast(`Received by your map computer: ${got.rides ?? rides.length} ride(s), ${(got.points ?? 0).toLocaleString()} GPS points, ${got.pins ?? 0} pin(s).`, 10000);
  } catch (err) {
    failure = {
      offline: 'The relay could not be reached. Check that you have a signal, then try again.',
      nobody: 'Your map computer is not listening for this link any more. Ask for a new send link, then tap it.',
    }[err.message] ?? 'The send started but did not finish. Try again where the signal is better.';
  } finally {
    sendingMap = false;
  }
  if (!failure) return;
  toast('Not sent', 1500);
  const again = await ask({ title: 'Not sent', body: failure, buttons: [{ label: 'TRY AGAIN', value: 'save', cls: 'go' }, { label: 'Close', value: 'cancel' }] });
  if (again.button === 'save') await sendToMap(code);
}
$('btn-send-map').addEventListener('click', () => sendToMap());

// ---- cloud sync -----------------------------------------------------------------------
//
// See sync.js. Off until the user turns it on. With it on, this device's rides,
// pins, photos and branch names are kept in step with the family's database
// whenever there is a signal, so they can be seen and changed on any of the
// family's phones and computers.

const cloud = { code: localStorage.getItem('tt-sync-code'), busy: false, at: 0, error: null, again: false };
const sharedPrefs = {
  get: () => ({ systemName: settings.systemName ?? null, customVehicles: settings.customVehicles ?? [] }),
  set: (data) => {
    if (data.systemName) settings.systemName = String(data.systemName).slice(0, 60);
    if (Array.isArray(data.customVehicles)) settings.customVehicles = data.customVehicles;
    saveSettings();
  },
};
/** The shared settings changed on this device: pass them on at the next sync. */
const prefsChanged = () => { if (cloud.code) db.touch('kv', 'prefs').then(syncSoon, () => {}); };

function renderCloud() {
  const on = !!cloud.code;
  const when = cloud.at ? new Date(cloud.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  $('sync-info').textContent = !on
    ? 'Off. Your rides are kept on this device only. Turn it on to keep a copy in your Cloudflare database and to see and change your rides on your other phones and computers.'
    : cloud.busy ? 'On. Syncing now…'
      : cloud.error ? `On, but the last sync did not get through (${cloud.error}). It will try again by itself.`
        : when ? `On. Everything was in step at ${when}.` : 'On. Waiting for a signal to sync.';
  for (const id of ['btn-sync-on', 'btn-sync-join']) $(id).hidden = on;
  for (const id of ['btn-sync-add', 'btn-sync-now', 'btn-sync-off']) $(id).hidden = !on;
  $('btn-sync-move').hidden = !on || !OLD_HOME;
  $('auto-upload-wrap').hidden = !on;
  $('auto-upload').checked = !!settings.autoUpload;
}
// "Upload every finished walk by itself": on, a finished outing goes to the cloud without the question being asked.
$('auto-upload').addEventListener('change', (e) => {
  settings.autoUpload = e.target.checked;
  saveSettings();
  toast(settings.autoUpload ? 'Each walk or ride will upload by itself when you finish it.' : 'You will be asked after each walk or ride.', 5000);
});

// The app used to live on GitHub. A phone still opening it from there keeps its
// rides in that address's storage, so the way across is: sync them to the
// cloud here, then open the new address with the same family code.
const OLD_HOME = location.hostname.endsWith('github.io');
$('btn-sync-move').addEventListener('click', async () => {
  await runSync(true);
  if (cloud.error) return; // not everything is in the cloud yet
  location.href = `${SHARE_URL}#sync=${cloud.code}&moved=1`;
});

/**
 * Opened at the old address: go to the new one, taking the rides along, without
 * the user having to do anything. Returns true if the new address is being opened.
 *  - nothing on this device (a new user with an old link): straight across;
 *  - cloud sync already on: sync, then across with the family code, so the new
 *    address shows the same rides. This happens every time the old icon is used;
 *  - rides here but sync off: ask once (and not again for a week), since moving
 *    them means putting a copy in the cloud.
 * With no signal, or a ride left unfinished, the old address simply carries on working.
 */
async function leaveOldHome() {
  if (!navigator.onLine || state.rides.some((r) => r.status !== 'done')) return false;
  if (!state.rides.length && !state.pins.length && !cloud.code) {
    location.replace(SHARE_URL + location.hash); // a friend, hunt or challenge link carries on working
    return true;
  }
  if (cloud.code) await runSync();
  else {
    if (Date.now() - Number(localStorage.getItem('tt-move-asked') ?? 0) < 7 * 86400000) return false;
    localStorage.setItem('tt-move-asked', String(Date.now()));
    const res = await ask({
      title: 'This app has a new home',
      body: 'Your walks, rides and pins can come with you. It needs a signal and takes a moment: they are copied to your own cloud storage, then the app opens at its new home with everything in it.',
      buttons: [{ label: 'MOVE THEM NOW', value: 'save', cls: 'go' }, { label: 'Later', value: 'cancel' }],
    });
    if (res.button !== 'save') return false;
    await useSyncCode(cleanSyncCode(localStorage.getItem('tt-sync-code-last')) ?? newSyncCode());
  }
  if (cloud.error || !cloud.at) return false; // not everything is in the cloud yet: try again next time
  location.replace(`${SHARE_URL}#sync=${cloud.code}&moved=1`);
  return true;
}

/** Exchange changes with the cloud now, unless something is in the way (a ride being recorded, a question on screen). */
async function runSync(manual = false) {
  if (!cloud.code) return;
  if (cloud.busy) { cloud.again = true; return; }
  if (!manual && (state.current || $('dlg').open || !navigator.onLine)) return;
  if (state.current) { toast('Sync waits until you press FINISH.'); return; }
  cloud.busy = true;
  renderCloud();
  try {
    const res = await syncNow(cloud.code, sharedPrefs);
    cloud.at = Date.now();
    cloud.error = null;
    if (res.changed && !state.current) {
      await loadAll();
      state.network = null;
      refreshRideMap();
      if (state.view === 'net') renderRides();
      if (state.view === 'net') renderNetwork(false);
      if (state.view === 'settings') renderSettings();
    }
    if (manual) {
      toast((res.got || res.sent ? `Synced: ${res.sent} sent, ${res.got} received.` : 'Everything is already in step.')
        + (res.skipped ? ` ${res.skipped} photo${res.skipped === 1 ? '' : 's'} could not be sent yet.` : ''));
    }
  } catch (err) {
    cloud.error = navigator.onLine ? (err.message || 'no answer') : 'no signal';
    if (manual) toast(navigator.onLine ? `The sync did not get through (${cloud.error}). It will try again by itself.` : 'No signal. It will sync when there is one.', 5000);
  } finally {
    cloud.busy = false;
    renderCloud();
    if (cloud.again) { cloud.again = false; syncSoon(); }
  }
}
let syncTimer;
function syncSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(), 3000);
}
window.addEventListener('online', syncSoon);
setInterval(() => { if (document.visibilityState === 'visible') runSync(); }, 60000);

/** Start using a family code on this device: everything here is offered to the cloud, everything there comes down. */
async function useSyncCode(code) {
  await forgetSync();
  await db.touchAll();
  cloud.code = code;
  cloud.at = 0;
  localStorage.setItem('tt-sync-code', code);
  if (settings.systemName || settings.customVehicles?.length) await db.touch('kv', 'prefs');
  renderCloud();
  await runSync(true);
}

$('btn-sync-on').addEventListener('click', async () => {
  const res = await ask({
    title: 'Turn on cloud sync?',
    body: 'Your rides, pins, photos and branch names are copied to your database on Cloudflare whenever this device has a signal. Any phone or computer you give your family sync code to can see and change them. Everything still works with no signal.',
    buttons: [{ label: 'TURN ON', value: 'save', cls: 'go' }, { label: 'I have a code already', value: 'join' }, { label: 'Cancel', value: 'cancel' }],
  });
  if (res.button === 'join') await joinSync();
  // Turned off and on again on the same device: the same code, so the same rides.
  else if (res.button === 'save') await useSyncCode(cleanSyncCode(localStorage.getItem('tt-sync-code-last')) ?? newSyncCode());
});

/** @param quiet arriving from the app's old address with this device's own code: nothing to ask */
async function joinSync(text = null, quiet = false) {
  if (text == null) {
    const res = await ask({
      title: 'Join your family\'s sync',
      body: 'Paste the link or code from a phone or computer that already has cloud sync on (Merge & export > Cloud sync > Add another phone or computer).',
      input: { placeholder: 'Paste it here' },
      buttons: [{ label: 'JOIN', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
    });
    if (res.button !== 'save') return;
    text = res.text;
  }
  const code = cleanSyncCode(text);
  if (!code) { toast('That is not a sync link or code.', 5000); return; }
  if (code === cloud.code) { if (!quiet) toast('This device is already using that code.'); return; }
  if (quiet && !cloud.code) { await useSyncCode(code); return; }
  const mine = doneRides().length;
  const res = await ask({
    title: 'Join this family sync?',
    body: `This device will show the family's rides, pins and photos.${mine ? ` The ${mine} ride${mine === 1 ? '' : 's'} already on this device ${mine === 1 ? 'is' : 'are'} added to the family's.` : ''}`,
    buttons: [{ label: 'JOIN', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
  });
  if (res.button === 'save') await useSyncCode(code);
}
$('btn-sync-join').addEventListener('click', () => joinSync());
$('btn-sync-now').addEventListener('click', () => runSync(true));
$('btn-sync-add').addEventListener('click', async () => {
  const res = await ask({
    title: 'Add another phone or computer',
    body: 'Send yourself this link and open it on the other device. Anyone who has it can see and change your rides, so send it only to devices and people you trust.',
    buttons: [{ label: 'SEND THE LINK', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
  });
  if (res.button !== 'save') return;
  await shareMessage({
    title: 'Seeley Trail Tracker sync',
    text: 'Open this on the other phone or computer to share the same rides. (If it opens outside the app, copy the link and use Merge & export > Cloud sync > Join with a code.)',
    url: `${SHARE_URL}#sync=${cloud.code}`,
  }, 'Copied. Paste it into a message to yourself.');
});
$('btn-sync-off').addEventListener('click', async () => {
  const res = await ask({
    title: 'Turn off cloud sync on this device?',
    body: 'The rides stay on this device and in the cloud, but changes stop passing between them until you turn it on again.',
    buttons: [{ label: 'Keep it on', value: 'cancel', cls: 'go' }, { label: 'Turn off', value: 'yes', cls: 'stop' }],
  });
  if (res.button !== 'yes') return;
  localStorage.setItem('tt-sync-code-last', cloud.code);
  cloud.code = null;
  localStorage.removeItem('tt-sync-code');
  renderCloud();
});

// ---- staying up to date ---------------------------------------------------------
//
// version.json on the website says which version is published and which files
// make it up. If that is not the version running here, every file is fetched
// fresh and the app restarts itself. It never does that during a ride or while
// a question is on screen, and it gives up quietly when there is no signal.

const update = { status: 'unknown', latest: null, checkedAt: 0 };
const setUpdate = (status) => { update.status = status; renderSettings(); };

async function checkForUpdate(manual = false) {
  setUpdate('checking');
  let info;
  try {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 8000);
    const res = await fetch('version.json', { cache: 'no-store', signal: stop.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    info = await res.json();
  } catch {
    setUpdate('offline');
    return;
  }
  update.latest = info.version;
  update.checkedAt = Date.now();
  if (info.version === VERSION) {
    localStorage.removeItem('tt-update-tried');
    setUpdate('current');
    return;
  }
  // Tried this very version a moment ago and it did not take: don't restart in a loop.
  const tried = readJson('tt-update-tried');
  if (!manual && tried.version === info.version && Date.now() - tried.at < 15 * 60000) {
    setUpdate('stuck');
    return;
  }
  if (state.current || $('dlg').open || sendingMap || cloud.busy) {
    setUpdate('waiting');
    return;
  }
  setUpdate('updating');
  toast(`Updating to version ${info.version}…`, 15000);
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update().catch(() => {});
    // 'reload' skips every cache on the way, and refreshes the offline copy as it passes through.
    await Promise.all(info.files.map((f) => fetch(f, { cache: 'reload' }).then((r) => { if (!r.ok) throw new Error(f); })));
  } catch {
    setUpdate('offline');
    return;
  }
  if (state.current || $('dlg').open || sendingMap) { // something started while the files were coming down
    setUpdate('waiting');
    return;
  }
  localStorage.setItem('tt-update-tried', JSON.stringify({ version: info.version, at: Date.now() }));
  location.reload();
}
$('btn-update').addEventListener('click', async () => {
  await checkForUpdate(true);
  if (update.status === 'current') toast(`You have the latest version (${VERSION}).`);
  if (update.status === 'offline') toast('Could not reach the update server. Try again when you have a signal.');
});

function bindSetting(id, key, { event = 'input', after } = {}) {
  $(id).addEventListener(event, (e) => {
    const el = e.target;
    settings[key] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
    saveSettings();
    renderSettings();
    after?.();
  });
}
bindSetting('thr', 'threshold', { after: remergeSoon });
bindSetting('smo', 'smoothing', { after: remergeSoon });
bindSetting('acc', 'maxAcc');
bindSetting('mind', 'minDist');
bindSetting('weight', 'weightKg');
bindSetting('autopause', 'autoPause', { event: 'change' });
bindSetting('awake', 'keepAwake', { event: 'change', after: () => setWake(!!state.current && settings.keepAwake) });
$('autodark').addEventListener('change', (e) => {
  settings.autoDark = Number(e.target.value);
  saveSettings();
});
bindSetting('show-raw', 'showRaw', { event: 'change', after: () => renderNetwork(false) });
bindSetting('show-merged', 'showMerged', { event: 'change', after: () => renderNetwork(false) });
bindSetting('show-ref', 'showRef', { event: 'change', after: () => { renderNetwork(false); refreshRideMap(); } });
bindSetting('color', 'color', { event: 'change', after: () => { state.lastKml = null; } });

async function setReference(ref) {
  state.ref = ref;
  state.walked = null; // it belongs to the built-in map only
  await db.del('kv', 'walked');
  state.refIndex = prepareReference(ref);
  state.network = null;
  if (ref) {
    await db.put('kv', ref, 'reference');
    localStorage.removeItem('tt-ref-removed');
  } else {
    await db.del('kv', 'reference');
    localStorage.setItem('tt-ref-removed', '1');
  }
  refreshRideMap();
  renderSettings();
}

$('btn-ref-load').addEventListener('click', () => $('ref-file').click());
$('ref-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const ref = parseKml(await readKmlFile(file));
    await setReference(ref);
    rideMap.fit(['ref']);
    toast(`Loaded "${ref.name}"`);
  } catch (err) {
    toast(err.message || 'That file could not be read.', 5000);
  }
});
$('btn-ref-clear').addEventListener('click', async () => {
  const res = await ask({
    title: 'Remove the existing trail map?',
    body: 'Only the background map is removed. Your rides and pins are not touched, and you can load the map again later.',
    buttons: [{ label: 'Keep it', value: 'cancel', cls: 'go' }, { label: 'Remove map', value: 'yes', cls: 'stop' }],
  });
  if (res.button === 'yes') await setReference(null);
});

// Pictures travel inside the backup file as text (base64).
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer;

// ---- share this app ------------------------------------------------------------

$('share-url').textContent = $('poster-url').textContent = SHARE_URL;
$('btn-share-link').addEventListener('click', async () => {
  const message = { title: 'Seeley Trail Tracker', text: 'Map your trails with your phone, even with no signal. Open this to install it:', url: SHARE_URL };
  if (navigator.share) {
    try { await navigator.share(message); } catch { /* cancelled */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(SHARE_URL);
    toast('Link copied. Paste it into a message.');
  } catch {
    toast(SHARE_URL, 8000);
  }
});
$('btn-share-qr').addEventListener('click', async () => {
  try {
    const picture = await (await fetch('icons/qr.png')).blob();
    const file = new File([picture], 'seeley-trail-tracker-qr.png', { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Seeley Trail Tracker' }); } catch { /* cancelled */ }
      return;
    }
    download(file.name, picture, 'image/png');
    toast('QR picture saved to Downloads');
  } catch {
    toast('Could not load the QR picture.');
  }
});
$('btn-print-qr').addEventListener('click', () => window.print());

$('btn-backup').addEventListener('click', async () => {
  const photos = [];
  for (const p of state.pins.filter((x) => x.photo)) {
    const rec = await db.get('photos', p.id);
    if (rec) photos.push({ id: p.id, type: rec.type, data: toBase64(rec.data) });
  }
  const data = {
    app: 'trail-tracker', format: 1, exportedAt: new Date().toISOString(), contributor: settings.userName, settings,
    rides: state.rides.map((r) => ({ ...r, points: (state.tracks.get(r.id) ?? []).flat() })),
    pins: state.pins,
    photos,
    branches: state.branches,
  };
  if (await saveFile(`trail-tracker-backup_${stamp()}.json`, JSON.stringify(data), 'application/json') === 'downloaded') {
    toast('Backup saved to Downloads');
  }
});
$('btn-restore').addEventListener('click', () => $('backup-file').click());
$('backup-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'trail-tracker' || !Array.isArray(data.rides)) throw new Error('That is not a Trail Tracker backup file.');
    // Whatever carries no name was recorded by whoever made the backup.
    const from = data.contributor || 'Unknown';
    let added = 0;
    for (const { points, ...ride } of data.rides) {
      if (state.rides.some((r) => r.id === ride.id) || !points?.length) continue;
      await db.put('rides', { ...ride, by: ride.by || from, status: 'done', name: ride.name || 'Restored ride' });
      await db.addPoints(points.map((p) => ({ ...p, ride: ride.id })));
      added++;
    }
    let addedPins = 0;
    for (const pin of data.pins ?? []) {
      if (state.pins.some((p) => p.id === pin.id)) continue;
      await db.put('pins', { ...pin, by: pin.by || from });
      addedPins++;
    }
    for (const photo of data.photos ?? []) {
      if (photo?.id == null || !photo.data || await db.get('photos', photo.id)) continue;
      await db.put('photos', { id: photo.id, type: photo.type || 'image/jpeg', data: fromBase64(photo.data) });
    }
    // Branch names come across too, except where this phone has already named the same stretch.
    const branches = state.branches.slice();
    for (const b of data.branches ?? []) {
      if (!b?.name || !Array.isArray(b.pts) || b.pts.length < 2) continue;
      if (!branches.some((mine) => overlapShare(b.pts, mine.pts) >= 0.6)) branches.push({ name: b.name, pts: b.pts });
    }
    await db.put('kv', branches, 'branches');
    const current = state.current;
    await loadAll();
    if (current) state.current = state.rides.find((r) => r.id === current.id) ?? null;
    state.network = null;
    refreshRideMap();
    renderSettings();
    toast(added || addedPins
      ? `Restored ${added} ride(s) and ${addedPins} pin(s) or photo(s)`
      : 'Everything in that backup is already here');
  } catch (err) {
    toast(err.message || 'That backup could not be read.', 5000);
  }
});

// Chrome offers installation once it has checked the app over; show our own buttons for it.
let installPrompt = null;
const showInstall = (on) => { $('btn-install').hidden = $('btn-install-top').hidden = !on; };
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  showInstall(true);
});
window.addEventListener('appinstalled', () => showInstall(false));
for (const id of ['btn-install', 'btn-install-top']) {
  $(id).addEventListener('click', async () => {
    await installPrompt?.prompt();
    installPrompt = null;
    showInstall(false);
  });
}

// An iPhone has no install button a page can offer: it is done from Safari's
// Share menu, so show how. Rides recorded in a Safari tab are not carried over
// to the installed app, which is why the hint says to install first.
if (IOS) {
  $('tip-ios').hidden = false;
  $('ios-install').hidden = INSTALLED || !!localStorage.getItem('tt-ios-hint-off');
  $('ios-install-close').addEventListener('click', () => {
    localStorage.setItem('tt-ios-hint-off', '1');
    $('ios-install').hidden = true;
  });
  // The iPhone file picker greys out file types it does not recognise (KML, KMZ).
  for (const id of ['ref-file', 'backup-file']) $(id).removeAttribute('accept');
  // Stop a two-finger pinch from zooming the whole page instead of the map.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}

// ---- navigation ---------------------------------------------------------------

function showView(view) {
  if (view !== 'net') state.focusRide = null;
  state.view = view;
  if (view === 'rides') view = state.view = 'net'; // the Saved screen is part of Merge & export since 1.39
  for (const v of ['ride', 'net', 'hunt', 'settings']) $(`view-${v}`).hidden = v !== view;
  for (const b of $('tabs').children) b.classList.toggle('active', b.dataset.view === view);
  if (view === 'net') renderRides();
  if (view === 'hunt') {
    if (game?.status === 'active' && tracker?.geo && !state.gpsWanted) startGps(); // a hunt needs to know where you are
    renderHunt();
    renderChallenges();
    refreshChallenges();
  }
  if (view === 'settings') renderSettings();
  if (view === 'net') renderCloud(); // Cloud sync is on the Merge & export screen
  if (view === 'net') {
    renderSettings();
    renderNetwork(true);
  }
}
$('tabs').addEventListener('click', (e) => {
  const view = e.target.closest('button')?.dataset.view;
  if (view) showView(view);
});

$('btn-start').addEventListener('click', startRide);
$('btn-finish').addEventListener('click', () => finishRide().catch((err) => {
  // Nothing is lost if this goes wrong: the points are already on the phone, and the app offers the outing again when reopened.
  updateRideUi();
  toast(`Could not finish: ${err?.message ?? err}. Your recording is safe; please press FINISH again.`, 9000);
}));

// ---- dark screen ---------------------------------------------------------------------
//
// A web app gets no GPS once the phone's screen is really off: Android and
// iPhone both cut it. So the app never lets the screen switch off while
// recording, and offers the next best thing: a black, touch-locked screen that
// can go in a pocket. On most phones black pixels use almost no power.

let lastTouch = Date.now();
const touched = () => { lastTouch = Date.now(); };
document.addEventListener('pointerdown', touched, true);

function enterDark() {
  if (!state.current || !$('pocket').hidden || $('dlg').open) return;
  $('pocket').hidden = false;
  updatePocket();
  // Full screen hides the phone's own bars and gestures where the browser allows it.
  try { document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch(() => {}); } catch { /* not supported */ }
}

function leaveDark() {
  if ($('pocket').hidden) return;
  $('pocket').hidden = true;
  touched();
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

function updatePocket() {
  if ($('pocket').hidden) return;
  if (!state.current) { leaveDark(); return; }
  const stale = Date.now() - state.fixAt > 10000, weak = tracker.lastFix && tracker.lastFix.acc > settings.maxAcc;
  const label = tracker.state === 'paused' ? 'PAUSED' : stale ? 'NO GPS SIGNAL' : weak ? 'WEAK GPS' : 'RECORDING';
  $('pocket-state').textContent = label;
  $('pocket-state').classList.toggle('warn', label !== 'RECORDING');
  $('pocket-stats').textContent = `${fmtDist(tracker.dist)} · ${fmtClock(timeOf(state.current))}`;
}

$('btn-dark').addEventListener('click', enterDark);

// Slide the knob most of the way across to get the screen back: a pocket does not do that by accident.
{
  const track = $('pocket-slide'), knob = $('pocket-knob');
  let startX = null, progress = 0;
  const reset = () => { startX = null; progress = 0; knob.style.transform = ''; };
  knob.addEventListener('pointerdown', (e) => {
    startX = e.clientX;
    try { knob.setPointerCapture(e.pointerId); } catch { /* the drag still works while the finger stays on the knob */ }
  });
  knob.addEventListener('pointermove', (e) => {
    if (startX == null) return;
    const max = track.clientWidth - knob.offsetWidth - 4;
    const dx = Math.min(max, Math.max(0, e.clientX - startX));
    progress = max > 0 ? dx / max : 0;
    knob.style.transform = `translateX(${dx}px)`;
  });
  knob.addEventListener('pointerup', () => {
    const done = progress > 0.8;
    reset();
    if (done) leaveDark();
  });
  knob.addEventListener('pointercancel', reset);
}

// Go dark by itself after a while without a touch, the way a screen normally times out.
setInterval(() => {
  if (!tracker || !state.current || !settings.autoDark || state.view !== 'ride' || NATIVE) return; // the Android app has the real screen-off instead
  if (Date.now() - lastTouch > settings.autoDark * 1000) enterDark();
}, 2000);
$('btn-pin').addEventListener('click', dropPin);
$('btn-pin-idle').addEventListener('click', dropPin);
$('btn-photo').addEventListener('click', () => takePhoto());
$('btn-photo-idle').addEventListener('click', () => takePhoto());
$('btn-pause').addEventListener('click', () => {
  const ride = state.current;
  if (!ride) return;
  // The stopwatch stops while the ride is on PAUSE.
  if (tracker.state === 'paused') {
    endPause(ride);
    tracker.resume();
  } else {
    ride.pausedAt = clockNow();
    tracker.pause();
  }
  db.put('rides', ride);
});
$('status').addEventListener('click', () => {
  if (NATIVE && tracker.error === 'denied') { openAppSettings().catch(() => {}); return; } // location was refused: the phone's settings are the only way back
  if (!state.gpsWanted) discloseLocation().then((ok) => { if (ok) startGps(); });
});

$('ride-in').addEventListener('click', () => rideMap.zoom(1.5));
$('ride-out').addEventListener('click', () => rideMap.zoom(1 / 1.5));
$('ride-center').addEventListener('click', () => {
  if (!state.gpsWanted) startGps();
  rideMap.center();
});
$('ride-fit').addEventListener('click', () => rideMap.fit());
$('ride-walked').addEventListener('click', () => {
  settings.showWalked = !settings.showWalked;
  if (settings.showWalked) settings.showRef = true; // nothing to see without the map itself
  saveSettings();
  refreshRideMap();
  renderSettings();
  state.network = null;
  if (settings.showWalked && !state.current) rideMap.fit(['ref']); // show the whole map, unless a recording is following you
  toast(settings.showWalked
    ? 'Green: trails recorded with GPS. Dashes with no green: drawn from the old paper map only.'
    : 'GPS-recorded trails hidden', 6000);
});
rideMap.onFollowChange = (on) => $('ride-center').classList.toggle('on', on);
$('net-in').addEventListener('click', () => netMap.zoom(1.5));
$('net-out').addEventListener('click', () => netMap.zoom(1 / 1.5));
$('net-fit').addEventListener('click', () => { if (!netMap.fit(['raw', 'merged'])) netMap.fit(); });

document.addEventListener('visibilitychange', () => {
  if (!tracker) return;
  if (document.visibilityState === 'hidden') {
    state.hiddenAt = Date.now();
    share.pause(); // no position goes out while the app is in the background
    if (state.current) db.put('rides', state.current);
    else tracker.unwatch(); // save the battery when nothing is being recorded
    return;
  }
  share.resume();
  syncSoon();
  if (state.gpsWanted) tracker.watch();
  if (state.current) {
    setWake(true);
    const away = Date.now() - state.hiddenAt;
    if (away > 15000 && tracker.state === 'recording' && !NATIVE) {
      notice(`GPS was not recorded for ${fmtDur(away)} while the screen was off or another app was in front. Next time use DARK SCREEN instead of the power button.`);
    }
  } else if (Date.now() - update.checkedAt > 10 * 60000) {
    checkForUpdate(); // the app was brought back to the front: same check as when it opens
  }
});

setInterval(() => { if (tracker) { updateStats(); updateStatus(); } }, 2000);
setInterval(() => { if (tracker) { updateClock(); updateHuntLive(); } }, 1000); // the two stopwatches
setInterval(() => { if (tracker && settings.sharing !== 'private') renderPeople(); }, 10000); // drops people who have gone quiet

// ---- start-up -------------------------------------------------------------------

async function boot() {
  for (const [key, c] of Object.entries(TRAIL_COLORS)) $('color').add(new Option(c.label, key));
  await loadAll();
  if (OLD_HOME && !DEMO && await leaveOldHome()) return; // the app's new address is opening instead

  // The Android app's GPS keeps coming with the screen off. If it cannot be started, the app records the way the
  // web version does and says so (see nativeGeo).
  let geo = NATIVE ? nativeGeo((why) => {
    state.nativeGpsNote = why;
    if (why) notice(`Recording works, but keep the screen on this time: the phone's background GPS could not start (${why}).`);
    else if (state.current) notice('');
  }) : navigator.geolocation;
  if (NATIVE) {
    document.querySelector('.tips li').textContent = 'In this Android app, GPS keeps recording with the screen off or another app in front. A notification stays up while it does.';
    $('awake').closest('label').querySelector('small').textContent = 'Not needed in this Android app: it records with the screen off.';
  }
  if (DEMO) {
    geo = (await import('./demo.js')).createDemoGeo(state.ref);
    $('demo-flag').hidden = false;
  }
  // The GPS filters are tuned to what the ride is on: a walker is slower than a machine.
  const trackerSettings = () => ({ ...settings, kind: methodOf(state.current ?? { vehicle: settings.vehicle }).kind });
  tracker = new Tracker(trackerSettings, { fix: onFix, point: onPoint, status: updateRideUi }, geo);

  refreshRideMap();
  renderSettings();
  renderHunt(); // puts the HUNT pill back if a hunt was under way
  rideMap.fit();
  updateRideUi();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // Turn GPS on straight away if this site already has permission; otherwise wait for a tap.
  let granted = DEMO || (NATIVE && !!localStorage.getItem('tt-native-gps'));
  try { granted ||= (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted'; } catch { /* not supported */ }
  if (granted) startGps();

  // Just restarted into a new version?
  if (readJson('tt-update-tried').version === VERSION) {
    localStorage.removeItem('tt-update-tried');
    toast(`Updated to version ${VERSION}`, 5000);
  }
  // Look for a newer version before anything else asks for attention: if there
  // is one, the app restarts here. With no signal this comes back at once, and
  // a slow connection is not allowed to hold things up for long.
  await Promise.race([checkForUpdate(), new Promise((resolve) => setTimeout(resolve, 4000))]);

  await recoverUnfinished();
  updateRideUi();
  if (!settings.userName) await askName(true);

  // Private by default: this connects to nothing unless the user has chosen to share.
  await applySharing();
  window.addEventListener('hashchange', checkInvite); // the link was tapped while the app was already open
  await checkInvite();
  runSync(); // does nothing unless cloud sync is on
  refreshChallenges().then(checkInbox, () => {}); // nothing unless a challenge is under way or a friend has sent one
}

/** Opened from a friend's "add me" link (…#friend=CODE) or a hunt link (…#hunt=CODE)? Offer to add them, or open the hunt. */
async function checkInvite() {
  const hash = location.hash;
  const invite = /[#&]friend=([^&]+)/.exec(hash), hunt = /[#&]hunt=/.test(hash), map = /[#&]map=/.test(hash), sync = /[#&]sync=/.test(hash);
  const dared = /[#&]challenge=/.test(hash);
  if ((!invite && !hunt && !map && !sync && !dared) || $('dlg').open) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (dared) await joinChallenge(hash);
  else if (sync) {
    const moved = /[#&]moved=1/.test(hash);
    await joinSync(hash, moved);
    // Said once: the old home-screen icon still works (it brings you here), but this is the one to keep.
    if (moved && !INSTALLED && !localStorage.getItem('tt-moved-told')) {
      localStorage.setItem('tt-moved-told', '1');
      await ask({
        title: 'You are at the app\'s new home',
        body: `Everything came with you.\n\nTo finish, put this one on your home screen: ${IOS ? 'tap Share, then Add to Home Screen' : 'tap INSTALL at the top of the screen (or the browser menu, then Install app)'}. After that you can delete the old icon.`,
        buttons: [{ label: 'OK', value: 'cancel', cls: 'go' }],
      });
    }
  }
  else if (map) {
    const code = cleanTransferCode(hash);
    if (code) await sendToMap(code);
    else toast('That send link is not complete. Ask for a new one.', 5000);
  } else if (hunt) await joinHunt(hash);
  else await addFriend(decodeURIComponent(invite[1]));
}

boot().catch((err) => {
  console.error(err);
  notice(`The app could not start: ${err.message}`);
});
