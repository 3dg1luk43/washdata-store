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
// In-memory Firestore double, just wide enough for the admin merge / rename / move paths in
// washstore.js. It exists so those functions can be executed for real (via the loader in
// washstore_loader.mjs) instead of being re-implemented in a test, which is the only way a
// test can catch a counter that drifts or a child left pointing at a deleted parent.
//
// Deliberately STRICTER than the real SDK in two places, because both are mistakes the
// production code takes pains to avoid and a test should refuse to let back in:
//   - writing the same document twice inside one batch throws;
//   - a batch over 500 writes throws (the real cap).
// `update` on a missing document throws, as Firestore does.

const store = new Map();           // 'devices/abc' -> plain object
let writeLog = [];

export function reset() { store.clear(); writeLog = []; }
export function seed(path, data) { store.set(path, { ...data }); }
export function raw(path) { const v = store.get(path); return v ? { ...v } : null; }
export function paths(prefix = '') {
  return [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
}
export function writes() { return writeLog.slice(); }

// Docs directly inside `collPath` (no deeper nesting).
function childDocs(collPath) {
  const out = [];
  for (const [k, v] of store) {
    if (!k.startsWith(`${collPath}/`)) continue;
    if (k.slice(collPath.length + 1).includes('/')) continue;
    out.push({ path: k, id: k.slice(collPath.length + 1), data: v });
  }
  return out;
}

const INCREMENT = Symbol('increment');
const SERVER_TS = Symbol('serverTimestamp');

export function increment(n) { return { [INCREMENT]: n }; }
export function serverTimestamp() { return { [SERVER_TS]: true }; }

function resolveValue(prev, next) {
  if (next && typeof next === 'object' && INCREMENT in next) return (prev || 0) + next[INCREMENT];
  if (next && typeof next === 'object' && SERVER_TS in next) return '<server-timestamp>';
  return next;
}

function applyUpdate(path, data) {
  const cur = store.get(path);
  if (!cur) throw new Error(`No document to update: ${path}`);
  const out = { ...cur };
  for (const [k, v] of Object.entries(data)) out[k] = resolveValue(cur[k], v);
  store.set(path, out);
  writeLog.push({ op: 'update', path });
}

function applySet(path, data) {
  const cur = store.get(path) || {};
  const out = {};
  for (const [k, v] of Object.entries(data)) out[k] = resolveValue(cur[k], v);
  store.set(path, out);
  writeLog.push({ op: 'set', path });
}

function applyDelete(path) {
  store.delete(path);
  writeLog.push({ op: 'delete', path });
}

// ---- refs -------------------------------------------------------------------
export function doc(_db, ...segs) {
  const path = segs.join('/').replace(/\/+/g, '/');
  if (path.split('/').length % 2 !== 0) throw new Error(`Not a document path: ${path}`);
  return { __doc: true, path, id: path.split('/').pop() };
}

export function collection(_db, ...segs) {
  const path = segs.join('/').replace(/\/+/g, '/');
  if (path.split('/').length % 2 !== 1) throw new Error(`Not a collection path: ${path}`);
  return { __coll: true, path };
}

export function where(field, op, value) { return { field, op, value }; }
export function orderBy(field, dir) { return { __orderBy: field, dir }; }
export function limit(n) { return { __limit: n }; }
export function startAfter(...v) { return { __startAfter: v }; }

export function query(coll, ...clauses) {
  return { __query: true, path: coll.path, clauses: clauses.filter((c) => c && c.field) };
}

function matches(data, clause) {
  const v = data[clause.field];
  if (clause.op === '==') return v === clause.value;
  if (clause.op === 'array-contains') return Array.isArray(v) && v.includes(clause.value);
  throw new Error(`Unsupported operator in fake: ${clause.op}`);
}

function snapFor(entry) {
  return {
    id: entry.id,
    ref: { __doc: true, path: entry.path, id: entry.id },
    exists: () => true,
    data: () => ({ ...entry.data }),
  };
}

export async function getDoc(ref) {
  const data = store.get(ref.path);
  return {
    id: ref.id,
    ref,
    exists: () => data !== undefined,
    data: () => (data === undefined ? undefined : { ...data }),
  };
}

export async function getDocs(target) {
  const entries = childDocs(target.path).filter(
    (e) => (target.clauses || []).every((c) => matches(e.data, c)));
  return { docs: entries.map(snapFor), size: entries.length, empty: entries.length === 0 };
}

export async function setDoc(ref, data) { applySet(ref.path, data); }
export async function updateDoc(ref, data) { applyUpdate(ref.path, data); }
export async function deleteDoc(ref) { applyDelete(ref.path); }
export async function addDoc(coll, data) {
  const id = `auto-${Math.random().toString(36).slice(2, 10)}`;
  applySet(`${coll.path}/${id}`, data);
  return { id, path: `${coll.path}/${id}` };
}

export function writeBatch() {
  const ops = [];
  const seen = new Set();
  const push = (op, ref, data) => {
    if (seen.has(ref.path)) {
      throw new Error(`Batch writes the same document twice: ${ref.path}`);
    }
    seen.add(ref.path);
    ops.push({ op, ref, data });
    if (ops.length > 500) throw new Error('Batch exceeds the 500-write limit');
  };
  return {
    set: (ref, data) => push('set', ref, data),
    update: (ref, data) => push('update', ref, data),
    delete: (ref) => push('delete', ref),
    commit: async () => {
      // Firestore batches are atomic: validate every op before any of them lands.
      for (const { op, ref } of ops) {
        if (op === 'update' && !store.has(ref.path)) {
          throw new Error(`No document to update: ${ref.path}`);
        }
      }
      for (const { op, ref, data } of ops) {
        if (op === 'set') applySet(ref.path, data);
        else if (op === 'update') applyUpdate(ref.path, data);
        else applyDelete(ref.path);
      }
    },
  };
}

export function onSnapshot() { return () => {}; }

// ---- app / auth stubs -------------------------------------------------------
export function initializeApp() { return { __app: true }; }
export function getFirestore() { return { __db: true }; }
export function getAuth() { return { currentUser: { uid: 'admin-uid' } }; }
export function onAuthStateChanged() { return () => {}; }
export function signInWithPopup() { throw new Error('not used in tests'); }
export function signOut() { throw new Error('not used in tests'); }
export function GithubAuthProvider() {}
export function getAdditionalUserInfo() { return null; }

// ---- REST layer (firestore-rest.js) backed by the same store ----------------
export function setTokenProvider() {}
export async function restGet(path) {
  const d = store.get(path);
  return d ? { ...d, id: path.split('/').pop() } : null;
}
// Mirrors firestore-rest.js: `collectionId` is a bare collection id, scoped by `parent`
// (a document path) or, with allDescendants, matched at ANY depth from the root.
export async function restQuery(collectionId, { filters = [], parent, allDescendants = false } = {}) {
  const OPS = { EQUAL: '==', ARRAY_CONTAINS: 'array-contains' };
  let entries;
  if (allDescendants) {
    entries = [];
    for (const [k, v] of store) {
      const segs = k.split('/');
      if (segs.length % 2 !== 0) continue;
      if (segs[segs.length - 2] === collectionId) entries.push({ path: k, id: segs[segs.length - 1], data: v });
    }
  } else {
    entries = childDocs(parent ? `${parent}/${collectionId}` : collectionId);
  }
  return entries
    .filter((e) => filters.every((f) => matches(e.data, { field: f.field, op: OPS[f.op] || '==', value: f.value })))
    .map((e) => ({ ...e.data, id: e.id, _path: e.path }));
}
export async function restCount() { return 0; }
export async function restRatingSummary() { return { avg: null, count: 0 }; }
export async function restDeviceRating() { return { avg: null, count: 0 }; }
