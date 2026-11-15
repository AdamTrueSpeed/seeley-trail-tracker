// Scavenger hunts.
//
// A hunt is a list of things to find. Each one is either
//   - something to photograph ("Mushroom"): found by taking its photo, or
//   - a place to reach ("Old bridge"): found by getting within a few metres of it.
// A hunt can be handed to someone else as a link or a code; the whole hunt is
// packed into that text, so nothing is stored anywhere but on the phones.

import { haversine } from './geo.js';

/** Things worth looking for on a walk in the woods. */
export const NATURE_ITEMS = [
  'Mushroom', 'Animal tracks', 'Big tree', 'Wildflowers', 'Berry patch', 'Bird nest', 'Feather', 'Pine cone',
  'Interesting rock', 'Moss', 'Spider web', 'Creek or pond', 'Fallen log', 'Fern', 'Hollow tree', 'Birch bark',
  'Something red', 'Something that flies', 'Animal home', 'Leaf bigger than your hand', 'Trail marker', 'Deer stand',
];

export const REACH = 20; // metres: this close to a place counts as finding it

const newId = () => Math.random().toString(36).slice(2, 8);

/** One thing to photograph. */
export const photoItem = (name) => ({ id: newId(), kind: 'photo', name });

/**
 * A hunt for things to photograph, picked at random.
 * @param random a function like Math.random (tests pass their own)
 */
export function natureHunt(count, random = Math.random) {
  const pool = NATURE_ITEMS.slice();
  const items = [];
  while (items.length < count && pool.length) {
    items.push(photoItem(pool.splice(Math.floor(random() * pool.length), 1)[0]));
  }
  return { id: newId(), name: 'Nature photo hunt', hints: true, items };
}

/**
 * A hunt for places, from pins already on the map.
 * @param pins [{ name, lat, lon }]
 */
export function placesHunt(pins, name = 'Places hunt') {
  return {
    id: newId(),
    name,
    hints: true,
    items: pins.map((p) => ({ id: newId(), kind: 'place', name: p.name, lat: p.lat, lon: p.lon })),
  };
}

// ---- playing ----------------------------------------------------------------------

/**
 * Which places has this position just reached?
 * @param progress { found: { [itemId]: {...} } }
 * @returns the items newly reached (not yet marked found)
 */
export function placesReached(hunt, progress, fix) {
  return hunt.items.filter((it) => it.kind === 'place' && !progress.found[it.id]
    && haversine(fix.lat, fix.lon, it.lat, it.lon) <= REACH);
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** "about 140 m to the north-east", or a nudge when very close. */
export function hintFor(item, fix) {
  const d = haversine(fix.lat, fix.lon, item.lat, item.lon);
  if (d <= REACH * 2) return 'Very close: look around!';
  const toRad = Math.PI / 180;
  const y = Math.sin((item.lon - fix.lon) * toRad) * Math.cos(item.lat * toRad);
  const x = Math.cos(fix.lat * toRad) * Math.sin(item.lat * toRad)
    - Math.sin(fix.lat * toRad) * Math.cos(item.lat * toRad) * Math.cos((item.lon - fix.lon) * toRad);
  const bearing = (Math.atan2(y, x) / toRad + 360) % 360;
  const far = d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`;
  return `about ${far} to the ${COMPASS[Math.round(bearing / 45) % 8]}`;
}

export const foundCount = (hunt, progress) => hunt.items.filter((it) => progress.found[it.id]).length;
export const isComplete = (hunt, progress) => hunt.items.length > 0 && foundCount(hunt, progress) === hunt.items.length;

// ---- sharing -------------------------------------------------------------------------

const toB64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (code) => new TextDecoder().decode(Uint8Array.from(atob(code.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

/** Pack a hunt into a short code (letters, digits, - and _) that survives being put in a link. */
export function encodeHunt(hunt) {
  return toB64(JSON.stringify({
    n: hunt.name,
    h: hunt.hints ? 1 : 0,
    by: hunt.by ?? '',
    i: hunt.items.map((it) => (it.kind === 'place'
      ? [1, it.name, it.clue ?? '', Math.round(it.lat * 1e6) / 1e6, Math.round(it.lon * 1e6) / 1e6]
      : [0, it.name, it.clue ?? ''])),
  }));
}

/**
 * Unpack a code, or a whole link with a code in it. Returns the hunt, or null
 * if the text is not one. Everything in it is checked: it came from someone else.
 */
export function decodeHunt(text) {
  try {
    const code = (/[#&?]hunt=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? String(text).trim()).replace(/\s+/g, '');
    const raw = JSON.parse(fromB64(code));
    if (!Array.isArray(raw.i) || !raw.i.length || raw.i.length > 60) return null;
    const clean = (s, max) => String(s ?? '').slice(0, max);
    const items = [];
    for (const row of raw.i) {
      if (!Array.isArray(row) || !clean(row[1], 60)) return null;
      if (row[0] === 1) {
        const lat = Number(row[3]), lon = Number(row[4]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
        items.push({ id: newId(), kind: 'place', name: clean(row[1], 60), clue: clean(row[2], 120), lat, lon });
      } else {
        items.push({ id: newId(), kind: 'photo', name: clean(row[1], 60), clue: clean(row[2], 120) });
      }
    }
    return { id: newId(), name: clean(raw.n, 60) || 'Scavenger hunt', hints: !!raw.h, by: clean(raw.by, 40), items };
  } catch {
    return null;
  }
}
