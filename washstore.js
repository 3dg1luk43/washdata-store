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
import { deviceId as mkDeviceId, profileId as mkProfileId, lc } from './lib/ids.js';
import {
  assertDeviceMergeOk, assertProfileMergeOk, assertCycleMoveOk, assertBrandMergeOk,
} from './lib/merge_guard.js';
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

// Content-report reason categories (value stored on the report doc; label shown in the UI
// and grouped in the admin review queue). Keep values <= 40 chars to satisfy the rule.
export const REPORT_REASONS = [
  { value: 'spam', label: 'Spam or advertising' },
  { value: 'wrong', label: 'Wrong or misleading data' },
  { value: 'offensive', label: 'Offensive or abusive' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'other', label: 'Something else' },
];
const _REPORT_REASON_LABELS = Object.fromEntries(REPORT_REASONS.map((r) => [r.value, r.label]));
export function reportReasonLabel(v) { return _REPORT_REASON_LABELS[v] || v || 'Other'; }
export const REPORT_TARGET_TYPES = ['brand', 'device', 'profile', 'cycle', 'comment'];

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
// Returns the user's profile data (post-update), so callers that need the ban status,
// githubLogin or favorites can reuse this single read instead of re-fetching the same
// document -- the sign-in path was reading users/{uid} four times per page load.
export async function ensureUserProfile(user, githubLogin = null) {
  const ref = doc(_db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const created = {
      uid: user.uid,
      displayName: user.displayName || null,
      photoURL: user.photoURL || null,
      createdAt: serverTimestamp(),
      lastSeen: serverTimestamp(),
      status: 'active',
      favorites: [],
      ...(githubLogin ? { githubLogin } : {}),
    };
    await setDoc(ref, created, { merge: true });
    // The serverTimestamp() sentinels are not readable values; callers only look at
    // status/githubLogin/favorites, so hand back the resolved shape for those.
    return { ...created, createdAt: null, lastSeen: null };
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
  // Merge the writes we just made so the caller sees the same state a re-read would show.
  return { ...data, ...updates, lastSeen: data.lastSeen };
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
// Catalog read cache (sessionStorage)
// ------------------------------------------------------------------
// The brand/device catalog is public and slow-changing, but the browse grid re-queries
// it on every page load, reload, and back-navigation, and the contribute datalist queries
// it again. On the store's free-tier read budget that made the brand + device list queries
// a top read source. Cache the unfiltered listings in sessionStorage (survives reloads and
// same-tab navigation between the browse and contribute pages) for a short TTL. Only the
// brand/device CARDS consume these, and they render no timestamp fields, so JSON round-trip
// (which drops decoded-timestamp methods) is safe here. A contribution invalidates the cache.
const _CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 min

function _catalogCacheGet(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { exp, val } = JSON.parse(raw);
    if (!exp || Date.now() >= exp) { sessionStorage.removeItem(key); return null; }
    return val;
  } catch (_) { return null; }
}

function _catalogCachePut(key, val) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ exp: Date.now() + _CATALOG_CACHE_TTL_MS, val }));
  } catch (_) { /* private mode / quota: caching is best-effort */ }
}

// Drop every cached catalog listing (call after a create so a freshly-contributed brand
// or device appears immediately instead of after the TTL).
export function invalidateCatalogCache() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith('wdcat:')) sessionStorage.removeItem(k);
    }
  } catch (_) { /* best-effort */ }
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
      deviceCount: 0,
      cycleCount: 0,
      approvedDeviceCount: 0,
    });
    invalidateCatalogCache();  // a new brand must appear in the cached listing immediately
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
    // Increment brand's stored device counter (best-effort; rules allow exactly +1).
    try { await updateDoc(doc(_db, 'brands', brand.toLowerCase()), { deviceCount: increment(1) }); } catch (_) {}
    invalidateCatalogCache();  // a new device must appear in the cached listing immediately
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

// Brands auto-approve on their own bar: how many of a brand's DEVICES must be approved before
// the brand itself is. Falls back to the shared device/cycle threshold when unset, matching
// the `brandConfirmThreshold()` rules helper exactly -- if the two ever disagree the rule
// wins and the promotion write is simply denied.
let _brandThresholdCache = null;
export async function brandConfirmThresholdValue() {
  if (_brandThresholdCache != null) return _brandThresholdCache;
  const cfg = await getSiteConfig();
  const v = Number(cfg.brandConfirmThreshold);
  if (Number.isFinite(v) && v > 0) _brandThresholdCache = v;
  else _brandThresholdCache = await confirmThresholdValue();
  return _brandThresholdCache;
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
  let brand = null;
  if (status === 'pending' && count >= threshold) {
    try {
      // The device flip and its parent brand's approved-device credit go in ONE batch: the
      // brand rule verifies the credit with getAfter() on this very device, so it only
      // authorizes the bump while the same commit turns that device approved.
      const batch = writeBatch(_db);
      batch.update(doc(_db, 'devices', deviceId), { status: 'approved' });
      if (dev && dev.brand_lc) {
        batch.update(doc(_db, 'brands', dev.brand_lc), {
          approvedDeviceCount: increment(1),
          lastApprovedDeviceId: deviceId,
        });
      }
      await batch.commit();
      status = 'approved';
    } catch (_) {
      // The brand doc may be missing (device namespaces and brand ids derive differently), in
      // which case the combined batch fails as a whole. Fall back to the device flip alone so
      // a bookkeeping problem never blocks the approval the community actually earned.
      try { await updateDoc(doc(_db, 'devices', deviceId), { status: 'approved' }); status = 'approved'; }
      catch (_) { /* race or rule mismatch: leave pending, ignore */ }
    }
    if (status === 'approved' && dev && dev.brand_lc) brand = await _maybePromoteBrand(dev.brand_lc);
  }
  return { confirmed: true, confirmCount: count, status, brand };
}

// A brand is approved once enough of its DEVICES are. Called after a device is promoted;
// best-effort, exactly like the device promotion itself -- the rule is the real guard, so a
// denied write just leaves the brand pending. Returns { status, approvedDeviceCount,
// threshold } for the caller's UI, or null when there is nothing to report.
async function _maybePromoteBrand(brandLc) {
  try {
    const b = await restGet(`brands/${brandLc}`);
    if (!b) return null;
    const approved = Number(b.approvedDeviceCount) || 0;
    const threshold = await brandConfirmThresholdValue();
    let status = b.status;
    if (status === 'pending' && approved >= threshold) {
      try { await updateDoc(doc(_db, 'brands', brandLc), { status: 'approved' }); status = 'approved'; }
      catch (_) { /* race or rule mismatch: leave pending */ }
    }
    return { id: brandLc, status, approvedDeviceCount: approved, threshold };
  } catch (_) { return null; }
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
  const ratingRef = doc(_db, 'devices', deviceId, 'ratings', user.uid);
  // Maintain the denormalized ratingSum/ratingCount on the device doc in the same batch
  // (see submitRating for the rationale). Prior rating needed to shift the sum on an edit.
  let prev = null;
  try { const s = await getDoc(ratingRef); if (s.exists()) prev = s.data().rating; } catch (_) {}
  const batch = writeBatch(_db);
  batch.set(ratingRef, { uid: user.uid, rating, updatedAt: serverTimestamp() }, { merge: true });
  const devRef = doc(_db, 'devices', deviceId);
  if (prev == null) {
    batch.update(devRef, { ratingCount: increment(1), ratingSum: increment(rating) });
  } else if (prev !== rating) {
    batch.update(devRef, { ratingSum: increment(rating - prev) });
  }
  await batch.commit();
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
    // Increment device's stored profile counter (best-effort; rules allow exactly +1).
    try { await updateDoc(doc(_db, 'devices', deviceId), { profileCount: increment(1) }); } catch (_) {}
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
  // Cache only the unfiltered first page (landing grid + contribute datalist); searched or
  // paginated queries pass through so search-as-you-type and load-more stay live.
  const cacheable = !search && !cursor;
  const cacheKey = `wdcat:brands:${includePending ? 1 : 0}:${pageSize}`;
  if (cacheable) {
    const hit = _catalogCacheGet(cacheKey);
    if (hit) return hit;
  }
  let result;
  if (includePending) {
    const [a, p] = await Promise.all([
      restQuery('brands', { filters: _brandFilters('approved', search), orderBy: [{ field: 'brand_lc', dir: 'ASCENDING' }], limit: pageSize }),
      restQuery('brands', { filters: _brandFilters('pending', search), orderBy: [{ field: 'brand_lc', dir: 'ASCENDING' }], limit: pageSize }),
    ]);
    const byId = new Map();
    for (const b of [...a, ...p]) byId.set(b.id, b);
    const items = [...byId.values()].sort((x, y) => (x.brand_lc || '').localeCompare(y.brand_lc || '')).slice(0, pageSize);
    result = { items, cursor: null };
  } else {
    const items = await restQuery('brands', {
      filters: _brandFilters('approved', search),
      orderBy: [{ field: 'brand_lc', dir: 'ASCENDING' }],
      limit: pageSize,
      startAfter: cursor ? [cursor] : null,
    });
    const next = items.length === pageSize ? items[items.length - 1].brand_lc : null;
    result = { items, cursor: next };
  }
  if (cacheable) _catalogCachePut(cacheKey, result);
  return result;
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
    return { items, cursor: null };  // favorites depend on the signed-in user; not cached
  }
  const cacheKey = `wdcat:devices:${(brand || '').toLowerCase()}:${applianceType || ''}:${includePending ? 1 : 0}:${pageSize}`;
  const hit = _catalogCacheGet(cacheKey);
  if (hit) return hit;
  const q = (status) => restQuery('devices', {
    filters: _deviceFilters(status, applianceType, brand),
    orderBy: [{ field: 'favoriteCount', dir: 'DESCENDING' }],
    limit: pageSize,
  });
  let result;
  if (includePending) {
    const [a, p] = await Promise.all([q('approved'), q('pending')]);
    const byId = new Map();
    // Approved first, then pending, so approved wins on id collisions.
    for (const d of [...a, ...p]) if (!byId.has(d.id)) byId.set(d.id, d);
    result = { items: [...byId.values()].slice(0, pageSize), cursor: null };
  } else {
    result = { items: await q('approved'), cursor: null };
  }
  _catalogCachePut(cacheKey, result);
  return result;
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

