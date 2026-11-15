// On-device storage (IndexedDB). Everything is saved on the phone as it is
// recorded, so nothing depends on having a signal.
//
//   rides  { id, name, startedAt, endedAt, status: 'recording' | 'done', include, dist, count }
//   points { ride, seg, lat, lon, alt, t, acc, spd }     one record per GPS point
//   pins   { id, ride, name, lat, lon, alt, acc, t, photo, thumb }   waypoints (photo pins carry a small thumbnail)
//   photos { id (= its pin's id), type, data: ArrayBuffer }            the full picture of a photo pin
//   kv     misc single values (the imported reference map, branch names)

//   outbox { kind, id, updated, deleted }   what has changed here since the last cloud sync (see sync.js)

const NAME = 'trail-tracker';
const VERSION = 3; // 2 added the photos store, 3 the outbox

// Stores whose records are shared through the cloud, and what a record is called there.
const SHARED = { rides: 'ride', pins: 'pin' };
const kindOf = (store, key) => SHARED[store] ?? (store === 'kv' && key === 'branches' ? 'kv' : null);
const note = (outbox, kind, id, updated, deleted) => outbox.put({ kind, id: String(id), updated, deleted }, `${kind}:${id}`);

let opening;
function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      // Runs for a brand-new phone and for one moving up from an older version,
      // so only add what is missing: nothing already recorded is touched.
      const d = req.result;
      const has = (store) => d.objectStoreNames.contains(store);
      if (!has('rides')) d.createObjectStore('rides', { keyPath: 'id' });
      if (!has('points')) d.createObjectStore('points', { autoIncrement: true }).createIndex('ride', 'ride');
      if (!has('pins')) d.createObjectStore('pins', { keyPath: 'id' });
      if (!has('kv')) d.createObjectStore('kv');
      if (!has('photos')) d.createObjectStore('photos', { keyPath: 'id' });
      if (!has('outbox')) d.createObjectStore('outbox');
    };
    req.onsuccess = () => {
      // If a newer copy of the app (another tab) needs to upgrade the storage, step aside.
      req.result.onversionchange = () => { req.result.close(); opening = undefined; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return opening;
}

/** Run fn(...stores) in one transaction and resolve with its request's result once committed. */
async function tx(stores, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const req = fn(...[].concat(stores).map((s) => t.objectStore(s)));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export const db = {
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  /**
   * Save a record. A ride, a pin or the branch names changed on this device is
   * stamped with the time and noted in the outbox, so the next cloud sync
   * passes it on. `remote` means the change came from the cloud: saved as it is.
   */
  put: (store, value, key, { remote = false } = {}) => {
    const kind = remote ? null : kindOf(store, key);
    if (!kind) return tx(store, 'readwrite', (s) => s.put(value, key));
    const updated = Date.now();
    if (kind !== 'kv') value.updated = updated;
    return tx([store, 'outbox'], 'readwrite', (s, outbox) => {
      note(outbox, kind, kind === 'kv' ? key : value.id, updated, false);
      return s.put(value, key);
    });
  },
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  del: (store, key, { remote = false } = {}) => {
    const kind = remote ? null : kindOf(store, key);
    if (!kind) return tx(store, 'readwrite', (s) => s.delete(key));
    return tx([store, 'outbox'], 'readwrite', (s, outbox) => {
      note(outbox, kind, key, Date.now(), true);
      return s.delete(key);
    });
  },

  /** Note a change to something kept outside these stores (the shared settings). */
  touch: (kind, id) => tx('outbox', 'readwrite', (outbox) => note(outbox, kind, id, Date.now(), false)),
  /** Forget an outbox note once the cloud has it, unless the thing has changed again since. */
  sent: (item) => tx('outbox', 'readwrite', (outbox) => {
    const key = `${item.kind}:${item.id}`;
    const req = outbox.get(key);
    req.onsuccess = () => { if (req.result && req.result.updated <= item.updated) outbox.delete(key); };
  }),
  /** Note everything on this device as changed (when cloud sync is first turned on). */
  touchAll: () => tx(['rides', 'pins', 'kv', 'outbox'], 'readwrite', (rides, pins, kv, outbox) => {
    const each = (store, kind) => {
      const req = store.getAll();
      req.onsuccess = () => { for (const v of req.result) note(outbox, kind, v.id, v.updated ?? 1, false); };
    };
    each(rides, 'ride');
    each(pins, 'pin');
    const req = kv.get('branches');
    req.onsuccess = () => { if (req.result?.length) note(outbox, 'kv', 'branches', 1, false); };
  }),

  addPoint: (p) => tx('points', 'readwrite', (s) => s.add(p)),
  addPoints: (list) => tx('points', 'readwrite', (s) => { for (const p of list) s.add(p); }),

  /** Points of one ride, oldest first. */
  pointsOf: (rideId) => tx('points', 'readonly', (s) => s.index('ride').getAll(rideId)),

  /** Remove a ride with its points; its waypoints are kept but detached. */
  deleteRide: (rideId, { remote = false } = {}) => tx(['rides', 'points', 'outbox'], 'readwrite', (rides, points, outbox) => {
    if (!remote) note(outbox, 'ride', rideId, Date.now(), true);
    rides.delete(rideId);
    const cursor = points.index('ride').openKeyCursor(IDBKeyRange.only(rideId));
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) { points.delete(c.primaryKey); c.continue(); }
    };
  }),
};

/** Ask the browser not to clear this data when the phone runs low on space. */
export async function keepStorage() {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}
