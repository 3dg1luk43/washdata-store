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
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  GithubAuthProvider,
  getAdditionalUserInfo,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  serverTimestamp,
  increment,
  writeBatch,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { deviceId as mkDeviceId, profileId as mkProfileId } from './lib/ids.js';
import { downsampleCycle, parseCycle, cycleStats, packPoints, unpackPoints } from './lib/trace.js';
import { restQuery, restGet, restRatingSummary, restDeviceRating, restCount, setTokenProvider } from './firestore-rest.js';

export { downsampleCycle, parseCycle, cycleStats };

// Convert a stored cycle's trace (array of {o,w} maps) back to [[offset, watts], ...]
// so all display/export code keeps working on pairs. Safe on already-paired data.
function hydrateCycle(rec) {
  if (rec && rec.trace && Array.isArray(rec.trace.points)) {
    rec.trace = { ...rec.trace, points: unpackPoints(rec.trace.points) };
  }
  return rec;
}

export const STORE_SCHEMA_VERSION = 2;
export const CYCLE_SCHEMA_VERSION = 1;

// Client size cap. Firestore hard-caps a document at 1 MiB server-side; this is a
// friendlier client-side gate well below that so uploads fail early with a clear message.
export const MAX_DOC_BYTES = 900 * 1024;

const APPLIANCE_TYPES = ['washer', 'dryer', 'dishwasher', 'washer_dryer'];

// Best-effort in-memory write rate limit. This is NOT a security control (a scripted
// client bypasses it); it stops accidental/casual flooding through the UI. Real
// server-side quota protection is Firebase App Check - see SECURITY.md.
const _WRITE_WINDOW_MS = 60 * 1000;
const _WRITE_MAX_PER_WINDOW = 20;
const _writeTimes = [];
const _bumpedThisSession = new Set();

function _rateGuard() {
  const now = Date.now();
  while (_writeTimes.length && now - _writeTimes[0] > _WRITE_WINDOW_MS) _writeTimes.shift();
  if (_writeTimes.length >= _WRITE_MAX_PER_WINDOW) {
    throw new Error('Too many actions in a short time. Please wait a moment and try again.');
  }
  _writeTimes.push(now);
}

let _app = null;
let _auth = null;
let _db = null;

export function init(config) {
  _app = initializeApp(config);
  _auth = getAuth(_app);
  _db = getFirestore(_app);
  // Let the REST layer attach the signed-in user's ID token on authed (admin/owner) reads.
  setTokenProvider(() => (_auth && _auth.currentUser ? _auth.currentUser.getIdToken() : null));
}

export function onAuth(callback) {
  return onAuthStateChanged(_auth, callback);
}

export async function signIn() {
  const provider = new GithubAuthProvider();
  const result = await signInWithPopup(_auth, provider);
  // getAdditionalUserInfo is only available immediately after signInWithPopup.
  // Firebase Auth's user.displayName is GitHub's "Name" field (often blank);
  // profile.login is the username and is always set — use it as the display fallback.
  // Pass it into ensureUserProfile so it lands in the doc atomically, whether the
  // doc is being created (new user) or updated (returning user). A separate setDoc
  // after the fact would race with onAuth's ensureUserProfile call and silently fail
  // for new users whose doc doesn't exist yet at that point.
  let githubLogin = null;
  try {
    const info = getAdditionalUserInfo(result);
    githubLogin = info?.profile?.login || info?.username || null;
  } catch (_) {}
  try {
    await ensureUserProfile(result.user, githubLogin);
  } catch (e) {
    // Best-effort: a failed profile write must not block an otherwise-successful
    // sign-in (the user doc is not required to contribute), but never swallow it
    // silently -- surface it so a real failure is visible.
    console.warn('WashData store: ensureUserProfile failed', e);
  }
  return result;
}

export async function signOutUser() {
  return signOut(_auth);
}

export function currentUser() {
  return _auth.currentUser;
}

export async function isAdmin() {
  const user = _auth.currentUser;
  if (!user) return false;
  const snap = await getDoc(doc(_db, 'admins', user.uid));
  return snap.exists();
}

const _LASTSEEN_THROTTLE_MS = 6 * 60 * 60 * 1000;

