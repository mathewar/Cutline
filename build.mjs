// Assembles the static site into dist/. No bundling or transpiling: it copies the app
// files and the two vendored libraries (from node_modules, pinned in package.json).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';

const out = 'dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/vendor`, { recursive: true });

for (const p of ['index.html', 'css', 'js']) cpSync(p, `${out}/${p}`, { recursive: true });

const vendor = [
  ['node_modules/mediabunny/dist/bundles/mediabunny.min.mjs', 'mediabunny.min.mjs'],
  ['node_modules/hls.js/dist/hls.min.mjs', 'hls.min.mjs'],
  ['node_modules/mediabunny/LICENSE', 'mediabunny.LICENSE'],
  ['node_modules/hls.js/LICENSE', 'hls.LICENSE'],
];
for (const [from, to] of vendor) {
  const src = existsSync(from) ? from : `vendor/${to}`; // fall back to the copies shipped in the zip
  const text = readFileSync(src, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  writeFileSync(`${out}/vendor/${to}`, text);
}
console.log('Built static site in dist/');
