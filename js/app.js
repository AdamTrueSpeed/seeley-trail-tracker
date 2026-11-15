// Seeley Trail Tracker: screens and glue. The heavy lifting lives in
// tracker.js (GPS), merge.js (de-duplication), kml.js (export) and db.js (storage).

import { db, keepStorage } from './db.js';
import { Tracker } from './tracker.js';
import { MapView } from './mapview.js';
import { buildNetwork } from './merge.js';
import { buildKml, buildKmz, parseKml, readKmlFile, TRAIL_COLORS } from './kml.js';
import { prepareReference, nameSegments, coverage, overlapShare } from './reference.js';
import { estimateWidth, widthLabel, VEHICLES, vehicleOf } from './width.js';
import { haversine } from './geo.js';

const VERSION = '1.6';
// Where friends get the app. icons/qr.svg and icons/qr.png are this address as a
// QR code: if it ever changes, the two pictures have to be made again.
const SHARE_URL = 'https://adamtruespeed.github.io/seeley-trail-tracker/'; // keep in step with version.json (tools/check-release.mjs checks it)
const PARAMS = new URLSearchParams(location.search);
const DEMO = PARAMS.has('demo');
// iPhone or iPad (an iPad calls itself a Mac with a touch screen). Adding ?ios
// to the address forces the iPhone behaviour, for trying it on a computer.
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || PARAMS.has('ios');
const INSTALLED = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const SCREEN_TIP = IOS
  ? 'This iPhone would not let the app keep the screen on. While riding, set Settings > Display & Brightness > Auto-Lock to Never.'
  : 'This browser cannot keep the screen on by itself. Set your phone\'s screen timeout as long as it goes while riding.';
const PIN_LABELS = ['Hazard', 'Bridge', 'Intersection', 'Trailhead', 'Gate', 'Water crossing', 'Fallen tree', 'Viewpoint'];
const SAVED_COLOR = '#2fbf9f';
const RAW_COLOR = '#8a97a6';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- settings ---------------------------------------------------------------

const DEFAULTS = {
  threshold: 8, smoothing: 3,             // merge
  maxAcc: 15, minDist: 3, autoPause: true, keepAwake: true, // recording
  vehicle: 'grizzly',                     // what the last ride was on (see VEHICLES in width.js)
  color: 'orange', showRaw: true, showMerged: true, showRef: true,
};
const readJson = (key) => { try { return JSON.parse(localStorage.getItem(key)) ?? {}; } catch { return {}; } };
const settings = { ...DEFAULTS, ...readJson('tt-settings') };
const saveSettings = () => localStorage.setItem('tt-settings', JSON.stringify(settings));

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
const rideName = (r) => r.name || 'Ride in progress';
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
const setMethod = (ride, m) => Object.assign(ride, { vehicle: m.key, vehicleName: m.name, vehicleWidth: m.width, vehicleKind: m.kind });

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

/** Distance, time and ride count for each method of travel, furthest first. */
function totalsByMethod(rides) {
  const by = new Map();
  for (const r of rides) {
    const name = methodOf(r).name;
    const e = by.get(name) ?? by.set(name, { name, rides: 0, dist: 0, time: 0 }).get(name);
    e.rides++;
    e.dist += r.dist ?? 0;
    e.time += Math.max(0, (r.endedAt ?? 0) - (r.startedAt ?? 0));
  }
  return [...by.values()].sort((a, b) => b.dist - a.dist);
}