// githubLogin is only available from getAdditionalUserInfo immediately after
// signInWithPopup — pass it here from signIn() so it lands in the doc atomically.
// On page-load auth (onAuth), githubLogin is null and the existing stored value is kept.
export async function ensureUserProfile(user, githubLogin = null) {
  const ref = doc(_db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      uid: user.uid,
      displayName: user.displayName || null,
      photoURL: user.photoURL || null,
      createdAt: serverTimestamp(),
      lastSeen: serverTimestamp(),
      status: 'active',
      favorites: [],
      ...(githubLogin ? { githubLogin } : {}),
    }, { merge: true });
    return;
  }
  const data = snap.data();
  const updates = {};
  // One-time migration: add status field to pre-existing docs
  if (!data.status) updates.status = 'active';
  // Sync displayName if GitHub profile changed
  if (user.displayName && user.displayName !== data.displayName) updates.displayName = user.displayName;
  // Write githubLogin when supplied (sign-in path) and not yet stored
  if (githubLogin && !data.githubLogin) updates.githubLogin = githubLogin;
  // Throttle lastSeen writes so ordinary browsing stays read-only. A write is what
  // opens the persistent Firestore write-channel; skipping it on most page loads keeps
  // a signed-in browser to one-shot read requests.
  const last = data.lastSeen && data.lastSeen.toMillis ? data.lastSeen.toMillis() : 0;
  if (Date.now() - last > _LASTSEEN_THROTTLE_MS) updates.lastSeen = serverTimestamp();
  if (Object.keys(updates).length) await updateDoc(ref, updates);
}