// Public read via REST. Returns {} when unset/unavailable. Not time-cached, so the
// maintenance flag is always current (a stale cache must not keep the site hidden/open) --
// but concurrent callers are coalesced into ONE network read. On page load the maintenance
// flag and the confirm threshold are both read in the same tick; without this that was two
// identical config/site reads per load.
let _siteConfigInflight = null;
export async function getSiteConfig() {
  if (_siteConfigInflight) return _siteConfigInflight;
  _siteConfigInflight = (async () => {
    try {
      return (await restGet('config/site', { noStore: true })) || {};
    } catch (_) {
      return {};
    }
  })();
  try {
    return await _siteConfigInflight;
  } finally {
    _siteConfigInflight = null;  // next (non-concurrent) call reads fresh
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

// Approved devices needed before a pending BRAND is auto-approved. Stored separately from
// confirmThreshold so brands can sit on a lower bar; clearing it (0/blank) falls back to the
// shared threshold, matching the rules helper.
export async function setBrandConfirmThreshold(n) {
  const v = Math.max(1, Math.min(1000, Math.round(Number(n) || 0)));
  await setDoc(doc(_db, 'config', 'site'), { brandConfirmThreshold: v, updatedAt: serverTimestamp() }, { merge: true });
  _brandThresholdCache = v;
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
  const points = downsampleCycle(tracePoints, 10000);
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
  // Increment denormalized counts on the profile, device, and brand (best-effort).
  try {
    await Promise.all([
      updateDoc(doc(_db, 'profiles', profId), { cycleCount: increment(1) }),
      updateDoc(doc(_db, 'devices', devId), { cycleCount: increment(1) }),
      updateDoc(doc(_db, 'brands', brand.toLowerCase()), { cycleCount: increment(1) }),
    ]);
  } catch (_) {}
  return ref.id;
}

// ------------------------------------------------------------------
// Denormalized counter helpers
// ------------------------------------------------------------------
// Counts (deviceCount on brands, profileCount/cycleCount on devices, cycleCount on
// profiles) are now stored and maintained incrementally at every mutation point, so the
// browse page never fires per-card aggregation queries. A status is "visible" when it
// is pending or approved (not removed/rejected); counters track visible items only.

function _isVisible(status) { return status === 'pending' || status === 'approved'; }
// brands.approvedDeviceCount tracks APPROVED devices only (not merely visible ones), because
// it is the basis of brand auto-approval: a pending device must not vouch for a brand.
function _isApproved(status) { return status === 'approved'; }

// Returns +1 when a status transition makes an item appear, -1 when it disappears, 0 otherwise.
function _counterDelta(oldStatus, newStatus) {
  const was = _isVisible(oldStatus), now = _isVisible(newStatus);
  if (was && !now) return -1;
  if (!was && now) return 1;
  return 0;
}

// Profile rating is DERIVED (read-only) from its visible cycles' ratings: the
// count-weighted mean of each cycle's 5-star average. There is no profile-level rating
// collection -- users rate cycles, and a profile inherits the aggregate of its cycles.
// Bounded fan-out (approved + pending cycle ids via two status-scoped queries -- rules
// require the status filter -- then one rating aggregation per cycle). Never throws.
// Read the denormalized rating aggregate off a cycle or device doc. Returns {avg, count}
// when the doc carries `ratingCount` (populated on rating writes + the recount backfill),
// else null so the caller can fall back to the live aggregation query. Zero extra reads:
// the fields ride on docs the browse/list queries already fetched.
export function ratingSummaryFromDoc(docData) {
  if (!docData || docData.ratingCount == null) return null;
  const count = Number(docData.ratingCount) || 0;
  const sum = Number(docData.ratingSum) || 0;
  return { avg: count > 0 ? sum / count : null, count };
}

export async function getProfileRating(profileId, { includePending = true } = {}) {
  let docs = [];
  try {
    const q = (status) => restQuery('cycles', {
      filters: [
        { field: 'profileId', op: 'EQUAL', value: profileId },
        { field: 'status', op: 'EQUAL', value: status },
      ],
      // Only the two denormalized aggregate fields are needed. Without this projection the
      // query downloaded whole cycle documents -- `trace.points`, up to MAX_DOC_BYTES each
      // -- to read two integers, for every profile row on every device page.
      select: ['ratingSum', 'ratingCount'],
      // The equality pair alone leaves the implicit `__name__ ASC` ordering, which the
      // deployed (profileId, status, createdAt DESC) index cannot serve -- Firestore then
      // falls back to merging the single-field indexes, and the `status` one spans every
      // cycle in the store (observed: ~10.6 index entries scanned per 0.55 documents
      // returned). Ordering by createdAt puts the query back on that composite index.
      orderBy: [{ field: 'createdAt', dir: 'DESCENDING' }],
      limit: 40,
    });
    const groups = includePending ? await Promise.all([q('approved'), q('pending')]) : [await q('approved')];
    docs = groups.flat();
  } catch (_) { return { avg: null, count: 0 }; }
  if (!docs.length) return { avg: null, count: 0 };
  let total = 0; let n = 0;
  const needAgg = [];
  for (const c of docs) {
    // Prefer the denormalized aggregate carried on the cycle doc (0 extra reads); fall
    // back to a live aggregation only for cycles that predate the backfill.
    if (c.ratingCount != null) {
      const cnt = Number(c.ratingCount) || 0;
      if (cnt > 0) { total += Number(c.ratingSum) || 0; n += cnt; }
    } else {
      needAgg.push(c);
    }
  }
  if (needAgg.length) {
    const summaries = await Promise.all(
      needAgg.map((c) => restRatingSummary(c.id).catch(() => ({ avg: null, count: 0 }))),
    );
    for (const s of summaries) { if (s.count > 0 && s.avg != null) { total += s.avg * s.count; n += s.count; } }
  }
  return { avg: n > 0 ? total / n : null, count: n };
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
  const cyc = await restGet(`cycles/${id}`, { auth: true, noStore: true });
  await deleteDoc(doc(_db, 'cycles', id));
  if (cyc && _isVisible(cyc.status)) {
    const updates = [];
    if (cyc.profileId) updates.push(updateDoc(doc(_db, 'profiles', cyc.profileId), { cycleCount: increment(-1) }));
    if (cyc.deviceId) updates.push(updateDoc(doc(_db, 'devices', cyc.deviceId), { cycleCount: increment(-1) }));
    if (cyc.brand_lc) updates.push(updateDoc(doc(_db, 'brands', cyc.brand_lc), { cycleCount: increment(-1) }));
    try { await Promise.all(updates); } catch (_) {}
  }
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
// Analytics (aggregate event counters, admin-readable only)
// ------------------------------------------------------------------

// Fields we accept. Allowlist keeps arbitrary keys out of the analytics docs.
// (No 'downloads': the website has no download action; the integration credits each
// cycle's own `downloads` counter server-side instead.)
const _ANALYTICS_FIELDS = [
  'brand_views', 'device_views', 'profile_views', 'cycle_details',
  'searches', 'favorites', 'device_confirms',
  'device_ratings', 'cycle_ratings',
];

// Best-effort: increments today's daily counter and the all-time totals doc.
// Failures are silently swallowed (analytics loss is acceptable).
export async function logStoreEvent(field) {
  if (!_ANALYTICS_FIELDS.includes(field) || !_db) return;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const docId = `daily_${today.replace(/-/g, '')}`;
  const upd = { [field]: increment(1) };
  const dailyRef = doc(_db, 'analytics', docId);
  const totalsRef = doc(_db, 'analytics', 'totals');
  try {
    await Promise.all([
      updateDoc(dailyRef, upd).catch(() =>
        setDoc(dailyRef, { ...upd, date: today }, { merge: true })),
      updateDoc(totalsRef, upd).catch(() =>
        setDoc(totalsRef, upd, { merge: true })),
    ]);
  } catch (_) {}
}

// Reads the last `days` daily documents plus the all-time totals for the
// admin Statistics tab. Returns { totals: {field: n, ...}, daily: [{date, ...}, ...] }
// in chronological order (oldest first).
export async function adminGetAnalytics({ days = 30 } = {}) {
  const today = new Date();
  const docEntries = Array.from({ length: days }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    return { id: `daily_${iso.replace(/-/g, '')}`, date: iso };
  });

  const [totalsSnap, ...dailySnaps] = await Promise.all([
    getDoc(doc(_db, 'analytics', 'totals')),
    ...docEntries.map(({ id }) => getDoc(doc(_db, 'analytics', id))),
  ]);

  const totals = totalsSnap.exists() ? totalsSnap.data() : {};
  // Reverse so the array is chronological (oldest → newest).
  const daily = dailySnaps.map((snap, i) => ({
    date: docEntries[i].date,
    ...(snap.exists() ? snap.data() : {}),
  })).reverse();

  return { totals, daily };
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
  // Read the user's prior rating so the denormalized ratingSum/ratingCount on the cycle doc
  // can be maintained in the SAME batch (rules require the batch tie-in). A first rating
  // bumps count +1 and sum += rating; an edit only shifts sum by (new - old).
  let prev = null;
  try { const s = await getDoc(ratingRef); if (s.exists()) prev = s.data().rating; } catch (_) {}
  const batch = writeBatch(_db);
  batch.set(ratingRef, { uid: user.uid, rating, updatedAt: serverTimestamp() }, { merge: true });
  const cycleRef = doc(_db, 'cycles', cycleId);
  if (prev == null) {
    batch.update(cycleRef, { ratingCount: increment(1), ratingSum: increment(rating) });
  } else if (prev !== rating) {
    batch.update(cycleRef, { ratingSum: increment(rating - prev) });
  }
  await batch.commit();
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
  const cyc = await restGet(`cycles/${id}`, { auth: true, noStore: true });
  const update = { status };
  if (reason != null) update.rejectionReason = reason;
  await updateDoc(doc(_db, 'cycles', id), update);
  if (cyc) {
    const delta = _counterDelta(cyc.status, status);
    if (delta !== 0) {
      const updates = [];
      if (cyc.profileId) updates.push(updateDoc(doc(_db, 'profiles', cyc.profileId), { cycleCount: increment(delta) }));
      if (cyc.deviceId) updates.push(updateDoc(doc(_db, 'devices', cyc.deviceId), { cycleCount: increment(delta) }));
      if (cyc.brand_lc) updates.push(updateDoc(doc(_db, 'brands', cyc.brand_lc), { cycleCount: increment(delta) }));
      try { await Promise.all(updates); } catch (_) {}
    }
  }
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
  const dev = await restGet(`devices/${id}`, { auth: true, noStore: true });
  await updateDoc(doc(_db, 'devices', id), { status });
  if (dev?.brand_lc) {
    // Two independent tallies on the parent brand: visible devices, and APPROVED devices
    // (which gate brand auto-approval). Combined into one update -- a doc must not be
    // written twice in a batch, and one round trip is cheaper anyway.
    const upd = {};
    const visDelta = _counterDelta(dev.status, status);
    if (visDelta !== 0) upd.deviceCount = increment(visDelta);
    const apprDelta = (_isApproved(status) ? 1 : 0) - (_isApproved(dev.status) ? 1 : 0);
    if (apprDelta !== 0) upd.approvedDeviceCount = increment(apprDelta);
    if (Object.keys(upd).length) {
      try { await updateDoc(doc(_db, 'brands', dev.brand_lc), upd); } catch (_) {}
    }
    // An admin approving the Nth device should promote the brand just as a community
    // confirmation would; no silent divergence between the two paths.
    if (apprDelta > 0) await _maybePromoteBrand(dev.brand_lc);
  }
}

export async function adminSetDeviceOwner(deviceId, ownerUid, ownerName) {
  await updateDoc(doc(_db, 'devices', deviceId), {
    ownerId: ownerUid || null,
    createdByName: ownerUid ? (ownerName || null) : null,
  });
}

export async function adminSetProfileOwner(profileId, ownerUid, ownerName) {
  await updateDoc(doc(_db, 'profiles', profileId), {
    ownerId: ownerUid || null,
    createdByName: ownerUid ? (ownerName || null) : null,
  });
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
  const prof = await restGet(`profiles/${id}`, { auth: true, noStore: true });
  await updateDoc(doc(_db, 'profiles', id), { status });
  if (prof?.deviceId) {
    const delta = _counterDelta(prof.status, status);
    if (delta !== 0) {
      try { await updateDoc(doc(_db, 'devices', prof.deviceId), { profileCount: increment(delta) }); } catch (_) {}
    }
  }
}

export async function adminSetBrandStatus(brandLc, status) {
  await updateDoc(doc(_db, 'brands', brandLc), { status });
}

// ------------------------------------------------------------------
// Admin merge (fold a duplicate object into the canonical one)
//
// Every merge re-points the source's children onto the target and then DELETES the source,
// so it is unrecoverable and must not half-apply in a way that double-counts. Two rules
// hold everywhere below:
//
//   1. Pre-flight guards come from lib/merge_guard.js (pure + unit-tested): the target must
//      EXIST and the appliance type must match. Cross-brand is allowed on purpose.
//   2. Writes are ordered "idempotent first, structural last": the bulk child re-points go
//      in repeatable chunks (re-writing the same deviceId/profileId is a no-op), and every
//      counter increment plus the source deletion lands in ONE final atomic batch. A chunk
//      that fails therefore leaves a re-runnable state and never a double increment.
// ------------------------------------------------------------------

// Firestore caps a batch at 500 writes. A popular device can exceed that, and the error it
// raises is opaque, so bulk child re-points are chunked. Only safe for IDEMPOTENT ops --
// see rule 2 above.
const _MERGE_CHUNK = 450;

async function _commitChunked(ops) {
  for (let i = 0; i < ops.length; i += _MERGE_CHUNK) {
    const batch = writeBatch(_db);
    for (const { ref, data } of ops.slice(i, i + _MERGE_CHUNK)) batch.update(ref, data);
    await batch.commit();
  }
}

// Guard the final structural batch against the same 500-op cap. It must stay atomic (it
// carries the counter increments), so overflow is a hard error rather than a silent split.
function _assertAtomic(count, what) {
  if (count > _MERGE_CHUNK) {
    throw new Error(`${what} is too large to merge atomically (${count} writes). `
      + 'Delete or split some of its programs first.');
  }
}

// Firestore keeps subcollection documents when their parent doc is deleted, so a merged-away
// object's `reports` outlive it. Left open they inflate the moderation badge forever with an
// object no admin can act on, so stamp them resolved (keeping the audit trail) instead.
// Best-effort: never fail a merge over its bookkeeping.
async function _closeOrphanedReports(targetPath) {
  try { await adminResolveReports(targetPath, 'merged'); } catch (_) { /* best-effort */ }
}

// `confirmations` + `ratings` under a deleted device are worse than noise: if the device is
// re-contributed later it derives the SAME id and inherits them, so every previous confirmer
// is locked out of bumping confirmCount (the rule requires their doc NOT to exist) and the
// entry can never reach the auto-approve threshold, while stale ratings resurface. Delete
// them with the parent. Scoped to the merged object only -- a per-cycle sweep would cost
// thousands of reads against the daily budget.
async function _purgeDeviceSubdocs(deviceId) {
  try {
    for (const sub of ['confirmations', 'ratings']) {
      const snap = await getDocs(collection(_db, 'devices', deviceId, sub));
      for (let i = 0; i < snap.docs.length; i += _MERGE_CHUNK) {
        const batch = writeBatch(_db);
        for (const d of snap.docs.slice(i, i + _MERGE_CHUNK)) batch.delete(d.ref);
        await batch.commit();
      }
    }
  } catch (_) { /* best-effort cleanup */ }
}

// A RE-ID (rename) keeps the same real appliance, just at a new derived id, so its
// per-user subcollections must travel with it -- otherwise a plain model rename silently
// discards every confirmation and rating (and the copied confirmCount/ratingSum on the doc
// would then describe subdocs that live under a dead path). `newId` is guaranteed fresh by
// the caller, so no de-duplication is needed. Reports move too: they are still about this
// object. Best-effort; the rename itself has already committed.
async function _migrateDeviceSubdocs(oldId, newId) {
  try {
    for (const sub of ['confirmations', 'ratings', 'reports']) {
      const snap = await getDocs(collection(_db, 'devices', oldId, sub));
      const ops = snap.docs.map((d) => ({ data: d.data(), id: d.id }));
      for (let i = 0; i < ops.length; i += Math.floor(_MERGE_CHUNK / 2)) {
        const batch = writeBatch(_db);
        for (const o of ops.slice(i, i + Math.floor(_MERGE_CHUNK / 2))) {
          batch.set(doc(_db, 'devices', newId, sub, o.id), o.data);
          batch.delete(doc(_db, 'devices', oldId, sub, o.id));
        }
        await batch.commit();
      }
    }
  } catch (_) { /* best-effort */ }
}

// Profile re-id twin of _migrateDeviceSubdocs: a profile's only subcollection is `reports`.
async function _migrateProfileReports(oldId, newId) {
  try {
    const snap = await getDocs(collection(_db, 'profiles', oldId, 'reports'));
    if (!snap.docs.length) return;
    const batch = writeBatch(_db);
    for (const d of snap.docs) {
      batch.set(doc(_db, 'profiles', newId, 'reports', d.id), { ...d.data(), targetId: newId, targetPath: `profiles/${newId}` });
      batch.delete(doc(_db, 'profiles', oldId, 'reports', d.id));
    }
    await batch.commit();
  } catch (_) { /* best-effort */ }
}

// Users store favorites as an array of deviceIds on their own user doc, so a merged-away
// device leaves a dangling id that silently disappears from their favorites page. Re-point
// them at the target (de-duplicated) and hand back how many users gained the target, so the
// caller can credit the target's favoriteCount. Best-effort: returns 0 on any failure.
async function _repointFavorites(fromId, toId) {
  try {
    const snap = await getDocs(query(collection(_db, 'users'), where('favorites', 'array-contains', fromId)));
    let gained = 0;
    const ops = [];
    for (const u of snap.docs) {
      const favs = new Set(u.data().favorites || []);
      favs.delete(fromId);
      if (!favs.has(toId)) { favs.add(toId); gained += 1; }
      ops.push({ ref: doc(_db, 'users', u.id), data: { favorites: [...favs] } });
    }
    await _commitChunked(ops);
    return gained;
  } catch (_) { return 0; }
}

// Reassign fromId's profiles + cycles to toId, then delete the empty source device.
// Admin-only, for folding a near-duplicate device (typo'd model, or the same model reached
// through a misspelled brand) into the canonical one. Cross-brand merges also relabel the
// moved cycles' brand_lc and rebalance both brands' cycle totals.
export async function adminMergeDevices(fromId, toId) {
  const [fromDev, toDev, profSnap, cycSnap] = await Promise.all([
    restGet(`devices/${fromId}`, { auth: true, noStore: true }),
    restGet(`devices/${toId}`, { auth: true, noStore: true }),
    getDocs(query(collection(_db, 'profiles'), where('deviceId', '==', fromId))),
    getDocs(query(collection(_db, 'cycles'), where('deviceId', '==', fromId))),
  ]);
  assertDeviceMergeOk(fromId, toId, fromDev, toDev);
  // Pre-check which source profiles collide with an already-existing target profile.
  // Fall back to program_lc for legacy docs with no `program`, so two distinct programs
  // cannot both normalize to the empty token and collapse into one target id.
  const profileMaps = profSnap.docs.map((p) => ({
    p, data: p.data(), newPid: mkProfileId(toId, p.data().program || p.data().program_lc || ''),
  }));
  const existsChecks = await Promise.all(
    profileMaps.map(({ newPid }) => getDoc(doc(_db, 'profiles', newPid)))
  );
  const crossBrand = !!(fromDev.brand_lc && toDev.brand_lc && fromDev.brand_lc !== toDev.brand_lc);
  // A cross-brand merge credits the target brand, so that doc has to exist or the atomic
  // batch would fail as a whole. Missing target brand => skip the credit (recoverable with
  // "Recalculate counts") rather than block the merge.
  const toBrandExists = crossBrand
    ? (await getDoc(doc(_db, 'brands', toDev.brand_lc))).exists() : false;

  // Plan the target-side profile set first, keyed by target id, so several source profiles
  // that resolve to ONE target id are folded together. Without that key, the pre-computed
  // existence checks (taken before any write) would both look free and the second `set`
  // would overwrite the first -- and a batch may not write one document twice.
  const remap = {};
  const targets = new Map();   // newPid -> { absorb, data, programLc, visCycles, countsAsNew }
  for (let i = 0; i < profileMaps.length; i++) {
    const { p, data, newPid } = profileMaps[i];
    remap[p.id] = newPid;
    const visCyc = cycSnap.docs.filter(
      (c) => c.data().profileId === p.id && _isVisible(c.data().status)).length;
    let t = targets.get(newPid);
    if (!t) {
      // Absorb into an existing target profile, or re-create the source under the new id.
      // The absorbing target keeps its own name, so its program_lc is what the moved cycles
      // must adopt: two spellings can normalize to one id ("Eco-50"/"Eco 50"), and the
      // integration names an imported profile from the cycle's program_lc, so a stale value
      // re-creates downstream the very duplicate this merge removes.
      const exists = existsChecks[i].exists();
      const tgt = exists ? existsChecks[i].data() : data;
      t = {
        absorb: exists,
        data: exists ? null : { ...data, deviceId: toId },
        programLc: tgt.program_lc || lc(tgt.program || ''),
        visCycles: 0,
        countsAsNew: !exists && _isVisible(data.status),
      };
      targets.set(newPid, t);
    }
    t.visCycles += visCyc;
  }

  let newProfileCount = 0;
  const structural = [];
  const relabel = {};   // newPid -> program_lc of the profile the cycles actually land on
  for (const [newPid, t] of targets) {
    relabel[newPid] = t.programLc;
    if (t.absorb) {
      if (t.visCycles > 0) {
        structural.push({ op: 'update', ref: doc(_db, 'profiles', newPid), data: { cycleCount: increment(t.visCycles) } });
      }
    } else {
      // A re-created profile's cycleCount is RECOMPUTED from the cycles that actually point
      // at it (including any folded-in siblings') rather than carried over, so a merge also
      // repairs a count that had drifted.
      structural.push({ op: 'set', ref: doc(_db, 'profiles', newPid), data: { ...t.data, cycleCount: t.visCycles } });
      if (t.countsAsNew) newProfileCount++;
    }
  }
  // Every source profile doc goes away, whichever target absorbed it. Source ids are derived
  // from fromId and targets from toId, so a delete can never hit a doc just written above.
  for (const { p } of profileMaps) structural.push({ op: 'delete', ref: doc(_db, 'profiles', p.id) });

  // Phase 1 (chunked, idempotent): re-point every cycle onto the target device.
  const cycleOps = [];
  for (const c of cycSnap.docs) {
    const data = c.data();
    const newPid = remap[data.profileId] || mkProfileId(toId, (data.program_lc || '').replace(/-/g, ' '));
    const upd = { deviceId: toId, profileId: newPid };
    if (crossBrand) upd.brand_lc = toDev.brand_lc;
    if (relabel[newPid] && data.program_lc !== relabel[newPid]) upd.program_lc = relabel[newPid];
    // Repair any legacy skew while we are here: a cycle must declare its device's type.
    if (toDev.applianceType && data.applianceType !== toDev.applianceType) upd.applianceType = toDev.applianceType;
    cycleOps.push({ ref: doc(_db, 'cycles', c.id), data: upd });
  }
  await _commitChunked(cycleOps);

  // Phase 2 (single atomic batch): counters + the source deletions.
  const visibleCycles = cycSnap.docs.filter((c) => _isVisible(c.data().status)).length;
  const toUpdate = {};
  if (newProfileCount > 0) toUpdate.profileCount = increment(newProfileCount);
  if (visibleCycles > 0) toUpdate.cycleCount = increment(visibleCycles);
  // Favorites of the dissolved device follow it, so the target's vanity counter follows too.
  const favGained = await _repointFavorites(fromId, toId);
  if (favGained > 0) toUpdate.favoriteCount = increment(favGained);
  if (Object.keys(toUpdate).length > 0) {
    structural.push({ op: 'update', ref: doc(_db, 'devices', toId), data: toUpdate });
  }
  // Source brand loses the device, and on a cross-brand merge its cycles too. One combined
  // update: a batch must not write the same doc twice.
  const fromBrandUpd = {};
  if (fromDev.brand_lc && _isVisible(fromDev.status)) fromBrandUpd.deviceCount = increment(-1);
  if (fromDev.brand_lc && _isApproved(fromDev.status)) fromBrandUpd.approvedDeviceCount = increment(-1);
  if (crossBrand && visibleCycles > 0) fromBrandUpd.cycleCount = increment(-visibleCycles);
  if (fromDev.brand_lc && Object.keys(fromBrandUpd).length > 0) {
    structural.push({ op: 'update', ref: doc(_db, 'brands', fromDev.brand_lc), data: fromBrandUpd });
  }
  // Target brand gains those cycles (its deviceCount is unchanged - the target device
  // already existed and was already counted).
  if (crossBrand && toBrandExists && visibleCycles > 0) {
    structural.push({ op: 'update', ref: doc(_db, 'brands', toDev.brand_lc), data: { cycleCount: increment(visibleCycles) } });
  }
  structural.push({ op: 'delete', ref: doc(_db, 'devices', fromId) });

  _assertAtomic(structural.length, 'This device');
  const batch = writeBatch(_db);
  for (const { op, ref, data } of structural) {
    if (op === 'delete') batch.delete(ref);
    else if (op === 'set') batch.set(ref, data);
    else batch.update(ref, data);
  }
  await batch.commit();

  // Post-merge bookkeeping for the doc that no longer exists (best-effort, never throws).
  await Promise.all([
    _purgeDeviceSubdocs(fromId),
    _closeOrphanedReports(`devices/${fromId}`),
    ...profileMaps.map(({ p }) => _closeOrphanedReports(`profiles/${p.id}`)),
  ]);
  return { id: toId, profiles: profileMaps.length, cycles: cycSnap.docs.length };
}

// Reassign a profile's cycles to another profile, then delete the empty source.
// Admin-only; for deduping near-duplicate profiles (e.g. "Eco 50" / "Eco 50C"). The target
// may live on ANOTHER device (a program filed under the wrong model), in which case the
// cycles are relabelled onto that device and all three counter levels are rebalanced.
export async function adminMergeProfiles(fromId, toId) {
  const [fromProf, toProf, cycSnap] = await Promise.all([
    restGet(`profiles/${fromId}`, { auth: true, noStore: true }),
    restGet(`profiles/${toId}`, { auth: true, noStore: true }),
    getDocs(query(collection(_db, 'cycles'), where('profileId', '==', fromId))),
  ]);
  // Both parent devices are read unconditionally (two admin-only reads): the cross-device
  // path needs them to relabel the cycles, and the same-device path needs to know the parent
  // still exists before writing a counter to it -- a profile orphaned by older data would
  // otherwise fail the atomic batch with an opaque "no document to update".
  const [fromDev, toDev] = await Promise.all([
    fromProf?.deviceId ? restGet(`devices/${fromProf.deviceId}`, { auth: true, noStore: true }) : null,
    toProf?.deviceId ? restGet(`devices/${toProf.deviceId}`, { auth: true, noStore: true }) : null,
  ]);
  // assertProfileMergeOk already requires the target DEVICE for a cross-device merge; a
  // same-device merge whose shared parent is missing is left possible on purpose, so two
  // profiles orphaned by older data can still be consolidated (the counter writes below are
  // gated on the parent existing).
  const { crossDevice } = assertProfileMergeOk(fromId, toId, fromProf, toProf, fromDev, toDev);
  const crossBrand = !!(crossDevice && fromDev?.brand_lc && toDev?.brand_lc
    && fromDev.brand_lc !== toDev.brand_lc);
  const toBrandExists = crossBrand
    ? (await getDoc(doc(_db, 'brands', toDev.brand_lc))).exists() : false;

  // Phase 1 (chunked, idempotent): re-point the cycles. They adopt the target's program_lc
  // (and device identity) so nothing downstream still names the merged-away program -- the
  // integration derives an imported profile's name from the cycle's program_lc.
  const programLc = toProf.program_lc || lc(toProf.program || '');
  const cycleOps = cycSnap.docs.map((c) => {
    const data = c.data();
    const upd = { profileId: toId };
    if (programLc && data.program_lc !== programLc) upd.program_lc = programLc;
    if (crossDevice) {
      upd.deviceId = toProf.deviceId;
      if (crossBrand) upd.brand_lc = toDev.brand_lc;
      if (toDev?.applianceType && data.applianceType !== toDev.applianceType) {
        upd.applianceType = toDev.applianceType;
      }
    }
    return { ref: doc(_db, 'cycles', c.id), data: upd };
  });
  await _commitChunked(cycleOps);

  // Phase 2 (single atomic batch): counters + the source deletion.
  const visibleCycles = cycSnap.docs.filter((c) => _isVisible(c.data().status)).length;
  const batch = writeBatch(_db);
  batch.delete(doc(_db, 'profiles', fromId));
  if (visibleCycles > 0) batch.update(doc(_db, 'profiles', toId), { cycleCount: increment(visibleCycles) });
  // Source device loses the profile, and on a cross-device merge its cycles too.
  const fromDevUpd = {};
  if (_isVisible(fromProf.status)) fromDevUpd.profileCount = increment(-1);
  if (crossDevice && visibleCycles > 0) fromDevUpd.cycleCount = increment(-visibleCycles);
  if (fromDev && Object.keys(fromDevUpd).length > 0) {
    batch.update(doc(_db, 'devices', fromProf.deviceId), fromDevUpd);
  }
  if (crossDevice) {
    // Target device gains the cycles (its profileCount is unchanged - the target profile
    // already existed). Same-device merges move nothing, so device/brand totals hold.
    if (visibleCycles > 0) batch.update(doc(_db, 'devices', toProf.deviceId), { cycleCount: increment(visibleCycles) });
    if (crossBrand && visibleCycles > 0) {
      batch.update(doc(_db, 'brands', fromDev.brand_lc), { cycleCount: increment(-visibleCycles) });
      if (toBrandExists) batch.update(doc(_db, 'brands', toDev.brand_lc), { cycleCount: increment(visibleCycles) });
    }
  }
  await batch.commit();

  await _closeOrphanedReports(`profiles/${fromId}`);
  return { id: toId, crossDevice, cycles: cycSnap.docs.length };
}

// ------------------------------------------------------------------
// Admin rename / merge (ID migration)
//
// IDs are derived from names (deviceId = type__brand__model, profileId = deviceId__program),
// so renaming a brand/model/program changes the doc id: the doc must be RE-CREATED under the
// new id with its fields preserved (status, createdByUid, createdAt, counters), its children
// re-pointed, and the old doc deleted. Faithful field preservation relies on the admin
// `allow create` rule. Reads use the SDK (getDoc/getDocs) so Firestore Timestamps round-trip
// intact when written back. Writes follow the same "idempotent first, structural last"
// split as the merge helpers above, so an oversized device re-ids in chunks instead of
// failing the whole batch on Firestore's 500-write cap.
// ------------------------------------------------------------------

// Re-create a device (and cascade its profiles + cycles) under `newId`, applying `patch`
// (model/model_lc and/or brand/brand_lc changes) to the device and propagating the derived
// brand_lc + new profile ids to children. Caller guarantees `newId` does not already exist
// (collisions route through adminMergeDevices instead). Parent brand counters are only
// adjusted on a cross-brand move; same-brand re-id leaves every count unchanged.
async function _reidDevice(oldId, newId, dev, patch) {
  const [profSnap, cycSnap] = await Promise.all([
    getDocs(query(collection(_db, 'profiles'), where('deviceId', '==', oldId))),
    getDocs(query(collection(_db, 'cycles'), where('deviceId', '==', oldId))),
  ]);
  const brandLcNew = patch.brand_lc || dev.brand_lc;
  const brandChanged = !!patch.brand_lc && patch.brand_lc !== dev.brand_lc;
  const remap = {};
  for (const p of profSnap.docs) {
    const pd = p.data();
    remap[p.id] = mkProfileId(newId, pd.program || pd.program_lc || '');
  }
  // Phase 1 (chunked, idempotent): re-point every cycle at the new device + profile ids.
  await _commitChunked(cycSnap.docs.map((c) => {
    const cd = c.data();
    const upd = { deviceId: newId, profileId: remap[cd.profileId] || mkProfileId(newId, cd.program_lc || '') };
    if (brandChanged) upd.brand_lc = brandLcNew;
    return { ref: doc(_db, 'cycles', c.id), data: upd };
  }));
  // Phase 2 (single atomic batch): re-create the device + profiles under the new ids,
  // rebalance brand counters, delete the originals.
  _assertAtomic(profSnap.docs.length * 2 + 3, 'This device');
  const batch = writeBatch(_db);
  batch.set(doc(_db, 'devices', newId), { ...dev, ...patch });
  batch.delete(doc(_db, 'devices', oldId));
  for (const p of profSnap.docs) {
    batch.set(doc(_db, 'profiles', remap[p.id]), { ...p.data(), deviceId: newId });
    batch.delete(doc(_db, 'profiles', p.id));
  }
  // Cross-brand: rebalance brand-level denormalized counters (best-effort, like the merge
  // helpers). Same-brand model rename touches no brand, so counts stay exact untouched.
  if (brandChanged) {
    const visibleCycles = cycSnap.docs.filter((c) => _isVisible(c.data().status)).length;
    // Combine into a single batch.update — Firestore batches must not write the same doc twice.
    const brandLoss = {};
    if (_isVisible(dev.status)) brandLoss.deviceCount = increment(-1);
    if (_isApproved(dev.status)) brandLoss.approvedDeviceCount = increment(-1);
    if (visibleCycles > 0) brandLoss.cycleCount = increment(-visibleCycles);
    if (Object.keys(brandLoss).length) batch.update(doc(_db, 'brands', dev.brand_lc), brandLoss);
    // Target brand gains are applied by the caller (it knows the target brand doc exists).
  }
  await batch.commit();
  // The old device doc is gone: carry its confirmations / ratings / reports over to the new
  // id so a rename does not silently drop them (and cannot be inherited by a future
  // re-contribution at the old id).
  await _migrateDeviceSubdocs(oldId, newId);
  return { profiles: profSnap.docs.length, cycles: cycSnap.docs.length,
    visibleCycles: cycSnap.docs.filter((c) => _isVisible(c.data().status)).length };
}

// Rename a device's model. New deviceId = type__brand__newModel. If the renamed model
// already exists it is really a merge, so we delegate to adminMergeDevices. Returns
// { id, merged }.
export async function adminRenameDevice(deviceId, newModel) {
  const model = String(newModel || '').trim();
  if (!model) throw new Error('Model name is required');
  const snap = await getDoc(doc(_db, 'devices', deviceId));
  if (!snap.exists()) throw new Error('Device not found');
  const dev = snap.data();
  const newId = mkDeviceId(dev.applianceType, dev.brand, model);
  if (newId === deviceId) {
    await updateDoc(doc(_db, 'devices', deviceId), { model, model_lc: lc(model) });
    return { id: deviceId, merged: false };
  }
  if ((await getDoc(doc(_db, 'devices', newId))).exists()) {
    await adminMergeDevices(deviceId, newId);
    return { id: newId, merged: true };
  }
  await _reidDevice(deviceId, newId, dev, { model, model_lc: lc(model) });
  return { id: newId, merged: false };
}

// Rename a profile's program. New profileId = deviceId__newProgram. If a profile already
// exists at the new id, its cycles are absorbed and it is relabelled to the new program.
export async function adminRenameProfile(profileId, newProgram) {
  const program = String(newProgram || '').trim();
  if (!program) throw new Error('Program name is required');
  const snap = await getDoc(doc(_db, 'profiles', profileId));
  if (!snap.exists()) throw new Error('Profile not found');
  const prof = snap.data();
  const newId = mkProfileId(prof.deviceId, program);
  const patch = { program, program_lc: lc(program) };
  if (newId === profileId) {
    await updateDoc(doc(_db, 'profiles', profileId), patch);
    return { id: profileId, merged: false };
  }
  const targetExists = (await getDoc(doc(_db, 'profiles', newId))).exists();
  const cycSnap = await getDocs(query(collection(_db, 'cycles'), where('profileId', '==', profileId)));
  const batch = writeBatch(_db);
  for (const c of cycSnap.docs) batch.update(doc(_db, 'cycles', c.id), { profileId: newId, program_lc: lc(program) });
  batch.delete(doc(_db, 'profiles', profileId));
  if (targetExists) {
    // Combine relabel + cycleCount into one update — Firestore batches must not write the same doc twice.
    const vis = cycSnap.docs.filter((c) => _isVisible(c.data().status)).length;
    batch.update(doc(_db, 'profiles', newId), { ...patch, ...(vis > 0 ? { cycleCount: increment(vis) } : {}) });
    if (_isVisible(prof.status)) batch.update(doc(_db, 'devices', prof.deviceId), { profileCount: increment(-1) });
  } else {
    batch.set(doc(_db, 'profiles', newId), { ...prof, ...patch }); // faithful re-id; counts carry over
  }
  await batch.commit();
  // The old profile id is gone. On a merge its reports are about an object that no longer
  // exists (close them); on a re-id the same object just moved, so carry them across.
  if (targetExists) await _closeOrphanedReports(`profiles/${profileId}`);
  else await _migrateProfileReports(profileId, newId);
  return { id: newId, merged: targetExists };
}

// Rename a brand's display name WITHOUT changing its lowercase key (e.g. a capitalisation
// or trailing-space fix). IDs are stable, so this is a pure field patch on the brand doc and
// every device's denormalized `brand` display field.
async function _renameBrandDisplay(brandLc, brand) {
  const devSnap = await getDocs(query(collection(_db, 'devices'), where('brand_lc', '==', brandLc)));
  const ops = [
    { ref: doc(_db, 'brands', brandLc), data: { brand } },
    ...devSnap.docs.map((d) => ({ ref: doc(_db, 'devices', d.id), data: { brand } })),
  ];
  const BATCH = 400;
  for (let i = 0; i < ops.length; i += BATCH) {
    const batch = writeBatch(_db);
    for (const { ref, data } of ops.slice(i, i + BATCH)) batch.update(ref, data);
    await batch.commit();
  }
  return { id: brandLc, merged: false, renamed: true };
}

// Merge every device under `fromLc` into the `toBrandName` namespace (also used for a
// cross-lowercase brand rename, where the target brand may not exist yet -- e.g. "bosh" ->
// "Bosch"). Each device is migrated to its new brand-derived id (merged if that id already
// exists, else re-id'd), and the source brand doc is removed once it is empty.
//
// Unlike the device/profile merges this is NOT atomic -- it is a loop of per-device
// operations, because each device may need a full cascade. A failure part-way leaves the
// source brand in place with some devices already moved, so the operation is re-runnable;
// what it can leave behind is brand-level counter drift, which "Recalculate counts" fixes
// exactly. The returned `moved`/`merged`/`failed` tallies say what actually happened.
export async function adminMergeBrands(fromLc, toBrandName) {
  const brand = assertBrandMergeOk(fromLc, toBrandName);
  const toLc = lc(brand);
  if (toLc === fromLc) return _renameBrandDisplay(fromLc, brand);

  // Create the target brand doc UP FRONT. Per-device work credits the target's counters, and
  // those writes ride inside atomic batches that would fail as a whole against a missing doc
  // (reachable in practice: brand ids are lc(name) while device ids use normalizeToken, so a
  // device namespace can exist with no brand doc behind it).
  const [srcSnap0, tgtSnap0] = await Promise.all([
    getDoc(doc(_db, 'brands', fromLc)),
    getDoc(doc(_db, 'brands', toLc)),
  ]);
  if (!tgtSnap0.exists()) {
    const src = srcSnap0.exists() ? srcSnap0.data() : {};
    // A pure rename into a new key inherits the source's identity but starts its counters at
    // the source's values; the per-device credits below then apply on top, so zero them.
    await setDoc(doc(_db, 'brands', toLc), {
      ...src, brand, brand_lc: toLc, deviceCount: 0, cycleCount: 0, approvedDeviceCount: 0,
      // Provenance for the approved-device rule check; it refers to a device under the old
      // brand namespace, so it does not carry over to a freshly keyed brand.
      lastApprovedDeviceId: null,
    });
  }

  const devSnap = await getDocs(query(collection(_db, 'devices'), where('brand_lc', '==', fromLc)));
  let merged = 0;
  let moved = 0;
  const failed = [];
  for (const d of devSnap.docs) {
    const dev = d.data();
    try {
      const newDevId = mkDeviceId(dev.applianceType, brand, dev.model);
      if (newDevId === d.id) {
        // Device ID is unchanged (normalizeToken of old/new brand resolves the same slug).
        // Still need to update cycles' brand_lc, which lags behind the lowercased key.
        await updateDoc(doc(_db, 'devices', d.id), { brand, brand_lc: toLc });
        const devCycSnap = await getDocs(query(collection(_db, 'cycles'), where('deviceId', '==', d.id)));
        await _commitChunked(devCycSnap.docs.map(
          (c) => ({ ref: doc(_db, 'cycles', c.id), data: { brand_lc: toLc } })));
        // The device and its cycles changed brand key, so the target brand must gain them
        // (the source brand doc is deleted below, so its stale totals go with it).
        const gains = {};
        if (_isVisible(dev.status)) gains.deviceCount = increment(1);
        if (_isApproved(dev.status)) gains.approvedDeviceCount = increment(1);
        const visible = devCycSnap.docs.filter((c) => _isVisible(c.data().status)).length;
        if (visible > 0) gains.cycleCount = increment(visible);
        if (Object.keys(gains).length) await updateDoc(doc(_db, 'brands', toLc), gains);
        moved += 1;
        continue;
      }
      if ((await getDoc(doc(_db, 'devices', newDevId))).exists()) {
        // adminMergeDevices does the cross-brand cycle relabel + both brands' cycle totals.
        await adminMergeDevices(d.id, newDevId);
        // It keeps the TARGET device's brand fields, which already name toLc; re-assert them
        // so a target that predates this rename cannot keep a stale display name.
        await updateDoc(doc(_db, 'devices', newDevId), { brand, brand_lc: toLc });
        merged += 1;
      } else {
        const res = await _reidDevice(d.id, newDevId, dev, { brand, brand_lc: toLc });
        // Target brand gains this device + its visible cycles (source loss applied in _reidDevice).
        const gains = {};
        if (_isVisible(dev.status)) gains.deviceCount = increment(1);
        if (_isApproved(dev.status)) gains.approvedDeviceCount = increment(1);
        if (res.visibleCycles > 0) gains.cycleCount = increment(res.visibleCycles);
        if (Object.keys(gains).length) await updateDoc(doc(_db, 'brands', toLc), gains);
        moved += 1;
      }
    } catch (e) {
      // One unmovable device must not abandon the rest half-done. Collect and report it.
      failed.push({ id: d.id, model: dev.model || d.id, error: e.message });
    }
  }

  // Remove the now-empty source brand -- but only if every device really left, otherwise the
  // survivors would be stranded under a brand that no longer exists.
  if (!failed.length) {
    if (srcSnap0.exists()) await deleteDoc(doc(_db, 'brands', fromLc));
    await _closeOrphanedReports(`brands/${fromLc}`);
  }
  return { id: toLc, moved, merged, failed };
}

// Rename a brand. A capitalisation-only change (same lowercase) is a pure display patch;
// changing the lowercase key routes through adminMergeBrands (which creates the new brand or
// merges into an existing one, e.g. "bosh" -> "Bosch").
export async function adminRenameBrand(brandLc, newName) {
  const brand = assertBrandMergeOk(brandLc, newName);
  if (lc(brand) === brandLc) return _renameBrandDisplay(brandLc, brand);
  return adminMergeBrands(brandLc, brand);
}

// Move a reference cycle to a different profile (fix a mislabelled program). Re-points the
// cycle's profileId + program_lc and rebalances both profiles' cycleCount. Within one device
// the device/brand cycle totals are unchanged; a cross-device move (same appliance type)
// also re-points deviceId / brand_lc / applianceType and rebalances those totals.
export async function adminMoveCycle(cycleId, toProfileId) {
  const [cycSnap, profSnap] = await Promise.all([
    getDoc(doc(_db, 'cycles', cycleId)),
    getDoc(doc(_db, 'profiles', toProfileId)),
  ]);
  const cyc = cycSnap.exists() ? cycSnap.data() : null;
  const prof = profSnap.exists() ? profSnap.data() : null;
  // A cycle filed under the wrong device (e.g. uploaded through a misspelled brand) may move
  // to a profile on ANOTHER device, as long as the appliance type matches; then its device /
  // brand / appliance-type labels and all three counter levels move with it.
  const crossDevice = !!(cyc && prof && cyc.deviceId !== prof.deviceId);
  const [fromDev, toDev] = crossDevice ? await Promise.all([
    cyc.deviceId ? restGet(`devices/${cyc.deviceId}`, { auth: true, noStore: true }) : null,
    prof.deviceId ? restGet(`devices/${prof.deviceId}`, { auth: true, noStore: true }) : null,
  ]) : [null, null];
  const check = assertCycleMoveOk(cycleId, toProfileId, cyc, prof, fromDev, toDev);
  if (!check.moved) return { id: cycleId, moved: false };
  const crossBrand = !!(check.crossDevice && fromDev?.brand_lc && toDev?.brand_lc
    && fromDev.brand_lc !== toDev.brand_lc);
  const toBrandExists = crossBrand
    ? (await getDoc(doc(_db, 'brands', toDev.brand_lc))).exists() : false;
  const upd = {
    profileId: toProfileId,
    program_lc: prof.program_lc || lc(prof.program || ''),
  };
  if (check.crossDevice) {
    upd.deviceId = prof.deviceId;
    if (crossBrand) upd.brand_lc = toDev.brand_lc;
    if (toDev?.applianceType) upd.applianceType = toDev.applianceType;
  }
  const batch = writeBatch(_db);
  batch.update(doc(_db, 'cycles', cycleId), upd);
  if (_isVisible(cyc.status)) {
    if (cyc.profileId) batch.update(doc(_db, 'profiles', cyc.profileId), { cycleCount: increment(-1) });
    batch.update(doc(_db, 'profiles', toProfileId), { cycleCount: increment(1) });
    if (check.crossDevice) {
      if (cyc.deviceId) batch.update(doc(_db, 'devices', cyc.deviceId), { cycleCount: increment(-1) });
      batch.update(doc(_db, 'devices', prof.deviceId), { cycleCount: increment(1) });
      if (crossBrand) {
        batch.update(doc(_db, 'brands', fromDev.brand_lc), { cycleCount: increment(-1) });
        if (toBrandExists) batch.update(doc(_db, 'brands', toDev.brand_lc), { cycleCount: increment(1) });
      }
    }
  }
  await batch.commit();
  return { id: cycleId, moved: true, crossDevice: check.crossDevice };
}

// Fresh count of open report documents across every `reports` subcollection (collection
// group). Used to keep the moderation badge + dashboard card current without re-reading the
// whole stats bundle. Returns 0 on any failure (never throws).
export async function adminCountOpenReports() {
  try {
    return await restCount('reports', [{ field: 'status', op: 'EQUAL', value: 'open' }], { auth: true, allDescendants: true });
  } catch (_) {
    return 0;
  }
}

export async function adminListUsers({ pageSize = 50, cursor = null, status = null } = {}) {
  // A status equality filter (e.g. banned-only) drops the createdAt ordering so it needs
  // only the automatic single-field index -- no composite index/deploy. Those views load a
  // single (large) batch rather than paginating, which is fine for the small banned set.
  const items = await restQuery('users', {
    filters: status ? [{ field: 'status', op: 'EQUAL', value: status }] : [],
    orderBy: status ? [] : [{ field: 'createdAt', dir: 'DESCENDING' }],
    limit: pageSize,
    startAfter: (!status && cursor) ? [cursor] : null,
    auth: true,
  });
  const next = (!status && items.length === pageSize) ? items[items.length - 1].createdAt : null;
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
  const [dev, profSnap, cycSnap] = await Promise.all([
    restGet(`devices/${deviceId}`, { auth: true, noStore: true }),
    getDocs(query(collection(_db, 'profiles'), where('deviceId', '==', deviceId))),
    getDocs(query(collection(_db, 'cycles'), where('deviceId', '==', deviceId))),
  ]);
  const batch = writeBatch(_db);
  for (const p of profSnap.docs) batch.delete(doc(_db, 'profiles', p.id));
  for (const c of cycSnap.docs) batch.delete(doc(_db, 'cycles', c.id));
  batch.delete(doc(_db, 'devices', deviceId));
  if (dev?.brand_lc) {
    const brandUpdate = {};
    if (_isVisible(dev.status)) brandUpdate.deviceCount = increment(-1);
    if (_isApproved(dev.status)) brandUpdate.approvedDeviceCount = increment(-1);
    const visibleCycles = cycSnap.docs.filter((c) => _isVisible(c.data().status)).length;
    if (visibleCycles > 0) brandUpdate.cycleCount = increment(-visibleCycles);
    if (Object.keys(brandUpdate).length > 0) batch.update(doc(_db, 'brands', dev.brand_lc), brandUpdate);
  }
  await batch.commit();
}

// Hard-delete a brand document.
export async function adminDeleteBrand(brandId) {
  await deleteDoc(doc(_db, 'brands', brandId));
}

// Hard-delete a profile and all its reference cycles.
export async function adminDeleteProfile(profileId) {
  const [prof, cycSnap] = await Promise.all([
    restGet(`profiles/${profileId}`, { auth: true, noStore: true }),
    getDocs(query(collection(_db, 'cycles'), where('profileId', '==', profileId))),
  ]);
  const dev = prof?.deviceId ? await restGet(`devices/${prof.deviceId}`, { auth: true, noStore: true }) : null;
  const visibleCycles = cycSnap.docs.filter((c) => _isVisible(c.data().status)).length;
  const batch = writeBatch(_db);
  for (const c of cycSnap.docs) batch.delete(doc(_db, 'cycles', c.id));
  batch.delete(doc(_db, 'profiles', profileId));
  if (prof?.deviceId) {
    const devUpdate = {};
    if (_isVisible(prof.status)) devUpdate.profileCount = increment(-1);
    if (visibleCycles > 0) devUpdate.cycleCount = increment(-visibleCycles);
    if (Object.keys(devUpdate).length > 0) batch.update(doc(_db, 'devices', prof.deviceId), devUpdate);
  }
  if (dev?.brand_lc && visibleCycles > 0) {
    batch.update(doc(_db, 'brands', dev.brand_lc), { cycleCount: increment(-visibleCycles) });
  }
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
    ...devSnap.docs.map((d) => ({ ref: doc(_db, 'devices', d.id), data: { createdByUid: null, createdByName: null } })),
    ...profSnap.docs.map((p) => ({ ref: doc(_db, 'profiles', p.id), data: { createdByUid: null, createdByName: null } })),
    ...cycSnap.docs.map((c) => ({ ref: doc(_db, 'cycles', c.id), data: { uploaderUid: null, uploaderName: null } })),
  ];
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const batch = writeBatch(_db);
    for (const { ref, data } of ops.slice(i, i + BATCH_SIZE)) batch.update(ref, data);
    await batch.commit();
  }
  await deleteDoc(doc(_db, 'users', uid));
}

