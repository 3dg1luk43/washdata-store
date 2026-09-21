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
// Builds search-index.json: a compact, self-describing snapshot of the public catalog,
// committed to the repo and published with the site.
//
// WHY A STATIC FILE. Firestore has no full-text index, so a live search can only do prefix
// ranges - "wm14" never finds "iQ300 WM14N292". The whole catalog is small enough to ship as
// one file, which the browser searches with real substring/multi-token matching for ZERO
// Firestore reads. That matters because the store runs on the Spark free tier (50k reads/day)
// and the catalog browse already spends most of it.
//
// FRESHNESS is NOT this script's job. The file records `generatedAt`; the client fetches
// everything created after that timestamp as a small live delta and merges it into the same
// matcher, so a contribution is searchable immediately no matter when the last rebuild ran.
// The rebuild cadence only decides how big that delta is. The one gap is REMOVALS: a
// rejected or merged-away entry can linger here until the next rebuild, and resolves to a
// clean "not found" when opened.
//
// Reads are public (the rules allow approved+pending), so this needs NO credentials.
// Cost: one pass over the catalog, currently ~2.4k document reads.
//
//   node scripts/build_search_index.mjs [--out search-index.json] [--project washdata-store]

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUT = argOf('out', 'search-index.json');
const PROJECT = argOf('project', 'washdata-store');
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const PAGE = 300;                         // documents per request
const STATUSES = ['approved', 'pending']; // what the rules expose publicly

// Output schema. Rows are positional arrays, not objects: the field names would otherwise be
// repeated on every one of ~2.4k rows and triple the file. `fields` ships inside the file so
// the client reads the column order from the data instead of hardcoding a duplicate of it.
const SCHEMA = 1;
//
// The column lists are exactly what the existing card renderers read. Two of them are not
// cosmetic and must not be trimmed to save bytes:
//   - ratingSum/ratingCount: absent, resolveDeviceQuality() falls back to a LIVE per-card
//     rating aggregation, so a 20-result search would cost 20 reads and defeat the point.
//   - createdByUid/uploaderUid: what hides the Report button on your own content.
const FIELDS = {
  brands: ['id', 'brand', 'deviceCount', 'cycleCount', 'approvedDeviceCount', 'createdByUid', 'status'],
  devices: [
    'id', 'brand', 'model', 'applianceType', 'profileCount', 'cycleCount', 'favoriteCount',
    'confirmCount', 'ratingSum', 'ratingCount', 'createdByName', 'createdByUid', 'ownerId',
    'manualUrl', 'status',
  ],
  profiles: ['id', 'program', 'deviceId', 'cycleCount', 'createdByUid', 'status'],
};
// Reference cycles are deliberately NOT in here; the client searches them with a live prefix
// query instead. Measured: they were 64 KB of a 127 KB gzipped index, and 32 KB of that was
// the incompressible SHA-256 document ids. For that price they add no matchable text at all
// -- a cycle's only text is its program name, which its profile row already carries -- and
// leaving them out halves the payload and cuts the rebuild from 2,433 reads to 1,580.

function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) {
    const o = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) o[k] = decodeValue(val);
    return o;
  }
  return null;
}

function decodeDoc(doc) {
  const o = {};
  for (const [k, v] of Object.entries(doc.fields || {})) o[k] = decodeValue(v);
  o.id = doc.name.split('/').pop();
  return o;
}

// One page of a collection, ordered by document id so the cursor is unique and the output is
// deterministic (an unchanged catalog must produce a byte-identical file, or the workflow
// would commit noise every day).
async function fetchPage(collectionId, select, afterId) {
  const sq = {
    from: [{ collectionId }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'status' },
        op: 'IN',
        value: { arrayValue: { values: STATUSES.map((s) => ({ stringValue: s })) } },
      },
    },
    orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    limit: PAGE,
  };
  if (select) sq.select = { fields: select.map((f) => ({ fieldPath: f })) };
  if (afterId) {
    sq.startAt = {
      values: [{ referenceValue: `projects/${PROJECT}/databases/(default)/documents/${collectionId}/${afterId}` }],
      before: false,
    };
  }
  const res = await fetch(`${BASE}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: sq }),
  });
  if (!res.ok) throw new Error(`${collectionId}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).filter((r) => r.document).map((r) => decodeDoc(r.document));
}

async function fetchAll(collectionId, select) {
  const out = [];
  let after = null;
  for (;;) {
    const page = await fetchPage(collectionId, select, after);
    out.push(...page);
    if (page.length < PAGE) break;
    after = page[page.length - 1].id;
  }
  return out;
}

async function main() {
  const startedAt = new Date();
  const [brands, devices, profiles] = await Promise.all([
    fetchAll('brands', ['brand', 'deviceCount', 'cycleCount', 'approvedDeviceCount', 'createdByUid', 'status']),
    fetchAll('devices', [
      'brand', 'model', 'applianceType', 'profileCount', 'cycleCount', 'favoriteCount',
      'confirmCount', 'ratingSum', 'ratingCount', 'createdByName', 'createdByUid', 'ownerId',
      'manualUrl', 'status',
    ]),
    fetchAll('profiles', ['program', 'deviceId', 'cycleCount', 'createdByUid', 'status']),
  ]);

  const index = {
    schema: SCHEMA,
    // Stamped BEFORE the reads, never after: the client asks for everything created after
    // this instant, so a timestamp taken at the end would open a window in which a
    // contribution is neither in the index nor in the delta.
    generatedAt: startedAt.toISOString(),
    counts: { brands: brands.length, devices: devices.length, profiles: profiles.length },
    fields: FIELDS,
    brands: brands.map((b) => [
      b.id, b.brand || b.id, b.deviceCount || 0, b.cycleCount || 0,
      b.approvedDeviceCount || 0, b.createdByUid || null, b.status,
    ]),
    devices: devices.map((d) => [
      d.id, d.brand || '', d.model || '', d.applianceType || '',
      d.profileCount || 0, d.cycleCount || 0, d.favoriteCount || 0, d.confirmCount || 0,
      d.ratingSum || 0, d.ratingCount || 0, d.createdByName || null, d.createdByUid || null,
      d.ownerId || null, d.manualUrl || null, d.status,
    ]),
    profiles: profiles.map((p) => [
      p.id, p.program || '', p.deviceId || '', p.cycleCount || 0, p.createdByUid || null, p.status,
    ]),
  };

  const json = JSON.stringify(index);
  const prev = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  // Compare with generatedAt masked out, so an unchanged catalog is a no-op commit.
  const strip = (s) => s.replace(/"generatedAt":"[^"]*"/, '"generatedAt":""');
  const changed = !prev || strip(prev) !== strip(json);
  if (changed) writeFileSync(OUT, json + '\n');

  const kb = (json.length / 1024).toFixed(1);
  const total = brands.length + devices.length + profiles.length;
  console.log(`${changed ? 'wrote' : 'unchanged'} ${OUT}  ${kb} KB  ${total} rows ` +
    `(brands ${brands.length}, devices ${devices.length}, profiles ${profiles.length})`);
  console.log(`document reads: ~${total}`);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `changed=${changed ? 'true' : 'false'}\n`, { flag: 'a' });
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