export async function getUserDoc(uid) {
  const snap = await getDoc(doc(_db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

export function subscribeUserStatus(uid, callback) {
  return onSnapshot(doc(_db, 'users', uid), (snap) => {
    if (snap.exists()) callback(snap.data().status, snap.data().banReason);
  });
}

// ------------------------------------------------------------------
// Helpers (downsampleCycle / parseCycle / cycleStats imported from lib/trace.js above)
// ------------------------------------------------------------------

export function saveAsFile(record) {
  const parts = String(record.deviceId || '').split('__');
  const brand = (record.brand_lc || parts[1] || 'unknown').replace(/[^a-z0-9]+/gi, '-');
  const model = (parts[2] || 'unknown').replace(/[^a-z0-9]+/gi, '-');
  const program = (record.program_lc || 'unknown').replace(/[^a-z0-9]+/gi, '-');
  const filename = `${brand}_${model}_${program}.json`;
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function _estimateDocSize(data) {
  return new Blob([JSON.stringify(data)]).size;
}

// ------------------------------------------------------------------
// Devices / profiles
// ------------------------------------------------------------------

export async function ensureBrand({ brand, createdByName = null }) {
  const id = brand.toLowerCase();
  const ref = doc(_db, 'brands', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const user = _auth.currentUser;
    if (!user) throw new Error('Not signed in');
    await setDoc(ref, {
      brand,
      brand_lc: id,
      status: 'pending',
      createdByUid: user.uid,
      createdByName: createdByName || null,
      createdAt: serverTimestamp(),
    });
  }
  return id;
}

export async function ensureDevice({ applianceType, brand, model, manualUrl = null, createdByName = null }) {
  const id = mkDeviceId(applianceType, brand, model);
  const ref = doc(_db, 'devices', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const user = _auth.currentUser;
    if (!user) throw new Error('Not signed in');
    await setDoc(ref, {
      applianceType,
      brand,
      brand_lc: brand.toLowerCase(),
      model,
      model_lc: model.toLowerCase(),
      status: 'pending',
      createdByUid: user.uid,
      createdByName: createdByName || null,
      manualUrl: manualUrl || null,
      createdAt: serverTimestamp(),
      favoriteCount: 0,
      confirmCount: 0,
    });
  }
  return id;
}

// ------------------------------------------------------------------
// Community catalog: contribute / confirm / rate (device-level)
// ------------------------------------------------------------------

const APPLIANCE_LABELS = { washer: 'Washer', dryer: 'Dryer', dishwasher: 'Dishwasher', washer_dryer: 'Washer dryer' };
export function applianceLabel(t) { return APPLIANCE_LABELS[t] || t; }

let _confirmThresholdCache = null;
export async function confirmThresholdValue() {
  if (_confirmThresholdCache != null) return _confirmThresholdCache;
  const cfg = await getSiteConfig();
  const v = Number(cfg.confirmThreshold);
  _confirmThresholdCache = Number.isFinite(v) && v > 0 ? v : 5;
  return _confirmThresholdCache;
}

// Create a pending brand entry with optional public attribution.
export async function createBrand({ brand, showName = false }) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  if (typeof brand !== 'string' || brand.length < 1 || brand.length > 40) throw new Error('Brand must be 1-40 characters');
  _rateGuard();
  return ensureBrand({ brand: brand.trim(), createdByName: showName ? (user.displayName || null) : null });
}

// Create a pending device (appliance) entry. Lazily ensures the brand exists.
export async function createDevice({ applianceType, brand, model, manualUrl = null, showName = false }) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  if (!APPLIANCE_TYPES.includes(applianceType)) throw new Error('Invalid appliance type');
  if (typeof brand !== 'string' || brand.length < 1 || brand.length > 40) throw new Error('Brand must be 1-40 characters');
  if (typeof model !== 'string' || model.length < 1 || model.length > 60) throw new Error('Model must be 1-60 characters');
  const url = (manualUrl || '').trim();
  if (url && (url.length > 500 || !/^https?:\/\//i.test(url))) throw new Error('Manual URL must start with http(s):// and be under 500 characters');
  _rateGuard();
  const name = showName ? (user.displayName || null) : null;
  await ensureBrand({ brand: brand.trim(), createdByName: name });
  const devId = await ensureDevice({
    applianceType, brand: brand.trim(), model: model.trim(), manualUrl: url || null, createdByName: name,
  });
  return devId;
}

export async function hasConfirmedDevice(deviceId) {
  const user = _auth.currentUser;
  if (!user) return false;
  const rec = await restGet(`devices/${deviceId}/confirmations/${user.uid}`);
  return !!rec;
}

// Confirm a device is a real/correct entry. One confirmation per user (uid-keyed doc);
// crossing the admin-tunable threshold auto-promotes the device to approved.
export async function confirmDevice(deviceId) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  _rateGuard();
  const confRef = doc(_db, 'devices', deviceId, 'confirmations', user.uid);
  const dev0 = await restGet(`devices/${deviceId}`);
  if (!(await getDoc(confRef)).exists()) {
    const batch = writeBatch(_db);
    batch.set(confRef, { uid: user.uid, createdAt: serverTimestamp() });
    batch.update(doc(_db, 'devices', deviceId), { confirmCount: increment(1) });
    await batch.commit();
  }
  // Re-read the honest count and best-effort promote (the rule is the real guard).
  const dev = await restGet(`devices/${deviceId}`);
  const count = (dev && dev.confirmCount) || 0;
  let status = dev ? dev.status : (dev0 && dev0.status);
  const threshold = await confirmThresholdValue();
  if (status === 'pending' && count >= threshold) {
    try { await updateDoc(doc(_db, 'devices', deviceId), { status: 'approved' }); status = 'approved'; }
    catch (_) { /* race or rule mismatch: leave pending, ignore */ }
  }
  return { confirmed: true, confirmCount: count, status };
}

export async function hasConfirmedCycle(cycleId) {
  const user = _auth.currentUser;
  if (!user) return false;
  const rec = await restGet(`cycles/${cycleId}/confirmations/${user.uid}`);
  return !!rec;
}

// Confirm a reference cycle (one per user); crossing the threshold auto-approves it.
// Same voting model as devices - no admin review.
export async function confirmCycle(cycleId) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  _rateGuard();
  const confRef = doc(_db, 'cycles', cycleId, 'confirmations', user.uid);
  const cyc0 = await restGet(`cycles/${cycleId}`);
  if (!(await getDoc(confRef)).exists()) {
    const batch = writeBatch(_db);
    batch.set(confRef, { uid: user.uid, createdAt: serverTimestamp() });
    batch.update(doc(_db, 'cycles', cycleId), { confirmCount: increment(1) });
    await batch.commit();
  }
  const cyc = await restGet(`cycles/${cycleId}`);
  const count = (cyc && cyc.confirmCount) || 0;
  let status = cyc ? cyc.status : (cyc0 && cyc0.status);
  const threshold = await confirmThresholdValue();
  if (status === 'pending' && count >= threshold) {
    try { await updateDoc(doc(_db, 'cycles', cycleId), { status: 'approved' }); status = 'approved'; }
    catch (_) { /* rule guards it; ignore */ }
  }
  return { confirmed: true, confirmCount: count, status };
}

// Optional 5-star quality score (info only). One per user, editable.
export async function rateDevice(deviceId, rating) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  if (![1, 2, 3, 4, 5].includes(rating)) throw new Error('Rating must be 1-5');
  _rateGuard();
  await setDoc(doc(_db, 'devices', deviceId, 'ratings', user.uid), {
    uid: user.uid, rating, updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function getUserDeviceRating(deviceId) {
  const user = _auth.currentUser;
  if (!user) return null;
  const rec = await restGet(`devices/${deviceId}/ratings/${user.uid}`);
  return rec ? rec.rating : null;
}

export async function getDeviceQuality(deviceId) {
  return restDeviceRating(deviceId);
}

export async function ensureProfile({ deviceId, program, description = '' }) {
  const id = mkProfileId(deviceId, program);
  const ref = doc(_db, 'profiles', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const user = _auth.currentUser;
    if (!user) throw new Error('Not signed in');
    await setDoc(ref, {
      deviceId,
      applianceType: deviceId.split('__')[0],
      program,
      program_lc: program.toLowerCase(),
      description,
      status: 'pending',
      createdByUid: user.uid,
      createdAt: serverTimestamp(),
    });
    // Counts (profiles per device, cycles per profile) are CALCULATED on read via
    // countVisibleProfiles/countVisibleCycles -- never a stored running total, which
    // silently drifted to 0 when a best-effort increment was denied by rules.
  }
  return id;
}

export async function getDevice(id) {
  const rec = await restGet(`devices/${id}`);
  if (!rec) throw new Error('Device not found');
  return rec;
}

function _brandFilters(status, search) {
  const filters = [{ field: 'status', op: 'EQUAL', value: status }];
  if (search) {
    const p = search.toLowerCase();
    filters.push({ field: 'brand_lc', op: 'GREATER_THAN_OR_EQUAL', value: p });
    filters.push({ field: 'brand_lc', op: 'LESS_THAN_OR_EQUAL', value: p + '\uf8ff' });
  }
  return filters;
}

// List brands, optional case-insensitive prefix search on brand_lc. REST read.
// includePending merges approved + pending (the catalog is community-visible-with-a-tag).
export async function listBrands({ search = null, pageSize = 60, cursor = null, includePending = false } = {}) {
  if (includePending) {
    const [a, p] = await Promise.all([
      restQuery('brands', { filters: _brandFilters('approved', search), orderBy: [{ field: 'brand_lc', dir: 'ASCENDING' }], limit: pageSize }),
      restQuery('brands', { filters: _brandFilters('pending', search), orderBy: [{ field: 'brand_lc', dir: 'ASCENDING' }], limit: pageSize }),
    ]);
    const byId = new Map();
    for (const b of [...a, ...p]) byId.set(b.id, b);
    const items = [...byId.values()].sort((x, y) => (x.brand_lc || '').localeCompare(y.brand_lc || '')).slice(0, pageSize);
    return { items, cursor: null };
  }
  const items = await restQuery('brands', {
    filters: _brandFilters('approved', search),
    orderBy: [{ field: 'brand_lc', dir: 'ASCENDING' }],
    limit: pageSize,
    startAfter: cursor ? [cursor] : null,
  });
  const next = items.length === pageSize ? items[items.length - 1].brand_lc : null;
  return { items, cursor: next };
}

// Devices for a brand (used by brand -> devices browse and by upload autocomplete).
export async function getDevicesByBrand(brandLc, { applianceType = null, pageSize = 60, includePending = false } = {}) {
  return searchDevices({ brand: brandLc, applianceType, pageSize, includePending });
}

function _deviceFilters(status, applianceType, brand) {
  const filters = [{ field: 'status', op: 'EQUAL', value: status }];
  if (applianceType) filters.push({ field: 'applianceType', op: 'EQUAL', value: applianceType });
  if (brand) filters.push({ field: 'brand_lc', op: 'EQUAL', value: brand.toLowerCase() });
  return filters;
}

export async function searchDevices({ applianceType = null, brand = null, favoritesOnly = false, pageSize = 60, includePending = false } = {}) {
  if (favoritesOnly) {
    const favs = await getFavorites();
    const items = [];
    for (const id of favs.slice(0, pageSize)) {
      const rec = await restGet(`devices/${id}`);
      if (rec) items.push(rec);
    }
    return { items, cursor: null };
  }
  const q = (status) => restQuery('devices', {
    filters: _deviceFilters(status, applianceType, brand),
    orderBy: [{ field: 'favoriteCount', dir: 'DESCENDING' }],
    limit: pageSize,
  });
  if (includePending) {
    const [a, p] = await Promise.all([q('approved'), q('pending')]);
    const byId = new Map();
    // Approved first, then pending, so approved wins on id collisions.
    for (const d of [...a, ...p]) if (!byId.has(d.id)) byId.set(d.id, d);
    return { items: [...byId.values()].slice(0, pageSize), cursor: null };
  }
  return { items: await q('approved'), cursor: null };
}

// Profiles for a device. includePending merges approved + pending (shown with a tag),
// mirroring the brand/device catalog visibility.
export async function getProfiles(deviceId, { includePending = false } = {}) {
  const q = (status) => restQuery('profiles', {
    filters: [
      { field: 'deviceId', op: 'EQUAL', value: deviceId },
      { field: 'status', op: 'EQUAL', value: status },
    ],
    orderBy: [{ field: 'createdAt', dir: 'DESCENDING' }],
    limit: 100,
  });
  if (!includePending) return q('approved');
  const [a, p] = await Promise.all([q('approved'), q('pending')]);
  const byId = new Map();
  for (const x of [...a, ...p]) if (!byId.has(x.id)) byId.set(x.id, x);
  return [...byId.values()];
}

// Create a pending profile (program) under a device. Rules force status:pending.
export async function createProfile({ deviceId, program, description = '' }) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  if (!deviceId) throw new Error('Missing device');
  if (typeof program !== 'string' || program.trim().length < 1 || program.length > 60) {
    throw new Error('Profile name must be 1-60 characters');
  }
  _rateGuard();
  return ensureProfile({ deviceId, program: program.trim(), description });
}

export async function favoriteDevice(id, on) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const ref = doc(_db, 'users', user.uid);
  const snap = await getDoc(ref);
  const favs = new Set((snap.exists() && snap.data().favorites) || []);
  const already = favs.has(id);
  // No-op if the requested state already holds, so the device counter is not double-moved.
  if (on === already) return;
  if (on) favs.add(id); else favs.delete(id);
  const batch = writeBatch(_db);
  batch.update(ref, { favorites: [...favs] });
  batch.update(doc(_db, 'devices', id), { favoriteCount: increment(on ? 1 : -1) });
  await batch.commit();
}

export async function getFavorites() {
  const user = _auth.currentUser;
  if (!user) return [];
  const s = await getDoc(doc(_db, 'users', user.uid));
  return (s.exists() && s.data().favorites) || [];
}

// ------------------------------------------------------------------
// Site config (maintenance flag)
// ------------------------------------------------------------------

// Public read via REST. Returns {} when unset/unavailable. Never cached, so the
// maintenance flag is always current (a stale cache must not keep the site hidden/open).
export async function getSiteConfig() {
  try {
    return (await restGet('config/site', { noStore: true })) || {};
  } catch (_) {
    return {};
  }
}

// Admin-only write (enforced by rules).
export async function setMaintenance(on) {
  await setDoc(doc(_db, 'config', 'site'), { maintenance: !!on, updatedAt: serverTimestamp() }, { merge: true });
}

// Admin-only: set the community auto-approve threshold (confirmations needed).
export async function setConfirmThreshold(n) {
  const v = Math.max(1, Math.round(Number(n) || 5));
  await setDoc(doc(_db, 'config', 'site'), { confirmThreshold: v, updatedAt: serverTimestamp() }, { merge: true });
  _confirmThresholdCache = v;
  return v;
}

// ------------------------------------------------------------------
// Reference cycles
// ------------------------------------------------------------------

// meta: { applianceType, brand, model, program, sampleIntervalSec, description? }
// tracePoints: [[offset_s, watts], ...]; stats: { duration, energy_wh, peak_w, mean_w, signature? }
// qc: obfuscated provenance code 1-3 (set by the integration; website uploads pass 3).
export async function uploadReferenceCycle(meta, tracePoints, stats, qc = 3) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  _rateGuard();

  const { applianceType, brand, model, program, sampleIntervalSec, description = '' } = meta;
  if (!applianceType || !brand || !model || !program || !sampleIntervalSec) {
    throw new Error('Missing required fields');
  }
  if (!APPLIANCE_TYPES.includes(applianceType)) throw new Error('Invalid applianceType');
  if (typeof brand !== 'string' || brand.length < 1 || brand.length > 40) throw new Error('brand must be 1-40 chars');
  if (typeof model !== 'string' || model.length < 1 || model.length > 60) throw new Error('model must be 1-60 chars');
  if (typeof program !== 'string' || program.length < 1 || program.length > 60) throw new Error('program must be 1-60 chars');
  if (typeof sampleIntervalSec !== 'number' || sampleIntervalSec <= 0 || sampleIntervalSec > 3600) {
    throw new Error('sampleIntervalSec must be a number in (0, 3600]');
  }
  if (!Array.isArray(tracePoints) || tracePoints.length < 2) throw new Error('Trace must have at least 2 points');

  await ensureBrand({ brand });
  const devId = await ensureDevice({ applianceType, brand, model });
  const profId = await ensureProfile({ deviceId: devId, program, description });
  const points = downsampleCycle(tracePoints, 3000);
  const qcCode = (qc >= 1 && qc <= 3) ? qc : 3;

  const docData = {
    profileId: profId,
    deviceId: devId,
    brand_lc: brand.toLowerCase(),
    program_lc: program.toLowerCase(),
    applianceType,
    uploaderUid: user.uid,
    uploaderName: user.displayName || null,
    status: 'pending',
    rejectionReason: null,
    trace: { points: packPoints(points), sampleIntervalSec },
    // Always derive stats from the DOWNSAMPLED points that are actually stored, so the
    // stats can never disagree with the trace (and a caller can't upload fabricated stats).
    stats: cycleStats(points),
    cycleSchemaVersion: CYCLE_SCHEMA_VERSION,
    downloads: 0,
    commentCount: 0,
    confirmCount: 0,
    qc: qcCode,
    createdAt: serverTimestamp(),
  };

  if (_estimateDocSize(docData) > MAX_DOC_BYTES) {
    throw new Error(`Cycle exceeds the ${Math.round(MAX_DOC_BYTES / 1024)}KB size limit. Downsample the trace further.`);
  }

  const ref = await addDoc(collection(_db, 'cycles'), docData);
  return ref.id;
}

// Calculated counts (not stored running totals). Both the approved and the
// still-pending docs are visible in browse, so the honest count sums the two.
// Uses the same (field, status) composite index the browse queries already rely on.
export async function countVisibleCycles(profileId) {
  const [a, p] = await Promise.all([
    restCount('cycles', [{ field: 'profileId', op: 'EQUAL', value: profileId }, { field: 'status', op: 'EQUAL', value: 'approved' }]),
    restCount('cycles', [{ field: 'profileId', op: 'EQUAL', value: profileId }, { field: 'status', op: 'EQUAL', value: 'pending' }]),
  ]);
  return (a || 0) + (p || 0);
}

export async function countVisibleProfiles(deviceId) {
  const [a, p] = await Promise.all([
    restCount('profiles', [{ field: 'deviceId', op: 'EQUAL', value: deviceId }, { field: 'status', op: 'EQUAL', value: 'approved' }]),
    restCount('profiles', [{ field: 'deviceId', op: 'EQUAL', value: deviceId }, { field: 'status', op: 'EQUAL', value: 'pending' }]),
  ]);
  return (a || 0) + (p || 0);
}

export async function getReferenceCycles(profileId, { pageSize = 24, cursor = null, includePending = false } = {}) {
  const fetch = (status) => getDocs(query(collection(_db, 'cycles'),
    where('profileId', '==', profileId), where('status', '==', status),
    orderBy('createdAt', 'desc'), limit(pageSize)));
  if (includePending) {
    const [a, p] = await Promise.all([fetch('approved'), fetch('pending')]);
    const byId = new Map();
    for (const d of [...a.docs, ...p.docs]) if (!byId.has(d.id)) byId.set(d.id, hydrateCycle({ id: d.id, ...d.data() }));
    return { items: [...byId.values()], cursor: null };
  }
  const cons = [
    where('profileId', '==', profileId),
    where('status', '==', 'approved'),
    orderBy('createdAt', 'desc'),
    limit(pageSize),
  ];
  if (cursor) cons.push(startAfter(cursor));
  const snap = await getDocs(query(collection(_db, 'cycles'), ...cons));
  const items = snap.docs.map((d) => hydrateCycle({ id: d.id, ...d.data() }));
  return { items, cursor: snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1] : null };
}