// One-time (or on-demand) backfill: recompute and store the denormalized deviceCount,
// profileCount, and cycleCount fields on every brand, device, and profile doc. Run this
// once after deploying the stored-counter feature to populate existing documents. Safe to
// run multiple times (idempotent: always overwrites with the correct value).
// Bounded-concurrency map: run `fn` over `items` with at most `limit` in flight, so a full
// recount doesn't fire thousands of parallel aggregation fetches.
async function _mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 0) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

// ratingSum is stored as an INTEGER (round of avg*count) so subsequent rating writes can
// maintain it with integer increment(); avg is derived on read as sum/count.
function _ratingFields(r) {
  const count = (r && r.count) || 0;
  const sum = (r && r.avg != null && count > 0) ? Math.round(r.avg * count) : 0;
  return { ratingCount: count, ratingSum: sum };
}

export async function adminRecount() {
  const LIMIT = 5000;
  const [brands, devices, profiles, cycles] = await Promise.all([
    restQuery('brands', { limit: LIMIT, auth: true }),
    restQuery('devices', { limit: LIMIT, auth: true }),
    restQuery('profiles', { limit: LIMIT, auth: true }),
    restQuery('cycles', { limit: LIMIT, auth: true }),
  ]);

  const vis = (s) => s === 'pending' || s === 'approved';

  // Tally counts grouped by parent key
  const devByBrand = {}, apprDevByBrand = {}, cycByBrand = {}, cycByDevice = {}, cycByProfile = {}, profByDevice = {};
  for (const d of devices) {
    if (!d.brand_lc) continue;
    if (vis(d.status)) devByBrand[d.brand_lc] = (devByBrand[d.brand_lc] || 0) + 1;
    // Approved-only tally: this is what gates brand auto-approval, so it must be exact.
    if (d.status === 'approved') apprDevByBrand[d.brand_lc] = (apprDevByBrand[d.brand_lc] || 0) + 1;
  }
  for (const c of cycles) {
    if (!vis(c.status)) continue;
    if (c.brand_lc) cycByBrand[c.brand_lc] = (cycByBrand[c.brand_lc] || 0) + 1;
    if (c.deviceId) cycByDevice[c.deviceId] = (cycByDevice[c.deviceId] || 0) + 1;
    if (c.profileId) cycByProfile[c.profileId] = (cycByProfile[c.profileId] || 0) + 1;
  }
  for (const p of profiles) if (vis(p.status) && p.deviceId) profByDevice[p.deviceId] = (profByDevice[p.deviceId] || 0) + 1;

  // Backfill the denormalized rating aggregate onto every cycle + device from its ratings
  // subcollection (bounded fan-out). After this, cycle/device cards and the derived profile
  // rating read the aggregate straight off the doc instead of one aggregation query per card.
  const cycleRatings = await _mapLimited(cycles, 8, (c) => restRatingSummary(c.id).catch(() => ({ avg: null, count: 0 })));
  const deviceRatings = await _mapLimited(devices, 8, (d) => restDeviceRating(d.id).catch(() => ({ avg: null, count: 0 })));

  // Build update ops for every document
  const ops = [
    ...brands.map((b) => ({ ref: doc(_db, 'brands', b.id), data: { deviceCount: devByBrand[b.brand_lc] || 0, cycleCount: cycByBrand[b.brand_lc] || 0, approvedDeviceCount: apprDevByBrand[b.brand_lc] || 0 } })),
    ...devices.map((d, i) => ({ ref: doc(_db, 'devices', d.id), data: { profileCount: profByDevice[d.id] || 0, cycleCount: cycByDevice[d.id] || 0, ..._ratingFields(deviceRatings[i]) } })),
    ...profiles.map((p) => ({ ref: doc(_db, 'profiles', p.id), data: { cycleCount: cycByProfile[p.id] || 0 } })),
    ...cycles.map((c, i) => ({ ref: doc(_db, 'cycles', c.id), data: _ratingFields(cycleRatings[i]) })),
  ];

  const BATCH = 400;
  for (let i = 0; i < ops.length; i += BATCH) {
    const batch = writeBatch(_db);
    for (const { ref, data } of ops.slice(i, i + BATCH)) batch.update(ref, data);
    await batch.commit();
  }
  return { brands: brands.length, devices: devices.length, profiles: profiles.length, cycles: cycles.length, updated: ops.length };
}

