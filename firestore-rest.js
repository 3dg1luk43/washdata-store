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
// Firestore REST read layer. Public (approved) reads need no auth token and go over a
// single plain fetch each - no WebChannel, no long-poll handshake, far faster than the
// SDK for a read-mostly catalog. Writes and auth still use the Firebase SDK.
import firebaseConfig from './config.js';

const PID = firebaseConfig.projectId;
const BASE = `https://firestore.googleapis.com/v1/projects/${PID}/databases/(default)/documents`;

// Optional auth-token provider (set by washstore init). Public reads pass no token;
// admin/owner reads pass { auth: true } to attach the signed-in user's ID token so the
// rules grant access to non-public (pending/rejected/all) documents.
let _getToken = null;
export function setTokenProvider(fn) { _getToken = fn; }

async function authHeaders(auth) {
  if (!auth || !_getToken) return {};
  try {
    const t = await _getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch (_) {
    return {};
  }
}

// --- typed value encode/decode ---
function encodeValue(v) {
  if (v == null) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (v && v._ts) return { timestampValue: v._ts };
  return { stringValue: String(v) };
}

function decodeValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) {
    const iso = v.timestampValue;
    return { _ts: iso, toMillis: () => Date.parse(iso), toDate: () => new Date(iso) };
  }
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
  // Path of the doc relative to the database root (e.g. "devices/x/reports/uid"). Lets
  // callers derive a doc's true location instead of trusting denormalized path fields.
  const parts = doc.name.split('/documents/');
  o._path = parts.length > 1 ? parts[1] : null;
  return o;
}

// --- queries ---
// opts: { filters, orderBy:[{field,dir}], limit, startAfter:[values], parent }
// parent (e.g. "cycles/abc") scopes the query to a subcollection.
export async function restQuery(collectionId, opts = {}) {
  const { filters = [], orderBy = [], limit, startAfter, parent, allDescendants = false } = opts;
  // allDescendants=true turns this into a collection-group query (every subcollection with
  // this id at any depth). Collection-group queries always run from the database root, so
  // `parent` is ignored in that mode.
  const sq = { from: [{ collectionId, ...(allDescendants ? { allDescendants: true } : {}) }] };
  const ff = filters.map((f) => ({ fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: encodeValue(f.value) } }));
  if (ff.length === 1) sq.where = ff[0];
  else if (ff.length > 1) sq.where = { compositeFilter: { op: 'AND', filters: ff } };
  if (orderBy.length) sq.orderBy = orderBy.map((o) => ({ field: { fieldPath: o.field }, direction: o.dir || 'ASCENDING' }));
  if (limit) sq.limit = limit;
  if (Array.isArray(startAfter) && startAfter.length) {
    sq.startAt = { values: startAfter.map(encodeValue), before: false };
  }
  const url = parent ? `${BASE}/${parent}:runQuery` : `${BASE}:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders(opts.auth)) },
    body: JSON.stringify({ structuredQuery: sq }),
  });
  if (!res.ok) throw new Error(await restError(res));
  const rows = await res.json();
  return rows.filter((r) => r.document).map((r) => decodeDoc(r.document));
}

export async function restGet(path, opts = {}) {
  const res = await fetch(`${BASE}/${path}`, {
    headers: await authHeaders(opts.auth),
    cache: opts.noStore ? 'no-store' : 'default',
  });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(await restError(res));
  return decodeDoc(await res.json());
}

// count() aggregation over a collection with optional equality filters. Pass
// opts.allDescendants=true to count across a collection group (all subcollections with
// this id at any depth).
export async function restCount(collectionId, filters = [], opts = {}) {
  const sq = { from: [{ collectionId, ...(opts.allDescendants ? { allDescendants: true } : {}) }] };
  const ff = filters.map((f) => ({ fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: encodeValue(f.value) } }));
  if (ff.length === 1) sq.where = ff[0];
  else if (ff.length > 1) sq.where = { compositeFilter: { op: 'AND', filters: ff } };
  const body = { structuredAggregationQuery: { structuredQuery: sq, aggregations: [{ alias: 'cnt', count: {} }] } };
  const res = await fetch(`${BASE}:runAggregationQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders(opts.auth)) },
    body: JSON.stringify(body),
  });
  if (!res.ok) return 0;
  const rows = await res.json();
  const r = rows.find((x) => x.result);
  return r && r.result.aggregateFields.cnt ? decodeValue(r.result.aggregateFields.cnt) : 0;
}

// avg + count over a `ratings` subcollection under `parentPath` (one request).
async function _ratingAgg(parentPath) {
  const body = {
    structuredAggregationQuery: {
      structuredQuery: { from: [{ collectionId: 'ratings' }] },
      aggregations: [
        { alias: 'cnt', count: {} },
        // NB: the Firestore aggregation operator is `avg`, NOT `average` — using the
        // wrong name makes the whole runAggregationQuery 400, silently zeroing ratings.
        { alias: 'avg', avg: { field: { fieldPath: 'rating' } } },
      ],
    },
  };
  const res = await fetch(`${BASE}/${parentPath}:runAggregationQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { avg: null, count: 0 };
  const rows = await res.json();
  const agg = rows.find((r) => r.result) ? rows.find((r) => r.result).result.aggregateFields : null;
  if (!agg) return { avg: null, count: 0 };
  const cnt = agg.cnt ? decodeValue(agg.cnt) : 0;
  const avg = agg.avg && !('nullValue' in agg.avg) ? decodeValue(agg.avg) : null;
  return { avg: cnt > 0 && avg != null ? avg : null, count: cnt || 0 };
}

// avg + count over a cycle's ratings subcollection.
export async function restRatingSummary(cycleId) { return _ratingAgg(`cycles/${cycleId}`); }

// avg + count over a device's quality-ratings subcollection.
export async function restDeviceRating(deviceId) { return _ratingAgg(`devices/${deviceId}`); }

async function restError(res) {
  try {
    const j = await res.json();
    if (j && j.error && j.error.message) {
      // Surface the classic messages so the app can show them meaningfully.
      return j.error.message;
    }
  } catch (_) {}
  return `Request failed (${res.status})`;
}