/** Quick labels for pins: the names typed most recently on this phone first, then the standard ones. */
function pinLabels() {
  const recent = Array.isArray(readJson('tt-pin-labels')) ? readJson('tt-pin-labels') : [];
  const seen = new Set();
  return [...recent, ...PIN_LABELS].filter((l) => !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()));
}
function rememberPinLabel(name) {
  if (/^Pin \d+$/.test(name) || PIN_LABELS.some((l) => l.toLowerCase() === name.toLowerCase())) return;
  const recent = pinLabels().filter((l) => !PIN_LABELS.includes(l) && l.toLowerCase() !== name.toLowerCase());
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
 * tapping one puts it in the text box, where it can still be edited.
 */
function ask({ title, body = '', input = null, chips = [], buttons, focus = true, image = null }) {
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
  $('dlg-chips').replaceChildren(...chips.map((c) => {
    const b = make(c, '', 'button');
    b.addEventListener('click', () => {
      inp.value = c;
      for (const other of $('dlg-chips').children) other.classList.toggle('on', other === b);
    });
    return b;
  }));
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
  if (!state.ref && !localStorage.getItem('tt-ref-removed')) {
    // A trail map shipped alongside the app is loaded the first time.
    try {
      const res = await fetch('reference.kml');
      if (res.ok) {
        state.ref = parseKml(await res.text());
        await db.put('kv', state.ref, 'reference');
      }
    } catch { /* none bundled, or offline on first run */ }
  }
  state.refIndex = prepareReference(state.ref);
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

function refreshRideMap() {
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
  $('st-pts').textContent = state.current ? tracker.count : 0;
  const acc = $('st-acc'), fix = tracker.lastFix;
  if (!fix || Date.now() - state.fixAt > 10000) {
    acc.textContent = '--';
    acc.className = 'bad';
  } else {
    acc.textContent = fix.acc >= 100 ? '99+' : Math.round(fix.acc);
    acc.className = fix.acc <= settings.maxAcc * 0.55 ? 'good' : fix.acc <= settings.maxAcc ? 'fair' : 'bad';
  }
}

function updateStatus() {
  const el = $('status'), fix = tracker.lastFix, rec = tracker.state !== 'idle';
  const set = (text, cls) => { el.textContent = text; el.className = `status ${cls}`; };
  if (tracker.error === 'denied') set('Location is blocked for this site', 'bad');
  else if (!state.gpsWanted) set('Press START RIDE to turn on GPS', 'wait');
  else if (!fix) set(tracker.error ? 'No GPS signal yet' : 'Finding GPS…', 'wait');
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

function startGps() {
  state.gpsWanted = true;
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
  renderSettings();
  toast(`Added ${name}`);
  return method;
}

let starting = false;
async function startRide() {
  if (!tracker.geo) { toast('This browser cannot use GPS.'); return; }
  if (starting || state.current) return;
  starting = true;
  const vehicle = await chooseVehicle('What are you on?', settings.vehicle);
  starting = false;
  if (!vehicle) return;
  settings.vehicle = vehicle.key;
  saveSettings();
  const ride = setMethod({
    id: Date.now(), name: '', by: settings.userName,
    startedAt: Date.now(), endedAt: Date.now(), status: 'recording', include: true, dist: 0, count: 0,
  }, vehicle);
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
  setWake(true).then((ok) => { if (!ok) notice(SCREEN_TIP); });
  keepStorage();
  updateRideUi();
}

let storageWarned = false;
function onPoint(p, newSeg) {
  const ride = state.current;
  if (!ride) return;
  const segs = state.tracks.get(ride.id);
  if (newSeg || !segs.length) segs.push([]);
  segs[segs.length - 1].push(p);
  rideMap.addLive(p.lat, p.lon, newSeg);
  if (tracker.count === 1) ride.startedAt = p.t;
  ride.endedAt = p.t;
  ride.dist = tracker.dist;
  ride.count = tracker.count;
  db.addPoint({ ride: ride.id, ...p }).catch(() => {
    if (!storageWarned) notice('Could not save to the phone\'s storage. Free up some space, then finish this ride.');
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
  updateStats();
  updateStatus();
}

async function finishRide() {
  const ride = state.current;
  if (!ride) return;
  const n = doneRides().length + 1;
  const res = tracker.count < 2
    ? await ask({
      title: 'Nothing recorded yet',
      body: 'This ride has no GPS points, so there is nothing to save.',
      buttons: [{ label: 'KEEP RIDING', value: 'cancel', cls: 'go' }, { label: 'End without saving', value: 'discard', cls: 'stop' }],
    })
    : await ask({
      title: 'Save this ride',
      body: `${fmtDist(tracker.dist)} · ${tracker.count} points · ${methodOf(ride).name}. Give it a name, such as the trail or loop you covered.`,
      input: { value: `Ride ${n}`, placeholder: 'e.g. Ride 1 - North Loop' },
      buttons: [
        { label: 'SAVE RIDE', value: 'save', cls: 'go' },
        { label: 'Keep riding', value: 'cancel' },
        { label: 'Throw this ride away', value: 'discard', cls: 'stop' },
      ],
    });
  if (res.button === 'cancel') return;
  if (res.button === 'discard' && tracker.count >= 2) {
    const sure = await ask({
      title: 'Throw this ride away?',
      body: `${fmtDist(tracker.dist)} of recording will be deleted. This cannot be undone.`,
      buttons: [{ label: 'Keep it', value: 'cancel', cls: 'go' }, { label: 'DELETE RIDE', value: 'yes', cls: 'stop' }],
    });
    if (sure.button !== 'yes') return;
  }
  tracker.stop();
  setWake(false);
  state.current = null;
  state.network = null;
  if (res.button === 'discard') {
    await db.deleteRide(ride.id);
    state.rides = state.rides.filter((r) => r !== ride);
    state.tracks.delete(ride.id);
  } else {
    ride.name = res.text || `Ride ${n}`;
    ride.status = 'done';
    await db.put('rides', ride);
    toast(`Saved "${ride.name}"`);
  }
  rideMap.clearLive();
  refreshRideMap();
  notice('');
  updateRideUi();
}

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

async function dropPin() {
  const spot = spotNow();
  if (!spot) return;
  const { fix, fresh } = spot;
  // The position is taken now; naming it can wait until you have stopped.
  const pin = {
    id: Date.now(), ride: state.current?.id ?? null, name: '', by: settings.userName,
    lat: fix.lat, lon: fix.lon, alt: fix.alt, acc: fix.acc, t: Date.now(),
  };
  const res = await ask({
    title: 'Name this pin',
    body: fresh ? `Position locked (±${Math.round(fix.acc)} m). Type a name, or tap a quick label, then SAVE PIN.`
      : `GPS is weak right now (±${Math.round(fix.acc)} m), so this pin may be off. Type a name, or tap a quick label, then SAVE PIN.`,
    input: { placeholder: 'Type a name, e.g. House' },
    chips: pinLabels(),
    focus: false,
    buttons: [{ label: 'SAVE PIN', value: 'save', cls: 'info' }, { label: 'Cancel', value: 'cancel' }],
  });
  if (res.button !== 'save') return;
  pin.name = res.text.slice(0, 60) || `Pin ${state.pins.length + 1}`;
  rememberPinLabel(pin.name);
  await db.put('pins', pin);
  state.pins.push(pin);
  rideMap.setPins(state.pins);
  toast(`Pin saved: ${pin.name}`);
}

// ---- photos -----------------------------------------------------------------------
//
// A photo is a pin with a picture. The position is taken at the tap on PHOTO,
// before the phone's camera opens, because the app sits in the background (and
// gets no GPS) while the camera is up.

let photoSpot = null;
function takePhoto() {
  const spot = spotNow();
  if (!spot) return;
  photoSpot = { ...spot, t: Date.now(), ride: state.current?.id ?? null };
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
  const res = await ask({
    title: 'Name this photo',
    body: spot.fresh ? `Pinned where you took it (±${Math.round(spot.fix.acc)} m).`
      : `Pinned where you took it, but GPS was weak (±${Math.round(spot.fix.acc)} m), so the spot may be off.`,
    image: preview,
    input: { placeholder: 'e.g. Washout by the creek' },
    chips: pinLabels(),
    focus: false,
    buttons: [{ label: 'SAVE PHOTO', value: 'save', cls: 'info' }, { label: 'Throw it away', value: 'discard', cls: 'stop' }],
  });
  URL.revokeObjectURL(preview);
  if (res.button === 'discard') return;
  // Backing out of the question keeps the photo, under a plain name: it cannot be retaken.
  const pin = {
    id: Date.now(), ride: spot.ride, name: res.text.slice(0, 60) || `Photo ${n}`, by: settings.userName,
    lat: spot.fix.lat, lon: spot.fix.lon, alt: spot.fix.alt, acc: spot.fix.acc, t: spot.t,
    photo: true, thumb: picture.thumb,
  };
  try {
    await db.put('photos', { id: pin.id, type: picture.blob.type, data: await picture.blob.arrayBuffer() });
    await db.put('pins', pin);
  } catch {
    notice('Could not save the photo to the phone\'s storage. Free up some space and try again.');
    return;
  }
  state.pins.push(pin);
  if (res.text) rememberPinLabel(pin.name);
  rideMap.setPins(state.pins);
  if (state.view === 'rides') renderRides();
  toast(`Photo saved: ${pin.name}`);
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
  await ask({
    title: pin.name,
    body: `${byName(pin)} · ${fmtDate(pin.t)} · ±${Math.round(pin.acc)} m · ${pin.lat.toFixed(5)}, ${pin.lon.toFixed(5)}`,
    image: url,
    buttons: [{ label: 'Close', value: 'cancel' }],
  });
  URL.revokeObjectURL(url);
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
      title: 'Unfinished ride found',
      body: `The app closed during a ride on ${fmtDate(m.startedAt)} (${fmtDist(m.dist)}). Nothing was lost.`,
      buttons: [{ label: 'CONTINUE THIS RIDE', value: 'resume', cls: 'go' }, { label: 'Save it as it is', value: 'save' }],
    });
    if (res.button === 'resume' && !state.current) {
      state.current = ride;
      rideMap.clearLive();
      for (const s of segs) s.forEach((p, i) => rideMap.addLive(p.lat, p.lon, i === 0));
      startGps();
      tracker.start({ seg: m.lastSeg, dist: m.dist, count: m.count });
      setWake(true);
    } else {
      ride.name ||= `Ride ${doneRides().length + 1} (recovered)`;
      ride.status = 'done';
    }
    await db.put('rides', ride);
  }
}

// ---- saved rides screen -----------------------------------------------------

function renderRides() {
  const rides = doneRides().reverse();
  $('ride-list').replaceChildren(...rides.map((r) => {
    const li = document.createElement('li');
    li.dataset.id = r.id;
    if (!r.include) li.className = 'off';
    li.innerHTML = `
      <label class="switch"><input type="checkbox" data-act="include" ${r.include ? 'checked' : ''} aria-label="Use this ride in the trail network"><span></span></label>
      <div><div class="name">${esc(r.name)}</div>
        <div class="meta"><b>${esc(byName(r))}</b> · ${esc(methodOf(r).short)} · ${fmtDate(r.startedAt)} · ${fmtDist(r.dist)} · ${fmtDur(r.endedAt - r.startedAt)} · ${r.count} points</div></div>
      <div class="acts four"><button data-act="rename">Rename</button><button data-act="vehicle">Method</button><button data-act="show">Show on map</button><button data-act="delete" class="del">Delete</button></div>`;
    return li;
  }));
  $('ride-empty').hidden = rides.length > 0;

  // Every saved ride counts here, whether or not it is switched into the trail network.
  const totals = totalsByMethod(rides);
  if (totals.length > 1) {
    totals.push(totals.reduce((a, t) => ({ ...a, rides: a.rides + t.rides, dist: a.dist + t.dist, time: a.time + t.time }),
      { name: 'All travel', rides: 0, dist: 0, time: 0, all: true }));
  }
  $('totals').hidden = !rides.length;
  $('totals-list').innerHTML = totals.map((t) => `
    <li class="${t.all ? 'all' : ''}"><span class="dot" style="background:${t.all ? '#fff' : 'var(--live)'}"></span>
      <span>${esc(t.name)} <span class="sub">${t.rides} ride${t.rides === 1 ? '' : 's'} · ${fmtDur(t.time)}</span></span>
      <span class="pct">${fmtDist(t.dist)}</span></li>`).join('');

  $('pin-list').replaceChildren(...state.pins.map((p) => {
    const ride = state.rides.find((r) => r.id === p.ride);
    const li = document.createElement('li');
    li.dataset.id = p.id;
    li.innerHTML = `
      ${p.photo ? `<img class="thumb" src="${esc(p.thumb ?? '')}" alt="" data-act="view">` : '<div class="pinmark"></div>'}
      <div><div class="name">${esc(p.name)}</div>
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
  if (act === 'include') {
    ride.include = e.target.checked;
  } else if (act === 'rename') {
    const res = await ask({ title: 'Rename ride', input: { value: ride.name }, buttons: [{ label: 'SAVE', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }] });
    if (res.button !== 'save' || !res.text) return;
    ride.name = res.text;
  } else if (act === 'vehicle') {
    const vehicle = await chooseVehicle(`What was "${ride.name}" on?`, methodOf(ride).key);
    if (!vehicle) return;
    setMethod(ride, vehicle);
  } else if (act === 'show') {
    state.focusRide = ride.id;
    showView('net');
    return;
  } else if (act === 'delete') {
    const res = await ask({
      title: `Delete "${ride.name}"?`,
      body: `${fmtDist(ride.dist)} recorded ${fmtDate(ride.startedAt)}. This cannot be undone.`,
      buttons: [{ label: 'Keep it', value: 'cancel', cls: 'go' }, { label: 'DELETE RIDE', value: 'yes', cls: 'stop' }],
    });
    if (res.button !== 'yes') return;
    state.rides = state.rides.filter((r) => r !== ride);
    state.tracks.delete(ride.id);
  }
  state.network = null;
  if (act === 'delete') await db.deleteRide(ride.id); else await db.put('rides', ride);
  renderRides();
  refreshRideMap();
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
    const res = await ask({ title: pin.photo ? 'Rename photo' : 'Rename pin', input: { value: pin.name, placeholder: 'Type a name, e.g. House' }, chips: pinLabels(), buttons: [{ label: 'SAVE', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }] });
    if (res.button !== 'save' || !res.text) return;
    pin.name = res.text.slice(0, 60);
    rememberPinLabel(pin.name);
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
});

// ---- merge & export screen --------------------------------------------------

function computeNetwork() {
  const tracks = state.rides
    .filter((r) => r.include && state.tracks.get(r.id)?.length)
    .map((r) => ({
      id: r.id, name: rideName(r), by: byName(r), dist: r.dist, startedAt: r.startedAt, segments: state.tracks.get(r.id),
      vehicle: methodOf(r), vehicleWidth: r.vehicleWidth ?? methodOf(r).width,
    }));
  const net = buildNetwork(tracks, settings);
  nameSegments(net.segments, state.refIndex);                 // names from the existing map -> s.ref
  nameSegments(net.segments, state.branchIndex, 12, 'named'); // names given in this app -> s.named
  for (const s of net.segments) {
    s.branch = s.named ?? s.ref ?? null;
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
const systemName = () => settings.systemName || suggestSystemName();

async function askSystemName() {
  const suggestion = suggestSystemName();
  const res = await ask({
    title: 'Name of the trail system',
    body: 'The whole network of trails. Each named stretch inside it is a branch.',
    input: { value: systemName(), placeholder: 'e.g. MacGregor Estates Trail' },
    chips: suggestion !== systemName() ? [suggestion] : [],
    buttons: [{ label: 'SAVE', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }],
  });
  if (res.button !== 'save' || !res.text) return false;
  settings.systemName = res.text.slice(0, 60);
  saveSettings();
  state.lastKml = null;
  if (state.view === 'net') renderNetwork(false);
  return true;
}
$('btn-sys').addEventListener('click', askSystemName);

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
  $('sys-note').textContent = settings.systemName ? 'Used as the name of the Google Earth file and map.'
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
  b.wide - b.narrow < 0.05 ? `${b.wide.toFixed(1)} m wide` : `${b.narrow.toFixed(1)} to ${b.wide.toFixed(1)} m wide`}</span></span>
      <span class="pct">${fmtDist(b.length)}</span></li>`).join('');

  $('seg-details').hidden = !net.segments.length;
  $('seg-details').querySelector('summary').textContent = `Trail segments (${net.segments.length})`;
  $('seg-list').innerHTML = net.segments.map((s) => `
    <li class="tap ${s.id === state.focusSeg ? 'sel' : ''}" data-seg="${s.id}"><span class="dot" style="background:${s.id === state.focusSeg ? '#fff' : css}"></span>
      <span>${esc(s.name)} <span class="sub">${fmtDist(s.length)} · ${widthLabel(s.width)} · ridden ×${s.passes} · ${esc(s.contributors.join(', '))}</span></span>
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
  if (state.view === 'rides') renderRides();
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
  renderSettings();
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
  if (state.current || $('dlg').open) {
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
  if (state.current || $('dlg').open) { // something started while the files were coming down
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
bindSetting('autopause', 'autoPause', { event: 'change' });
bindSetting('awake', 'keepAwake', { event: 'change', after: () => setWake(!!state.current && settings.keepAwake) });
bindSetting('show-raw', 'showRaw', { event: 'change', after: () => renderNetwork(false) });
bindSetting('show-merged', 'showMerged', { event: 'change', after: () => renderNetwork(false) });
bindSetting('show-ref', 'showRef', { event: 'change', after: () => { renderNetwork(false); refreshRideMap(); } });
bindSetting('color', 'color', { event: 'change', after: () => { state.lastKml = null; } });

async function setReference(ref) {
  state.ref = ref;
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
  for (const v of ['ride', 'rides', 'net', 'settings']) $(`view-${v}`).hidden = v !== view;
  for (const b of $('tabs').children) b.classList.toggle('active', b.dataset.view === view);
  if (view === 'rides') renderRides();
  if (view === 'settings') renderSettings();
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
$('btn-finish').addEventListener('click', finishRide);
$('btn-pin').addEventListener('click', dropPin);
$('btn-pin-idle').addEventListener('click', dropPin);
$('btn-photo').addEventListener('click', takePhoto);
$('btn-photo-idle').addEventListener('click', takePhoto);
$('btn-pause').addEventListener('click', () => {
  if (tracker.state === 'paused') tracker.resume(); else tracker.pause();
  if (state.current) db.put('rides', state.current);
});
$('status').addEventListener('click', () => { if (!state.gpsWanted) startGps(); });

$('ride-in').addEventListener('click', () => rideMap.zoom(1.5));
$('ride-out').addEventListener('click', () => rideMap.zoom(1 / 1.5));
$('ride-center').addEventListener('click', () => {
  if (!state.gpsWanted) startGps();
  rideMap.center();
});
$('ride-fit').addEventListener('click', () => rideMap.fit());
rideMap.onFollowChange = (on) => $('ride-center').classList.toggle('on', on);
$('net-in').addEventListener('click', () => netMap.zoom(1.5));
$('net-out').addEventListener('click', () => netMap.zoom(1 / 1.5));
$('net-fit').addEventListener('click', () => { if (!netMap.fit(['raw', 'merged'])) netMap.fit(); });

document.addEventListener('visibilitychange', () => {
  if (!tracker) return;
  if (document.visibilityState === 'hidden') {
    state.hiddenAt = Date.now();
    if (state.current) db.put('rides', state.current);
    else tracker.unwatch(); // save the battery when nothing is being recorded
    return;
  }
  if (state.gpsWanted) tracker.watch();
  if (state.current) {
    setWake(true);
    const away = Date.now() - state.hiddenAt;
    if (away > 15000 && tracker.state === 'recording') {
      notice(`GPS was not recorded for ${fmtDur(away)} while the screen was off or another app was in front. Keep this screen on while riding.`);
    }
  } else if (Date.now() - update.checkedAt > 10 * 60000) {
    checkForUpdate(); // the app was brought back to the front: same check as when it opens
  }
});

setInterval(() => { if (tracker) { updateStats(); updateStatus(); } }, 2000);

// ---- start-up -------------------------------------------------------------------

async function boot() {
  for (const [key, c] of Object.entries(TRAIL_COLORS)) $('color').add(new Option(c.label, key));
  await loadAll();

  let geo = navigator.geolocation;
  if (DEMO) {
    geo = (await import('./demo.js')).createDemoGeo(state.ref);
    $('demo-flag').hidden = false;
  }
  // The GPS filters are tuned to what the ride is on: a walker is slower than a machine.
  const trackerSettings = () => ({ ...settings, kind: methodOf(state.current ?? { vehicle: settings.vehicle }).kind });
  tracker = new Tracker(trackerSettings, { fix: onFix, point: onPoint, status: updateRideUi }, geo);

  refreshRideMap();
  renderSettings();
  rideMap.fit();
  updateRideUi();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // Turn GPS on straight away if this site already has permission; otherwise wait for a tap.
  let granted = DEMO;
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
}

boot().catch((err) => {
  console.error(err);
  notice(`The app could not start: ${err.message}`);
});