// A signed-in user's own uploaded cycles (any status).
export async function myCycles({ pageSize = 24, cursor = null } = {}) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const cons = [where('uploaderUid', '==', user.uid), orderBy('createdAt', 'desc'), limit(pageSize)];
  if (cursor) cons.push(startAfter(cursor));
  const snap = await getDocs(query(collection(_db, 'cycles'), ...cons));
  const items = snap.docs.map((d) => hydrateCycle({ id: d.id, ...d.data() }));
  return { items, cursor: snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1] : null };
}

export async function getCycle(id) {
  const rec = await restGet(`cycles/${id}`);
  if (!rec) throw new Error('Cycle not found');
  return hydrateCycle(rec);
}

export async function deleteCycle(id) {
  await deleteDoc(doc(_db, 'cycles', id));
}

export async function updateProfilePhases(profileId, phases) {
  _rateGuard();
  await updateDoc(doc(_db, 'profiles', profileId), { phases });
}

export async function updateDeviceSettings(deviceId, settings) {
  _rateGuard();
  await updateDoc(doc(_db, 'devices', deviceId), { settings });
}

export async function bumpDownload(id) {
  // Count each cycle at most once per browser session to curb accidental inflation.
  if (_bumpedThisSession.has(id)) return;
  _bumpedThisSession.add(id);
  try {
    await updateDoc(doc(_db, 'cycles', id), { downloads: increment(1) });
  } catch (_) {
    // best-effort
  }
}

