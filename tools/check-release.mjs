// Run before publishing: makes sure phones will be able to update themselves.
// Usage: node tools/check-release.mjs
//
// The app compares its own version with version.json on the website and, if
// they differ, downloads every file listed there. So the two version numbers
// must agree, and the list must name every file the app is made of.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const info = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'));
const problems = [];

const inApp = /const VERSION = '([^']+)'/.exec(readFileSync(join(root, 'js/app.js'), 'utf8'))?.[1];
if (inApp !== info.version) problems.push(`js/app.js says version ${inApp}, version.json says ${info.version}`);

const needed = [
  './', 'index.html', 'styles.css', 'manifest.json',
  ...readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`),
  ...readdirSync(join(root, 'icons')).map((f) => `icons/${f}`),
];
for (const f of needed) if (!info.files.includes(f)) problems.push(`version.json does not list ${f}`);
for (const f of info.files) if (f !== './' && !existsSync(join(root, f))) problems.push(`version.json lists ${f}, which does not exist`);

// ---- the built-in trail map must be the newest there is (owner's standing instruction, 2026-11-16) ----
//
// The official map is built outside this project (the MFTIP folder beside it) from the GPS
// outings in the cloud database; reference.kml here is a copy of it. Two things can leave the
// copy behind: the official map was rebuilt, or outings were recorded that are not on any map yet.
// On a computer without that folder these checks are skipped. SEELEY_SKIP_MAP=1 skips them on purpose.
if (!process.env.SEELEY_SKIP_MAP) {
  const { inflateRawSync } = await import('node:zlib');
  const { execFileSync } = await import('node:child_process');
  const kmz = process.env.SEELEY_MAP_KMZ
    ?? join(root, '..', 'Session Handoff - Unassociated Items', 'working-directory', 'MFTIP Application 1142 County Rd 43', '_work', 'MacGregor_Estates_Trails.kmz');
  const walks = join(root, '..', 'trail-walks', 'walks.json');
  if (existsSync(kmz)) {
    // doc.kml is the first file in the KMZ (a zip): read its local header, then unpack it.
    const zip = readFileSync(kmz);
    const nameLen = zip.readUInt16LE(26), extraLen = zip.readUInt16LE(28), size = zip.readUInt32LE(18), method = zip.readUInt16LE(8);
    const body = zip.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + size);
    const official = (method === 0 ? body : inflateRawSync(body)).toString('utf8');
    const mine = readFileSync(join(root, 'reference.kml'), 'utf8');
    const same = (a, b) => a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();
    if (!same(official, mine)) problems.push('reference.kml is not the newest trail map: copy doc.kml out of MacGregor_Estates_Trails.kmz and raise REF_VERSION in js/app.js');
    else console.log('ok   the built-in trail map is the newest official map');
  } else console.log('note the official trail map is not on this computer: could not check that the built-in map is the newest');
  if (existsSync(walks)) {
    try {
      const out = execFileSync(process.execPath, [join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'd1', 'execute', 'seeley-trails', '--remote', '--json',
        '--command', "SELECT id, json_extract(data, '$.name') AS name FROM items WHERE kind = 'ride' AND deleted = 0"], { cwd: root, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
      const cloud = JSON.parse(out.slice(out.indexOf('[')))[0].results;
      const onMap = new Set(JSON.parse(readFileSync(walks, 'utf8')).rides.map((r) => String(r.id)));
      const missing = cloud.filter((r) => !onMap.has(String(r.id)));
      if (missing.length) problems.push(`${missing.length} outing(s) in the cloud are not on the trail map yet (${missing.map((r) => r.name || r.id).join(', ')}): bring the map up to date first, or tell the owner why not`);
      else console.log(`ok   all ${cloud.length} outings in the cloud are already on the trail map`);
    } catch {
      console.log('note the cloud could not be reached: could not look for outings newer than the trail map');
    }
  }
}

for (const p of problems) console.log(`FAIL ${p}`);
console.log(problems.length ? `\n${problems.length} problem(s): fix before publishing` : `ok   version ${info.version}, ${info.files.length} files listed`);
process.exit(problems.length ? 1 : 0);
