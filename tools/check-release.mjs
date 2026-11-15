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

for (const p of problems) console.log(`FAIL ${p}`);
console.log(problems.length ? `\n${problems.length} problem(s): fix before publishing` : `ok   version ${info.version}, ${info.files.length} files listed`);
process.exit(problems.length ? 1 : 0);
