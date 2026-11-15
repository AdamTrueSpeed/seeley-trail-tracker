// On-device storage (IndexedDB). Everything is saved on the phone as it is
// recorded, so nothing depends on having a signal.
//
//   rides  { id, name, startedAt, endedAt, status: 'recording' | 'done', include, dist, count }
//   points { ride, seg, lat, lon, alt, t, acc, spd }     one record per GPS point
//   pins   { id, ride, name, lat, lon, alt, acc, t, photo, thumb }   waypoints (photo pins carry a small thumbnail)
//   photos { id (= its pin's id), type, data: ArrayBuffer }            the full picture of a photo pin
//   kv     misc single values (the imported reference map, branch names)

const NAME = 'trail-tracker';
const VERSION = 2; // 2 added the photos store

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
  put: (store, value, key) => tx(store, 'readwrite', (s) => s.put(value, key)),
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),

  addPoint: (p) => tx('points', 'readwrite', (s) => s.add(p)),
  addPoints: (list) => tx('points', 'readwrite', (s) => { for (const p of list) s.add(p); }),

  /** Points of one ride, oldest first. */
  pointsOf: (rideId) => tx('points', 'readonly', (s) => s.index('ride').getAll(rideId)),

  /** Remove a ride with its points; its waypoints are kept but detached. */
  deleteRide: (rideId) => tx(['rides', 'points'], 'readwrite', (rides, points) => {
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
