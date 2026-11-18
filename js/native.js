// What changes when the app runs inside the Android app (android-app/) rather
// than in a browser.
//
// The Android app is a thin shell that shows this same web app, so it updates
// itself the same way. The shell adds three things a web page cannot do:
//   - GPS that keeps coming with the screen off or another app in front
//     (a "recording your trail" notification stays up while it does);
//   - the phone's share sheet for messages;
//   - saving and sharing files (exports and backups).
// Nothing here is loaded in a browser.

/** True inside the Android app. The shell puts `Capacitor` on the page before any of the app's code runs. */
export const NATIVE = !!globalThis.Capacitor?.isNativePlatform?.();

let plugins = null;
/**
 * Do something with one of the shell's plugins: `use('Share', (share) => share.share(...))`.
 *
 * The plugin is handed to a function, never returned from a promise. A plugin
 * answers to ANY name asked of it, including `then`, so a promise given one
 * takes it for another promise, waits on it, and never finishes. That is what
 * left the Android app with no GPS and no error (fixed in 1.27).
 */
export async function use(name, fn) {
  plugins ??= import('./capacitor-core.js');
  const { registerPlugin } = await plugins;
  if (!known.has(name)) known.set(name, registerPlugin(name));
  return fn(known.get(name));
}
const known = new Map();

/**
 * A stand-in for navigator.geolocation that keeps working with the screen off.
 * Only what tracker.js uses: watchPosition and clearWatch.
 */
/**
 * If the phone's background GPS cannot be started (anything but "location is
 * blocked"), or does not answer within 8 seconds, the page's own GPS is used
 * instead: the same one the web version uses, which works while the screen is
 * on. So the app can always record, and `onNote(why)` lets it say what happened.
 * The page's GPS is dropped again the moment the background one delivers.
 */
export function nativeGeo(onNote) {
  const watchers = new Map();
  let next = 1;
  return {
    watchPosition(ok, fail, opts) {
      const id = next++;
      const w = { native: null, web: null, timer: null, done: false };
      watchers.set(id, w);
      const fallBack = (why) => {
        if (w.done || w.web != null) return;
        if (!navigator.geolocation) { fail?.({ code: 2, message: why }); return; }
        onNote?.(why);
        w.web = navigator.geolocation.watchPosition(ok, fail, opts);
      };
      w.timer = setTimeout(() => fallBack('the phone did not answer'), 8000);
      w.slow = setTimeout(() => fallBack('it has given no position yet'), 20000); // registered, but silent
      w.native = use('BackgroundGeolocation', (geo) => geo.addWatcher({
        backgroundTitle: 'Seeley Trail Tracker',
        backgroundMessage: 'GPS is on. Tap to open the app.',
        requestPermissions: true,
        stale: false,
        distanceFilter: 0,
      }, (loc, err) => {
        clearTimeout(w.slow);
        if (err) {
          clearTimeout(w.timer);
          const message = err.message ?? String(err.code);
          if (err.code === 'NOT_AUTHORIZED') fail?.({ code: 1, message }); // blocked or switched off: only the user can change that
          else fallBack(message);
          return;
        }
        if (!loc || w.done) return;
        if (w.web != null) { navigator.geolocation.clearWatch(w.web); w.web = null; onNote?.(null); } // the real thing has arrived
        ok({
          timestamp: loc.time ?? Date.now(),
          coords: { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, altitude: loc.altitude ?? null, speed: loc.speed ?? null, heading: loc.bearing ?? null },
        });
      })).then((watcher) => { clearTimeout(w.timer); return watcher; })
        .catch((err) => { clearTimeout(w.timer); fallBack(String(err?.message ?? err)); return null; });
      return id;
    },
    clearWatch(id) {
      const w = watchers.get(id);
      if (!w) return;
      watchers.delete(id);
      w.done = true;
      clearTimeout(w.timer);
      clearTimeout(w.slow);
      if (w.web != null) navigator.geolocation.clearWatch(w.web);
      w.native?.then((watcher) => (watcher != null ? use('BackgroundGeolocation', (geo) => geo.removeWatcher({ id: watcher })) : null)).catch(() => {});
    },
  };
}

/** Open the phone's settings page for this app (to allow location after it was refused). */
export const openAppSettings = () => use('BackgroundGeolocation', (geo) => geo.openSettings());

const toBase64 = (buffer) => {
  let s = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Put a file where the share sheet can reach it; returns its address on the phone. */
async function stash(name, data) {
  const buffer = typeof data === 'string' ? new TextEncoder().encode(data).buffer : data instanceof Blob ? await data.arrayBuffer() : data;
  const saved = await use('Filesystem', (fs) => fs.writeFile({ path: `share/${name.replace(/[^\w.\- ]+/g, '_')}`, data: toBase64(buffer), directory: 'CACHE', recursive: true }));
  return saved.uri;
}

/**
 * Hand a file to the user through the share sheet (Save to Drive, Google Earth, email…).
 * A web page inside an app cannot simply "download".
 * @returns 'shared' or 'cancelled'
 */
export async function nativeSave(name, data) {
  try {
    const files = [await stash(name, data)];
    await use('Share', (share) => share.share({ title: name, files, dialogTitle: `Save or send ${name}` }));
    return 'shared';
  } catch (err) {
    if (/cancel/i.test(String(err?.message ?? err))) return 'cancelled';
    throw err;
  }
}

/** Give the page a navigator.share that works inside the app, so every "share" button behaves as it does in a browser. */
export function installShare() {
  if (!NATIVE) return;
  const share = async (msg = {}) => {
    const files = await Promise.all((msg.files ?? []).map((f) => stash(f.name, f)));
    try {
      await use('Share', (plugin) => plugin.share({ title: msg.title, text: msg.text, url: files.length ? undefined : msg.url, files: files.length ? files : undefined, dialogTitle: msg.title }));
    } catch (err) {
      if (/cancel/i.test(String(err?.message ?? err))) throw new DOMException('Share cancelled', 'AbortError');
      throw err;
    }
  };
  try {
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  } catch { /* the page keeps its copy-to-clipboard fallback */ }
}