export async function adminGetStats() {
  const c = (coll, s) => restCount(coll, [{ field: 'status', op: 'EQUAL', value: s }], { auth: true });
  const total = (coll) => restCount(coll, [], { auth: true });
  // Pending / Approved / Removed all span the WHOLE catalog (brands + devices + profiles +
  // cycles), not just cycles -- otherwise "Approved" reads 0 on a store that has approved
  // devices/profiles but no approved cycles. Each is returned with a per-type breakdown too.
  // `rejected` is cycle-only (only cycles carry a 'rejected' state; brands/devices/profiles
  // are pending/approved/removed).
  const byType = async (s) => {
    const [brands, devices, profiles, cycles] = await Promise.all([c('brands', s), c('devices', s), c('profiles', s), c('cycles', s)]);
    return { brands, devices, profiles, cycles, total: brands + devices + profiles + cycles };
  };
  const [
    pendingB, approvedB, removedB, rejected, bannedUsers,
    totalUsers, totalBrands, totalDevices, totalProfiles, totalCycles, openReports,
  ] = await Promise.all([
    byType('pending'), byType('approved'), byType('removed'),
    c('cycles', 'rejected'),
    restCount('users', [{ field: 'status', op: 'EQUAL', value: 'banned' }], { auth: true }),
    total('users'), total('brands'), total('devices'), total('profiles'), total('cycles'),
    // Open reports span every `reports` subcollection (collection-group count).
    restCount('reports', [{ field: 'status', op: 'EQUAL', value: 'open' }], { auth: true, allDescendants: true }),
  ]);
  return {
    pending: pendingB.total, pendingByType: pendingB,
    approved: approvedB.total, approvedByType: approvedB,
    removed: removedB.total, removedByType: removedB,
    rejected, bannedUsers,
    totalUsers, totalBrands, totalDevices, totalProfiles, totalCycles, openReports,
  };
}