// ------------------------------------------------------------------
// Comments (cycles/{id}/comments)
// ------------------------------------------------------------------

export async function addComment(cycleId, text, parentId = null) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  _rateGuard();

  const commentData = {
    authorUid: user.uid,
    authorName: user.displayName || null,
    text,
    createdAt: serverTimestamp(),
  };
  if (parentId != null) commentData.parentId = parentId;

  const batch = writeBatch(_db);
  const commentRef = doc(collection(_db, 'cycles', cycleId, 'comments'));
  batch.set(commentRef, commentData);
  batch.update(doc(_db, 'cycles', cycleId), { commentCount: increment(1) });
  await batch.commit();
  return commentRef.id;
}

export async function listComments(cycleId, pageSize = 50) {
  const items = await restQuery('comments', {
    parent: `cycles/${cycleId}`,
    orderBy: [{ field: 'createdAt', dir: 'ASCENDING' }],
    limit: pageSize,
  });
  return { items, cursor: null };
}

export async function deleteComment(cycleId, commentId) {
  const batch = writeBatch(_db);
  batch.delete(doc(_db, 'cycles', cycleId, 'comments', commentId));
  batch.update(doc(_db, 'cycles', cycleId), { commentCount: increment(-1) });
  await batch.commit();
}

// ------------------------------------------------------------------
// Ratings (cycles/{id}/ratings), derived-on-read
// ------------------------------------------------------------------

