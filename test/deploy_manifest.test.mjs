// WashData Store - community library for WashData appliance power-cycle profiles.
// Copyright (C) 2026 Lukas Bandura
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// The site has no bundler, so what gets published is a hand-written allowlist in
// .github/workflows/deploy.yml, and what gets cache-busted is a second hand-written list in
// scripts/stamp_assets.mjs. Adding a module and forgetting either list is silent locally
// (the dev server serves the whole repo) and fatal in production: the import 404s, the ES
// module graph fails, and every page importing it renders blank. That is exactly what
// happened when lib/merge_guard.js was added.
//
// This test walks the real module graph from the HTML entry points and holds both lists to
// it, so the next added module cannot ship half-deployed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

// ---- what deploy.yml publishes ----------------------------------------------
// Each `cp <files...> <dest>` line in the assemble step maps sources to a dist/ directory.
function publishedFiles() {
  const yml = read('.github/workflows/deploy.yml');
  const step = yml.slice(yml.indexOf('Assemble the static site'));
  const body = step.slice(0, step.indexOf('\n      - '));
  // Join backslash continuations, then pull out every cp invocation.
  const flat = body.replace(/\\\n\s*/g, ' ');
  const out = new Set();
  for (const m of flat.matchAll(/\bcp\s+([^\n]+?)\s+(dist\/\S*)/g)) {
    for (const src of m[1].trim().split(/\s+/)) {
      if (src.startsWith('-')) continue;
      out.add(normalize(src));
    }
  }
  return out;
}

// ---- what stamp_assets.mjs cache-busts --------------------------------------
function stampLists() {
  const src = read('scripts/stamp_assets.mjs');
  const grab = (name) => {
    const m = src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
    assert.ok(m, `could not find the ${name} list in scripts/stamp_assets.mjs`);
    return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => normalize(x[1])));
  };
  return { js: grab('JS'), html: grab('HTML') };
}

// ---- the real module graph ---------------------------------------------------
const HTML_ENTRIES = ['index.html', 'admin.html', 'connect.html', 'create.html', 'docs.html', 'changelog.html'];

// Resolve a relative specifier against the importing file, stripping any ?v= cache-buster.
function resolveFrom(fromFile, spec) {
  return normalize(join(dirname(fromFile), spec.split('?')[0]));
}

// Returns { js:Set, css:Set } of every LOCAL asset reachable from the HTML entry points.
function moduleGraph() {
  const js = new Set();
  const css = new Set();
  const queue = [];
  for (const h of HTML_ENTRIES) {
    const src = read(h);
    for (const m of src.matchAll(/(?:src|href)="(?!https?:|\/\/|#|mailto:)([^"]+\.(?:js|css))"/g)) {
      const p = resolveFrom(h, m[1]);
      if (p.endsWith('.css')) css.add(p);
      else if (!js.has(p)) { js.add(p); queue.push(p); }
    }
  }
  while (queue.length) {
    const f = queue.shift();
    if (!existsSync(join(ROOT, f))) continue;   // asserted separately below
    for (const m of read(f).matchAll(/from\s*['"](\.[^'"]+\.js)(?:\?[^'"]*)?['"]/g)) {
      const p = resolveFrom(f, m[1]);
      if (!js.has(p)) { js.add(p); queue.push(p); }
    }
  }
  return { js, css };
}

test('every module reachable from an HTML page actually exists on disk', () => {
  const { js, css } = moduleGraph();
  const missing = [...js, ...css].filter((f) => !existsSync(join(ROOT, f)));
  assert.deepEqual(missing, [], `referenced but absent: ${missing.join(', ')}`);
  // Sanity: the graph must have found the real app, not silently nothing.
  assert.ok(js.has('washstore.js'), 'graph walk did not reach washstore.js');
  assert.ok(js.has(normalize('lib/ids.js')), 'graph walk did not follow into lib/');
});

test('deploy.yml publishes every file the module graph needs', () => {
  const { js, css } = moduleGraph();
  const published = publishedFiles();
  const missing = [...js, ...css, ...HTML_ENTRIES].filter((f) => !published.has(f));
  assert.deepEqual(missing, [],
    'these are imported at runtime but never copied into dist/ by .github/workflows/deploy.yml, '
    + `so they 404 in production: ${missing.join(', ')}`);
});

test('stamp_assets.mjs cache-busts every module in the graph', () => {
  const { js } = moduleGraph();
  const { js: stampJs, html: stampHtml } = stampLists();
  // config.js holds no cache-sensitive logic and is hashed, not stamped; skip it.
  const missing = [...js].filter((f) => f !== 'config.js' && !stampJs.has(f));
  assert.deepEqual(missing, [],
    'these are in the module graph but absent from the JS list in scripts/stamp_assets.mjs, so a '
    + `change to them will not bust browser caches: ${missing.join(', ')}`);
  const missingHtml = HTML_ENTRIES.filter((f) => !stampHtml.has(f));
  assert.deepEqual(missingHtml, [], `HTML pages missing from the stamp list: ${missingHtml.join(', ')}`);
});