// ------------------------------------------------------------------
// Content reports (community moderation)
// ------------------------------------------------------------------

// Build the Firestore path of a reportable object. `targetType` is one of REPORT_TARGET_TYPES.
// For comments, `parentCycleId` locates the parent cycle (comments live under cycles).
export function reportTargetPath(targetType, targetId, parentCycleId = null) {
  switch (targetType) {
    case 'brand': return `brands/${targetId}`;
    case 'device': return `devices/${targetId}`;
    case 'profile': return `profiles/${targetId}`;
    case 'cycle': return `cycles/${targetId}`;
    case 'comment': return `cycles/${parentCycleId}/comments/${targetId}`;
    default: throw new Error('Unknown report target type');
  }
}

// Submit a report against an object. One report per user per object: the doc id is the
// reporter's uid, so a second report on the same object from the same user is denied by
// the rules (create-only). `targetLabel` is a denormalized display hint for the queue.
export async function submitReport({
  targetType, targetId, parentCycleId = null, targetLabel = null,
  targetCreatedByUid = null, reason = 'other', comment,
}) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const text = (comment || '').trim();
  if (!text) throw new Error('Please describe the problem');
  if (!REPORT_TARGET_TYPES.includes(targetType)) throw new Error('Unknown report target type');
  _rateGuard();
  const targetPath = reportTargetPath(targetType, targetId, parentCycleId);
  const ref = doc(_db, `${targetPath}/reports/${user.uid}`);
  await setDoc(ref, {
    reporterUid: user.uid,
    // Cap at the rule's optName() limit so a long GitHub display name can't get the whole
    // report rejected.
    reporterName: user.displayName ? String(user.displayName).slice(0, 100) : null,
    reason: String(reason).slice(0, 40),
    comment: text.slice(0, 1000),
    targetType,
    targetId,
    targetPath,
    parentCycleId: parentCycleId || null,
    targetLabel: targetLabel ? String(targetLabel).slice(0, 200) : null,
    targetCreatedByUid: targetCreatedByUid || null,
    status: 'open',
    createdAt: serverTimestamp(),
  });
}

