// Cache-buster for the no-build static site.
//
// GitHub Pages caches assets (~10 min), so a plain push can leave browsers running the
// old app.js. This stamps ?v=<contenthash> onto every LOCAL .js/.css reference - both the
// <script>/<link> tags in the HTML and every relative `import` inside the JS modules - so a
// changed deploy forces a re-fetch of the whole module graph. External (gstatic/fonts)
// URLs are left alone.
//
// Idempotent: the version is a hash of the code with existing ?v= stripped, so running it
// on unchanged code produces no diff.
//
//   node scripts/stamp_assets.mjs      (or: npm run stamp)
// Run it before committing a frontend change.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HTML = ['index.html', 'admin.html', 'connect.html'];
const JS = ['app.js', 'admin.js', 'connect.js', 'washstore.js', 'firestore-rest.js', 'site-config.js', 'lib/ids.js', 'lib/trace.js'];
const HASH_FILES = [...HTML, ...JS, 'config.js', 'styles.css'];

// Remove existing ?v= from local refs/imports so the hash is stable across runs.
function stripV(s) {
  return s
    .replace(/(from\s*['"]\.\/[^'"?]+\.js)\?v=[^'"]*(['"])/g, '$1$2')
    .replace(/((?:href|src)="(?!https?:)[^"?]+\.(?:js|css))\?v=[^"]*(")/g, '$1$2');
}

// Version: ASSET_VERSION env when set (CI passes the deploy timestamp), else a short
// hash of the cleaned content of every served file (stable for local/manual runs).
function contentHash() {
  const h = createHash('sha256');
  for (const f of [...HASH_FILES].sort()) {
    h.update(f + '\0');
    h.update(stripV(readFileSync(join(ROOT, f), 'utf8')));
  }
  return h.digest('hex').slice(0, 8);
}
const V = (process.env.ASSET_VERSION || '').replace(/[^A-Za-z0-9._-]/g, '') || contentHash();

function stampImports(s) {
  return s.replace(/(from\s*['"]\.\/[^'"?]+\.js)(['"])/g, `$1?v=${V}$2`);
}
function stampTags(s) {
  return s.replace(/((?:href|src)="(?!https?:)[^"?]+\.(?:js|css))(")/g, `$1?v=${V}$2`);
}

for (const f of JS) {
  const p = join(ROOT, f);
  writeFileSync(p, stampImports(stripV(readFileSync(p, 'utf8'))));
}
for (const f of HTML) {
  const p = join(ROOT, f);
  writeFileSync(p, stampTags(stampImports(stripV(readFileSync(p, 'utf8')))));
}

console.log(`Stamped ${JS.length + HTML.length} files with ?v=${V}`);
