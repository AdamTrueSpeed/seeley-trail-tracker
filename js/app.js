// Seeley Trail Tracker: screens and glue. The heavy lifting lives in
// tracker.js (GPS), merge.js (de-duplication), kml.js (export) and db.js (storage).

import { db, keepStorage } from './db.js';
import { Tracker } from './tracker.js';
import { MapView } from './mapview.js';
import { buildNetwork } from './merge.js';
import { buildKml, parseKml, readKmlFile, TRAIL_COLORS } from './kml.js';
import { prepareReference, nameSegments, coverage } from './reference.js';
import { haversine } from './geo.js';

const VERSION = '1.0';
const DEMO = new URLSearchParams(location.search).has('demo');
const PIN_LABELS = ['Hazard', 'Bridge', 'Intersection', 'Trailhead', 'Gate', 'Water crossing', 'Fallen tree', 'Viewpoint'];
const SAVED_COLOR = '#2fbf9f';
const RAW_COLOR = '#8a97a6';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- settings ---------------------------------------------------------------

const DEFAULTS = {
  threshold: 8, smoothing: 3,             // merge
  maxAcc: 15, minDist: 3, autoPause: true, keepAwake: true, // recording
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
 * Modal question. Resolves with { button, text } where button is the chosen
 * button's value, 'chip' (with .chip) or 'cancel'.
 */
function ask({ title, body = '', input = null, chips = [], buttons, focus = true }) {
  const dlg = $('dlg'), inp = $('dlg-input');
  const make = (label, cls, type) => Object.assign(document.createElement('button'), { textContent: label, className: cls, type });
  $('dlg-title').textContent = title;
  $('dlg-body').textContent = body;
  $('dlg-body').hidden = !body;
  inp.hidden = !input;
  inp.value = input?.value ?? '';
  inp.placeholder = input?.placeholder ?? '';
  $('dlg-chips').replaceChildren(...chips.map((c) => {
    const b = make(c, '', 'button');
    b.addEventListener('click', () => dlg.close('chip:' + c));
    return b;
  }));
  $('dlg-btns').replaceChildren(...buttons.map((b) => Object.assign(make(b.label, `big ${b.cls ?? 'ghost'}`, 'submit'), { value: b.value })));
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => {
      const v = dlg.returnValue || 'cancel';
      const text = inp.value.trim();
      resolve(v.startsWith('chip:') ? { button: 'chip', chip: v.slice(5), text } : { button: v, text });
    }, { once: true });
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
  else if (rec) set('● RECORDING', 'rec');
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
async function setWake(on) {
  try {
    if (on && settings.keepAwake && !wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } else if (!on && wake) {
      const w = wake;
      wake = null;
      await w.release();
    }
  } catch { /* refused (e.g. battery saver): the Settings tips cover the manual fallback */ }
}

function startGps() {
  state.gpsWanted = true;
  tracker.watch();
  updateStatus();
}

async function startRide() {
  if (!tracker.geo) { toast('This browser cannot use GPS.'); return; }
  const ride = { id: Date.now(), name: '', startedAt: Date.now(), endedAt: Date.now(), status: 'recording', include: true, dist: 0, count: 0 };
  await db.put('rides', ride);
  state.rides.push(ride);
  state.tracks.set(ride.id, []);
  state.current = ride;
  state.network = null;
  rideMap.clearLive();
  startGps();
  tracker.start();
  rideMap.center();
  setWake(true);
  keepStorage();
  notice(settings.keepAwake && !('wakeLock' in navigator)
    ? 'This browser cannot keep the screen on by itself. Set your phone\'s screen timeout as long as it goes while riding.' : '');
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
      body: `${fmtDist(tracker.dist)} · ${tracker.count} points. Give it a name, such as the trail or loop you rode.`,
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
  state.network = null;
  rideMap.clearLive();
  refreshRideMap();
  notice('');
  updateRideUi();
}

async function dropPin() {
  const fresh = Date.now() - state.goodAt < 15000;
  const fix = fresh ? tracker.good : (Date.now() - state.fixAt < 15000 ? tracker.lastFix : null);
  if (!fix) {
    if (!state.gpsWanted) startGps();
    toast('No GPS position yet – try again in a moment.');
    return;
  }
  // The position is taken now; naming it can wait until you have stopped.
  const pin = { id: Date.now(), ride: state.current?.id ?? null, name: '', lat: fix.lat, lon: fix.lon, alt: fix.alt, acc: fix.acc, t: Date.now() };
  const res = await ask({
    title: 'Drop a pin here',
    body: fresh ? `Position locked (±${Math.round(fix.acc)} m). Pick a label or type your own.`
      : `GPS is weak right now (±${Math.round(fix.acc)} m), so this pin may be off.`,
    chips: PIN_LABELS,
    input: { placeholder: 'Your own label' },
    focus: false,
    buttons: [{ label: 'SAVE PIN', value: 'save', cls: 'info' }, { label: 'Cancel', value: 'cancel' }],
  });
  if (res.button === 'cancel') return;
  pin.name = res.button === 'chip' ? res.chip : (res.text || `Pin ${state.pins.length + 1}`);
  await db.put('pins', pin);
  state.pins.push(pin);
  rideMap.setPins(state.pins);
  toast(`Pin saved: ${pin.name}`);
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
        <div class="meta">${fmtDate(r.startedAt)} · ${fmtDist(r.dist)} · ${fmtDur(r.endedAt - r.startedAt)} · ${r.count} points</div></div>
      <div class="acts"><button data-act="rename">Rename</button><button data-act="show">Show on map</button><button data-act="delete" class="del">Delete</button></div>`;
    return li;
  }));
  $('ride-empty').hidden = rides.length > 0;

  $('pin-list').replaceChildren(...state.pins.map((p) => {
    const ride = state.rides.find((r) => r.id === p.ride);
    const li = document.createElement('li');
    li.dataset.id = p.id;
    li.innerHTML = `
      <div class="pinmark"></div>
      <div><div class="name">${esc(p.name)}</div>
        <div class="meta">${fmtDate(p.t)} · ±${Math.round(p.acc)} m${ride ? ` · ${esc(rideName(ride))}` : ''}</div></div>
      <div class="acts"><button data-act="rename">Rename</button><button data-act="delete" class="del">Delete</button></div>`;
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
    await db.deleteRide(ride.id);
    state.rides = state.rides.filter((r) => r !== ride);
    state.tracks.delete(ride.id);
  }
  if (act !== 'delete') await db.put('rides', ride);
  state.network = null;
  renderRides();
  refreshRideMap();
});

$('pin-list').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const pin = state.pins.find((p) => p.id === Number(e.target.closest('li')?.dataset.id));
  if (!act || !pin) return;
  if (act === 'rename') {
    const res = await ask({ title: 'Rename pin', chips: PIN_LABELS, input: { value: pin.name }, buttons: [{ label: 'SAVE', value: 'save', cls: 'go' }, { label: 'Cancel', value: 'cancel' }] });
    if (res.button === 'cancel' || (res.button === 'save' && !res.text)) return;
    pin.name = res.button === 'chip' ? res.chip : res.text;
    await db.put('pins', pin);
  } else if (act === 'delete') {
    const res = await ask({ title: `Delete pin "${pin.name}"?`, buttons: [{ label: 'Keep it', value: 'cancel', cls: 'go' }, { label: 'DELETE PIN', value: 'yes', cls: 'stop' }] });
    if (res.button !== 'yes') return;
    await db.del('pins', pin.id);
    state.pins = state.pins.filter((p) => p !== pin);
  }
  renderRides();
  rideMap.setPins(state.pins);
});

// ---- merge & export screen --------------------------------------------------

function computeNetwork() {
  const tracks = state.rides
    .filter((r) => r.include && state.tracks.get(r.id)?.length)
    .map((r) => ({ id: r.id, name: rideName(r), startedAt: r.startedAt, segments: state.tracks.get(r.id) }));
  const net = buildNetwork(tracks, settings);
  nameSegments(net.segments, state.refIndex);
  for (const s of net.segments) {
    const what = s.ref ?? (s.rides.length === 1 ? s.rides[0] : (state.refIndex ? 'New trail' : 'Trail'));
    s.name = `${what} · ${s.id}`;
  }
  net.tracks = tracks;
  state.network = net;
  state.lastKml = null;
  $('btn-share').hidden = true;
}

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
  const focus = state.tracks.get(state.focusRide);
  netMap.setLayer('focus', focus ? focus.map((pts) => ({ pts, color: '#ffffff', width: 2.5 })) : []);
  netMap.setPins(state.pins);

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

  $('seg-details').hidden = !net.segments.length;
  $('seg-details').querySelector('summary').textContent = `Trail segments in the network (${net.segments.length})`;
  $('seg-list').innerHTML = net.segments.map((s) => `
    <li><span class="dot" style="background:${css}"></span>
      <span>${esc(s.name)} <span class="sub">${s.points.length} points · ridden ×${s.passes}</span></span>
      <span class="pct">${fmtDist(s.length)}</span></li>`).join('');

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

function makeKml() {
  const net = state.network;
  const name = `trail-network_${stamp()}.kml`;
  const text = buildKml({
    name: `Trail network ${new Date().toLocaleDateString()}`,
    segments: net.segments,
    waypoints: state.pins.map((p) => ({ ...p, rideName: state.rides.find((r) => r.id === p.ride)?.name })),
    rides: net.tracks,
    color: settings.color,
    settings,
  });
  return { name, text, type: 'application/vnd.google-earth.kml+xml' };
}

$('btn-export').addEventListener('click', () => {
  if (!state.network?.segments.length) { toast('Nothing to export yet – record a ride first.'); return; }
  const kml = makeKml();
  download(kml.name, kml.text, kml.type);
  state.lastKml = new File([kml.text], kml.name, { type: kml.type });
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
  $('storage-info').textContent = `${doneRides().length} ride(s), ${points} GPS points and ${state.pins.length} pin(s) are stored on this phone.`;
  $('version').textContent = `Version ${VERSION}${DEMO ? ' · demo mode' : ''}`;
}

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

$('btn-backup').addEventListener('click', () => {
  const data = {
    app: 'trail-tracker', format: 1, exportedAt: new Date().toISOString(), settings,
    rides: state.rides.map((r) => ({ ...r, points: (state.tracks.get(r.id) ?? []).flat() })),
    pins: state.pins,
  };
  download(`trail-tracker-backup_${stamp()}.json`, JSON.stringify(data), 'application/json');
  toast('Backup saved to Downloads');
});
$('btn-restore').addEventListener('click', () => $('backup-file').click());
$('backup-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'trail-tracker' || !Array.isArray(data.rides)) throw new Error('That is not a Trail Tracker backup file.');
    let added = 0;
    for (const { points, ...ride } of data.rides) {
      if (state.rides.some((r) => r.id === ride.id) || !points?.length) continue;
      await db.put('rides', { ...ride, status: 'done', name: ride.name || 'Restored ride' });
      await db.addPoints(points.map((p) => ({ ...p, ride: ride.id })));
      added++;
    }
    for (const pin of data.pins ?? []) {
      if (!state.pins.some((p) => p.id === pin.id)) await db.put('pins', pin);
    }
    const current = state.current;
    await loadAll();
    if (current) state.current = state.rides.find((r) => r.id === current.id) ?? null;
    state.network = null;
    refreshRideMap();
    renderSettings();
    toast(added ? `Restored ${added} ride(s)` : 'Everything in that backup is already here');
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
    // Wait a frame so the map has its size before fitting to it.
    requestAnimationFrame(() => renderNetwork(true));
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
  tracker = new Tracker(() => settings, { fix: onFix, point: onPoint, status: updateRideUi }, geo);

  refreshRideMap();
  renderSettings();
  rideMap.fit();
  updateRideUi();
  await recoverUnfinished();
  updateRideUi();

  // Turn GPS on straight away if this site already has permission; otherwise wait for a tap.
  let granted = DEMO;
  try { granted ||= (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted'; } catch { /* not supported */ }
  if (granted) startGps();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot().catch((err) => {
  console.error(err);
  notice(`The app could not start: ${err.message}`);
});