// Has the signed-in user already reported this object? (Drives the "already reported" UI.)
export async function hasReported(targetPath) {
  const user = _auth.currentUser;
  if (!user) return false;
  const rec = await restGet(`${targetPath}/reports/${user.uid}`, { auth: true });
  return !!rec;
}

// Admin review queue: every open report across all object types, newest first
// (collection-group query). Grouped per object client-side.
export async function adminListReports({ status = 'open', pageSize = 60, cursor = null } = {}) {
  const filters = [];
  if (status) filters.push({ field: 'status', op: 'EQUAL', value: status });
  const items = await restQuery('reports', {
    allDescendants: true,
    filters,
    orderBy: [{ field: 'createdAt', dir: 'DESCENDING' }],
    limit: pageSize,
    startAfter: cursor ? [cursor] : null,
    auth: true,
  });
  const next = items.length === pageSize ? items[items.length - 1].createdAt : null;
  return { items, cursor: next };
}

// All reports filed against one object (full consolidation, independent of queue paging).
export async function getReportsForTarget(targetPath) {
  return restQuery('reports', {
    parent: targetPath,
    orderBy: [{ field: 'createdAt', dir: 'ASCENDING' }],
    auth: true,
  });
}

// Resolve every report on an object (admin). `resolution` is 'removed' | 'deleted' |
// 'dismissed'. Batched so many reporters on one object collapse to one write round-trip.
export async function adminResolveReports(targetPath, resolution) {
  const user = _auth.currentUser;
  const reports = await getReportsForTarget(targetPath);
  if (!reports.length) return 0;
  const stamp = { status: 'resolved', resolution, resolvedAt: serverTimestamp(), resolvedBy: user ? user.uid : null };
  const BATCH = 400;
  for (let i = 0; i < reports.length; i += BATCH) {
    const batch = writeBatch(_db);
    // r.id is the report doc's real id (== reporterUid); prefer it over the stored field.
    for (const r of reports.slice(i, i + BATCH)) {
      batch.update(doc(_db, `${targetPath}/reports/${r.id || r.reporterUid}`), stamp);
    }
    await batch.commit();
  }
  return reports.length;
}

// Repeat-offender strike counter: bump the creator's removedContentCount whenever one of
// their contributions is removed. Best-effort -- a missing/anonymous creator user doc is
// skipped silently (it must not break the removal itself).
export async function adminRecordRemoval(creatorUid) {
  if (!creatorUid) return;
  try {
    await updateDoc(doc(_db, 'users', creatorUid), {
      removedContentCount: increment(1),
      lastRemovalAt: serverTimestamp(),
    });
  } catch (_) { /* creator has no user doc (anonymized/deleted) -- skip */ }
}

// Load any reportable object by its stored path (admin-authed read). Used by the review
// queue to show the object's live status + real creator before acting on it.
export async function adminGetByPath(targetPath) {
  return restGet(targetPath, { auth: true, noStore: true });
}
