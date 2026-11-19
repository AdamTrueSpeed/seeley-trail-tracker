// Cloud sync: this device's storage (db.js) and the family's database on
// Cloudflare (worker/index.js) exchange changes whenever there is a signal.
//
// The device's own storage stays the working copy, so everything still works
// with no signal. Each change made here is noted in an outbox; a sync sends
// the outbox, takes in what other devices changed, then moves the bulky parts
// (a ride's GPS points, a photo's picture) whichever way they are missing.
// When two devices change the same thing, the later change wins.

import { db } from './db.js';
import { newTransferCode } from './transfer.js';

// Where the database lives when the app itself is opened from somewhere else (the old GitHub address).
export const CLOUD = 'https://seeley-trail-tracker.seeley-trails.workers.dev';
const api = () => (location.hostname.endsWith('github.io') ? `${CLOUD}/api` : `${location.origin}/api`);

/** A new family sync code: long and random, it is the only key to the family's rides. */
export const newSyncCode = newTransferCode;

/** Tidy up a pasted code, or pull it out of a link (…#sync=CODE). Null if it is not one. */
export function cleanSyncCode(text) {
  const raw = /[#&?]sync=([A-Za-z0-9-]+)/.exec(String(text ?? ''))?.[1] ?? String(text ?? '');
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-HJKMNP-TV-Z2-9]{26}$/.test(s) ? s : null;
}

/** Start again from nothing (a different family code is being used on this device). */
export const forgetSync = () => db.del('kv', 'sync');

const POINT_FIELDS = ['seg', 'lat', 'lon', 'alt', 't', 'acc', 'spd', 'cond'];
// The cloud's refusals that mean something to a person, in words for the screen.
const REFUSED = { 429: 'the cloud is busy; it will carry on in a minute', 507: 'your family\'s cloud space is full' };

/**
 * One full exchange with the cloud.
 * @param shared { get(), set(data) } the settings every device shares (trail system name, added methods of travel)
 * @returns { changed, sent, got }: `changed` means this device's storage now holds something new
 */