export async function submitRating(cycleId, rating) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  if (![1, 2, 3, 4, 5].includes(rating)) throw new Error('Rating must be 1-5');
  _rateGuard();

  const ratingRef = doc(_db, 'cycles', cycleId, 'ratings', user.uid);
  await setDoc(ratingRef, {
    uid: user.uid,
    rating,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function getUserRating(cycleId) {
  const user = _auth.currentUser;
  if (!user) return null;
  const rec = await restGet(`cycles/${cycleId}/ratings/${user.uid}`);
  return rec ? rec.rating : null;
}

// Authoritative rating summary from the ratings subcollection (REST aggregation query).
export async function getRatingSummary(cycleId) {
  return restRatingSummary(cycleId);
}

// ------------------------------------------------------------------
// Admin
// ------------------------------------------------------------------

// Obfuscated provenance mapping - documented ONLY here + in the design spec, never in
// public docs. Regular store UI never shows this; approved cycles are public-read so it
// is obscured, not secret.
const _QC_LABEL = { 1: 'Recording', 2: 'Edited', 3: 'Manual' };
export function qcLabel(qc) { return _QC_LABEL[qc] || 'Unknown'; }

export async function adminListCycles({ status = null, applianceType = null, pageSize = 24, cursor = null } = {}) {
  const filters = [];
  if (status) filters.push({ field: 'status', op: 'EQUAL', value: status });
  if (applianceType) filters.push({ field: 'applianceType', op: 'EQUAL', value: applianceType });
  const items = (await restQuery('cycles', {
    filters,
    orderBy: [{ field: 'createdAt', dir: 'DESCENDING' }],
    limit: pageSize,
    startAfter: cursor ? [cursor] : null,
    auth: true,
  })).map(hydrateCycle);
  const next = items.length === pageSize ? items[items.length - 1].createdAt : null;
  return { items, cursor: next };
}

export async function adminSetCycleStatus(id, status, reason = null) {
  const update = { status };
  if (reason != null) update.rejectionReason = reason;
  await updateDoc(doc(_db, 'cycles', id), update);
}

export async function adminListDevices({ status = null, pageSize = 50 } = {}) {
  const filters = [];
  if (status) filters.push({ field: 'status', op: 'EQUAL', value: status });
  const items = await restQuery('devices', {
    filters,
    orderBy: [{ field: 'favoriteCount', dir: 'DESCENDING' }],
    limit: pageSize,
    auth: true,
  });
  return { items, cursor: null };
}

export async function adminSetDeviceStatus(id, status) {
  await updateDoc(doc(_db, 'devices', id), { status });
}

export async function adminSetDeviceOwner(deviceId, ownerUid) {
  await updateDoc(doc(_db, 'devices', deviceId), { ownerId: ownerUid || null });
}

export async function adminSetProfileOwner(profileId, ownerUid) {
  await updateDoc(doc(_db, 'profiles', profileId), { ownerId: ownerUid || null });
}

// Admin brand/profile listings for the review tabs. No server-side status filter
// (keeps the query on a single-field index); the admin UI filters client-side.
export async function adminListBrands({ pageSize = 200 } = {}) {
  const items = await restQuery('brands', {
    orderBy: [{ field: 'brand_lc', dir: 'ASCENDING' }],
    limit: pageSize,
    auth: true,
  });
  return { items, cursor: null };
}

export async function adminListProfiles({ pageSize = 200 } = {}) {
  const items = await restQuery('profiles', {
    orderBy: [{ field: 'createdAt', dir: 'DESCENDING' }],
    limit: pageSize,
    auth: true,
  });
  return { items, cursor: null };
}

export async function adminSetProfileStatus(id, status) {
  await updateDoc(doc(_db, 'profiles', id), { status });
}

export async function adminSetBrandStatus(brandLc, status) {
  await updateDoc(doc(_db, 'brands', brandLc), { status });
}

// Reassign fromId's profiles + cycles to toId, then delete the empty source device.
// Admin-only, rare; kept within a single batch (Firestore 500-op limit - fine for
// the small clusters near-duplicate devices produce).
export async function adminMergeDevices(fromId, toId) {
  if (fromId === toId) throw new Error('Cannot merge a device into itself');
  const [profSnap, cycSnap] = await Promise.all([
    getDocs(query(collection(_db, 'profiles'), where('deviceId', '==', fromId))),
    getDocs(query(collection(_db, 'cycles'), where('deviceId', '==', fromId))),
  ]);
  const batch = writeBatch(_db);
  const remap = {};
  for (const p of profSnap.docs) {
    const data = p.data();
    const newPid = mkProfileId(toId, data.program || '');
    remap[p.id] = newPid;
    batch.set(doc(_db, 'profiles', newPid), { ...data, deviceId: toId }, { merge: true });
    batch.delete(doc(_db, 'profiles', p.id));
  }
  for (const c of cycSnap.docs) {
    const data = c.data();
    const newPid = remap[data.profileId] || mkProfileId(toId, (data.program_lc || '').replace(/-/g, ' '));
    batch.update(doc(_db, 'cycles', c.id), { deviceId: toId, profileId: newPid });
  }
  batch.delete(doc(_db, 'devices', fromId));
  await batch.commit();
}

// Reassign a profile's cycles to another profile, then delete the empty source.
// Admin-only; for deduping near-duplicate profiles (e.g. "Eco 50" / "Eco 50C").
export async function adminMergeProfiles(fromId, toId) {
  if (fromId === toId) throw new Error('Cannot merge a profile into itself');
  const cycSnap = await getDocs(query(collection(_db, 'cycles'), where('profileId', '==', fromId)));
  const batch = writeBatch(_db);
  for (const c of cycSnap.docs) batch.update(doc(_db, 'cycles', c.id), { profileId: toId });
  batch.delete(doc(_db, 'profiles', fromId));
  await batch.commit();
}

export async function adminListUsers({ pageSize = 50, cursor = null } = {}) {
  const items = await restQuery('users', {
    orderBy: [{ field: 'createdAt', dir: 'DESCENDING' }],
    limit: pageSize,
    startAfter: cursor ? [cursor] : null,
    auth: true,
  });
  const next = items.length === pageSize ? items[items.length - 1].createdAt : null;
  return { items, cursor: next };
}

export async function adminBanUser(uid, reason = '') {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  await updateDoc(doc(_db, 'users', uid), {
    status: 'banned',
    banReason: reason,
    bannedAt: serverTimestamp(),
    bannedBy: user.uid,
  });
}

export async function adminUnbanUser(uid) {
  await updateDoc(doc(_db, 'users', uid), {
    status: 'active',
    banReason: null,
    bannedAt: null,
    bannedBy: null,
  });
}

export async function adminDeleteComment(cycleId, commentId) {
  await deleteComment(cycleId, commentId);
}

// Hard-delete a device and cascade: all its profiles and all their cycles.
export async function adminDeleteDevice(deviceId) {
  const [profSnap, cycSnap] = await Promise.all([
    getDocs(query(collection(_db, 'profiles'), where('deviceId', '==', deviceId))),
    getDocs(query(collection(_db, 'cycles'), where('deviceId', '==', deviceId))),
  ]);
  const batch = writeBatch(_db);
  for (const p of profSnap.docs) batch.delete(doc(_db, 'profiles', p.id));
  for (const c of cycSnap.docs) batch.delete(doc(_db, 'cycles', c.id));
  batch.delete(doc(_db, 'devices', deviceId));
  await batch.commit();
}

// Hard-delete a brand document.
export async function adminDeleteBrand(brandId) {
  await deleteDoc(doc(_db, 'brands', brandId));
}

// Hard-delete a profile and all its reference cycles.
export async function adminDeleteProfile(profileId) {
  const cycSnap = await getDocs(query(collection(_db, 'cycles'), where('profileId', '==', profileId)));
  const batch = writeBatch(_db);
  for (const c of cycSnap.docs) batch.delete(doc(_db, 'cycles', c.id));
  batch.delete(doc(_db, 'profiles', profileId));
  await batch.commit();
}

// Reassign a user's contributions to anonymous, then hard-delete their user doc.
// Batched to stay under Firestore's 500-op limit.
export async function adminDeleteUser(uid) {
  const BATCH_SIZE = 400;
  const [devSnap, profSnap, cycSnap] = await Promise.all([
    getDocs(query(collection(_db, 'devices'), where('createdByUid', '==', uid))),
    getDocs(query(collection(_db, 'profiles'), where('createdByUid', '==', uid))),
    getDocs(query(collection(_db, 'cycles'), where('uploaderUid', '==', uid))),
  ]);
  const ops = [
    ...devSnap.docs.map((d) => ({ ref: doc(_db, 'devices', d.id), data: { createdByUid: null, createdByName: 'Deleted User' } })),
    ...profSnap.docs.map((p) => ({ ref: doc(_db, 'profiles', p.id), data: { createdByUid: null, createdByName: 'Deleted User' } })),
    ...cycSnap.docs.map((c) => ({ ref: doc(_db, 'cycles', c.id), data: { uploaderUid: null, uploaderName: 'Deleted User' } })),
  ];
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const batch = writeBatch(_db);
    for (const { ref, data } of ops.slice(i, i + BATCH_SIZE)) batch.update(ref, data);
    await batch.commit();
  }
  await deleteDoc(doc(_db, 'users', uid));
}

export async function adminGetStats() {
  const c = (coll, s) => restCount(coll, [{ field: 'status', op: 'EQUAL', value: s }], { auth: true });
  const [pb, pd, pp, pc, approved, rejected, removed, bannedUsers] = await Promise.all([
    // "Pending review" spans the whole catalog, not just cycles.
    c('brands', 'pending'), c('devices', 'pending'), c('profiles', 'pending'), c('cycles', 'pending'),
    c('cycles', 'approved'), c('cycles', 'rejected'), c('cycles', 'removed'),
    restCount('users', [{ field: 'status', op: 'EQUAL', value: 'banned' }], { auth: true }),
  ]);
  return { pending: pb + pd + pp + pc, approved, rejected, removed, bannedUsers };
}
