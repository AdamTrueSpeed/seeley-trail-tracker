// Listen on this computer for the rides a phone sends with "Send rides to my map"
// (Saved rides screen of the app). Needs the internet. See js/transfer.js.
//
// Usage:
//   node tools/receive-rides.mjs --new-code
//       prints a one-time code and the link to open on the phone
//   node tools/receive-rides.mjs <code> <folder> [hours]
//       waits (12 hours unless told otherwise) for the phone to send, saves
//       what arrives as walk-package_<date>.json in the folder, and stops

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newTransferCode, cleanTransferCode, receivePackage } from '../js/transfer.js';

const APP_URL = 'https://adamtruespeed.github.io/seeley-trail-tracker/'; // the same address as SHARE_URL in js/app.js

const [first, folder, hours] = process.argv.slice(2);
if (first === '--new-code') {
  const code = newTransferCode();
  console.log(`code ${code}`);
  console.log(`link ${APP_URL}#map=${code}`);
  process.exit(0);
}
const code = cleanTransferCode(first);
if (!code || !folder) {
  console.error('Usage: node tools/receive-rides.mjs --new-code | <code> <folder> [hours]');
  process.exit(1);
}

/** What arrived, in a few numbers. Throws if it is not rides from the app. */
function summarize(bytes) {
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (data.app !== 'trail-tracker' || !Array.isArray(data.rides)) throw new Error('not rides from Seeley Trail Tracker');
  const points = data.rides.reduce((n, r) => n + (r.points?.length ?? 0), 0);
  const metres = data.rides.reduce((d, r) => d + (r.dist ?? 0), 0);
  return { rides: data.rides.length, points, pins: data.pins?.length ?? 0, km: Math.round(metres / 10) / 100, from: String(data.contributor ?? '').slice(0, 40) };
}

console.log(`listening for a phone (up to ${Number(hours) || 12} h)`);
try {
  const got = await receivePackage(code, {
    summarize,
    waitMs: (Number(hours) || 12) * 3600000,
    onStatus: (line) => console.log(line),
  });
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const name = `walk-package_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, name), got.bytes);
  const s = got.summary;
  console.log(`received from ${s.from || 'someone'}: ${s.rides} ride(s), ${s.points} GPS points, ${s.km} km, ${s.pins} pin(s)`);
  console.log(`saved ${join(folder, name)}`);
  process.exit(0);
} catch (err) {
  console.log(err.message === 'timeout' ? 'nothing was sent before the time ran out' : `stopped: ${err.message}`);
  process.exit(err.message === 'timeout' ? 2 : 1);
}