export async function syncNow(code, shared) {
  const call = async (path, init = {}) => {
    const res = await fetch(`${api()}/${path}`, { ...init, cache: 'no-store', headers: { Authorization: `Bearer ${code}`, ...(init.headers ?? {}) } });
    if (!res.ok && res.status !== 404) throw new Error(REFUSED[res.status] ?? `cloud ${res.status}`);
    return res;
  };
  const state = { cursor: 0, points: {}, photos: {}, kvAt: {}, ...((await db.get('kv', 'sync')) ?? {}) };
  let changed = false, sent = 0, got = 0, skipped = 0;

  // ---- what has changed here ----
  const byId = async (store) => new Map((await db.all(store)).map((v) => [String(v.id), v]));
  let rides = await byId('rides'), pins = await byId('pins');
  const notes = await db.all('outbox');
  const noted = new Map(notes.map((n) => [`${n.kind}:${n.id}`, n.updated]));
  const out = [];
  for (const n of notes) {
    const item = { kind: n.kind, id: n.id, updated: n.updated, deleted: !!n.deleted };
    if (n.deleted) { out.push(item); continue; }
    if (n.kind === 'ride') {
      const ride = rides.get(n.id);
      if (ride && ride.status !== 'done') continue; // still being recorded: it goes when it is saved
      item.data = ride;
    } else if (n.kind === 'pin') item.data = pins.get(n.id);
    else item.data = n.id === 'prefs' ? shared.get() : await db.get('kv', n.id);
    if (item.data == null) await db.sent(item); // noted, then removed again before it could be sent
    else out.push(item);
  }

  // ---- send it, and take in what other devices changed ----
  const take = async (item) => {
    if ((noted.get(`${item.kind}:${item.id}`) ?? 0) >= item.updated) return; // this device's own, or changed here since
    if (item.kind === 'kv') {
      if ((state.kvAt[item.id] ?? 0) >= item.updated || item.deleted) return;
      state.kvAt[item.id] = item.updated;
      if (item.id === 'prefs') shared.set(item.data ?? {});
      else if (item.id === 'branches') await db.put('kv', item.data ?? [], 'branches', { remote: true });
      changed = true;
      return;
    }
    const mine = (item.kind === 'ride' ? rides : pins).get(item.id);
    if (mine?.status === 'recording') return;
    if (item.deleted) {
      if (!mine) return;
      if (item.kind === 'ride') await db.deleteRide(mine.id, { remote: true });
      else {
        await db.del('pins', mine.id, { remote: true });
        await db.del('photos', mine.id);
      }
      delete state[item.kind === 'ride' ? 'points' : 'photos'][item.id];
    } else {
      if (!item.data || (mine?.updated ?? 0) >= item.updated) return;
      await db.put(item.kind === 'ride' ? 'rides' : 'pins', { ...item.data, updated: item.updated }, undefined, { remote: true });
    }
    changed = true;
    got++;
  };
  let more = true;
  while (more) {
    const batch = out.splice(0, 100);
    const res = await (await call('sync', { method: 'POST', body: JSON.stringify({ since: state.cursor, items: batch }) })).json();
    for (const item of batch) {
      await db.sent(item);
      if (item.kind === 'kv') state.kvAt[item.id] = item.updated;
    }
    sent += batch.length;
    for (const item of res.items ?? []) await take(item);
    state.cursor = res.seq ?? state.cursor;
    await db.put('kv', state, 'sync');
    more = out.length > 0 || !!res.more;
  }

  // ---- the bulky parts, whichever way they are missing ----
  rides = await byId('rides');
  pins = await byId('pins');
  for (const [id, ride] of rides) {
    if (state.points[id] || ride.status !== 'done') continue;
    const points = await db.pointsOf(ride.id);
    if (points.length) {
      const slim = points.map((p) => Object.fromEntries(POINT_FIELDS.filter((f) => p[f] != null).map((f) => [f, p[f]])));
      await call(`points/${id}`, { method: 'PUT', body: JSON.stringify(slim) });
    } else {
      const res = await call(`points/${id}`);
      if (res.status === 404) continue; // the device that recorded it has not sent them yet
      await db.addPoints((await res.json()).map((p) => ({ ...p, ride: ride.id })));
      changed = true;
    }
    state.points[id] = 1;
    await db.put('kv', state, 'sync');
  }
  for (const [id, pin] of pins) {
    if (state.photos[id] || !pin.photo) continue;
    const mine = await db.get('photos', pin.id);
    if (mine) {
      // One picture that will not go must not hold up everything else: it is tried again next time.
      try {
        const fit = await fitPhoto(mine);
        await call(`photo/${id}`, { method: 'PUT', body: fit.data, headers: { 'Content-Type': fit.type || 'image/jpeg' } });
      } catch { skipped++; continue; }
    } else {
      const res = await call(`photo/${id}`);
      if (res.status === 404) continue;
      await db.put('photos', { id: pin.id, type: res.headers.get('Content-Type') || 'image/jpeg', data: await res.arrayBuffer() });
    }
    state.photos[id] = 1;
    await db.put('kv', state, 'sync');
  }
  return { changed, sent, got, skipped };
}

/** The cloud takes pictures up to about 1.9 MB; some phones' cameras make bigger ones. */
const PHOTO_ROOM = 1500000;

/**
 * A copy of a picture small enough for the cloud. The full picture stays on this device.
 * @param photo { type, data: ArrayBuffer }
 */
export async function fitPhoto(photo) {
  // The cloud takes only JPEG, PNG and WebP; any other kind (an iPhone's HEIC, say) goes up as a JPEG copy.
  if (photo.data.byteLength <= PHOTO_ROOM && ['image/jpeg', 'image/png', 'image/webp'].includes(photo.type || 'image/jpeg')) return photo;
  const url = URL.createObjectURL(new Blob([photo.data], { type: photo.type || 'image/jpeg' }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('not a picture'));
      img.src = url;
    });
    for (const [side, quality] of [[2048, 0.7], [1600, 0.75], [1280, 0.75], [1024, 0.7]]) {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= PHOTO_ROOM) return { type: 'image/jpeg', data: await blob.arrayBuffer() };
    }
    throw new Error('picture too large');
  } finally {
    URL.revokeObjectURL(url);
  }
}
