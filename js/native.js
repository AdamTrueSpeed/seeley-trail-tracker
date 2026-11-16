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
/** The shell's plugins, by name. */
async function plugin(name) {
  plugins ??= import('./capacitor-core.js');
  return (await plugins).registerPlugin(name);
}

/**
 * A stand-in for navigator.geolocation that keeps working with the screen off.
 * Only what tracker.js uses: watchPosition and clearWatch.
 */
export function nativeGeo() {
  const watchers = new Map();
  let next = 1;
  return {
    watchPosition(ok, fail) {
      const id = next++;
      watchers.set(id, plugin('BackgroundGeolocation').then((geo) => geo.addWatcher({
        backgroundTitle: 'Seeley Trail Tracker',
        backgroundMessage: 'GPS is on. Tap to open the app.',
        requestPermissions: true,
        stale: false,
        distanceFilter: 0,
      }, (loc, err) => {
        if (err) {
          fail?.({ code: err.code === 'NOT_AUTHORIZED' ? 1 : 2, message: err.message ?? String(err.code) });
          return;
        }
        if (!loc) return;
        ok({
          timestamp: loc.time ?? Date.now(),
          coords: { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, altitude: loc.altitude ?? null, speed: loc.speed ?? null, heading: loc.bearing ?? null },
        });
      })).catch((err) => { fail?.({ code: 2, message: String(err?.message ?? err) }); return null; }));
      return id;
    },
    clearWatch(id) {
      const pending = watchers.get(id);
      watchers.delete(id);
      pending?.then(async (watcher) => { if (watcher != null) (await plugin('BackgroundGeolocation')).removeWatcher({ id: watcher }); }).catch(() => {});
    },
  };
}

/** Open the phone's settings page for this app (to allow location after it was refused). */
export const openAppSettings = async () => (await plugin('BackgroundGeolocation')).openSettings();

const toBase64 = (buffer) => {
  let s = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Put a file where the share sheet can reach it; returns its address on the phone. */
async function stash(name, data) {
  const buffer = typeof data === 'string' ? new TextEncoder().encode(data).buffer : data instanceof Blob ? await data.arrayBuffer() : data;
  const fs = await plugin('Filesystem');
  return (await fs.writeFile({ path: `share/${name.replace(/[^\w.\- ]+/g, '_')}`, data: toBase64(buffer), directory: 'CACHE', recursive: true })).uri;
}

/**
 * Hand a file to the user through the share sheet (Save to Drive, Google Earth, email…).
 * A web page inside an app cannot simply "download".
 * @returns 'shared' or 'cancelled'
 */
export async function nativeSave(name, data) {
  const share = await plugin('Share');
  try {
    await share.share({ title: name, files: [await stash(name, data)], dialogTitle: `Save or send ${name}` });
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
      await (await plugin('Share')).share({ title: msg.title, text: msg.text, url: files.length ? undefined : msg.url, files: files.length ? files : undefined, dialogTitle: msg.title });
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
