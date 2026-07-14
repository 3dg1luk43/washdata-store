import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  GithubAuthProvider,
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
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { deviceId as mkDeviceId, profileId as mkProfileId } from './lib/ids.js';
import { downsampleCycle, parseCycle, cycleStats } from './lib/trace.js';
import { restQuery, restGet, restRatingSummary, restCount, setTokenProvider } from './firestore-rest.js';

export { downsampleCycle, parseCycle, cycleStats };

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
  return signInWithPopup(_auth, provider);
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

export async function ensureUserProfile(user) {
  const ref = doc(_db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      uid: user.uid,
      displayName: user.displayName || null,
      photoURL: user.photoURL || null,
      createdAt: serverTimestamp(),
      lastSeen: serverTimestamp(),
      banned: false,
      banReason: null,
      favorites: [],
    }, { merge: true });
    return;
  }
  // Throttle lastSeen writes so ordinary browsing stays read-only. A write is what
  // opens the persistent Firestore write-channel; skipping it on most page loads keeps
  // a signed-in browser to one-shot read requests.
  const data = snap.data();
  const last = data.lastSeen && data.lastSeen.toMillis ? data.lastSeen.toMillis() : 0;
  if (Date.now() - last > _LASTSEEN_THROTTLE_MS) {
    await updateDoc(ref, { lastSeen: serverTimestamp() });
  }
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

export async function ensureBrand({ brand }) {
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
      createdAt: serverTimestamp(),
    });
  }
  return id;
}

export async function ensureDevice({ applianceType, brand, model }) {
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
      createdAt: serverTimestamp(),
      profileCount: 0,
      favoriteCount: 0,
    });
  }
  return id;
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
      cycleCount: 0,
    });
  }
  return id;
}

export async function getDevice(id) {
  const rec = await restGet(`devices/${id}`);
  if (!rec) throw new Error('Device not found');
  return rec;
}

// List approved brands, optional case-insensitive prefix search on brand_lc. REST read.
export async function listBrands({ search = null, pageSize = 60, cursor = null } = {}) {
  const filters = [{ field: 'status', op: 'EQUAL', value: 'approved' }];
  if (search) {
    const p = search.toLowerCase();
    filters.push({ field: 'brand_lc', op: 'GREATER_THAN_OR_EQUAL', value: p });
    filters.push({ field: 'brand_lc', op: 'LESS_THAN_OR_EQUAL', value: p + '\uf8ff' });
  }
  const items = await restQuery('brands', {
    filters,
    orderBy: [{ field: 'brand_lc', dir: 'ASCENDING' }],
    limit: pageSize,
    startAfter: cursor ? [cursor] : null,
  });
  const next = items.length === pageSize ? items[items.length - 1].brand_lc : null;
  return { items, cursor: next };
}

// Approved devices for a brand (used by brand -> devices browse and by upload autocomplete).
export async function getDevicesByBrand(brandLc, { applianceType = null, pageSize = 60, cursor = null } = {}) {
  return searchDevices({ brand: brandLc, applianceType, pageSize, cursor });
}

export async function searchDevices({ applianceType = null, brand = null, favoritesOnly = false, pageSize = 60 } = {}) {
  if (favoritesOnly) {
    const favs = await getFavorites();
    const items = [];
    for (const id of favs.slice(0, pageSize)) {
      const rec = await restGet(`devices/${id}`);
      if (rec) items.push(rec);
    }
    return { items, cursor: null };
  }
  const filters = [{ field: 'status', op: 'EQUAL', value: 'approved' }];
  if (applianceType) filters.push({ field: 'applianceType', op: 'EQUAL', value: applianceType });
  if (brand) filters.push({ field: 'brand_lc', op: 'EQUAL', value: brand.toLowerCase() });
  const items = await restQuery('devices', {
    filters,
    orderBy: [{ field: 'favoriteCount', dir: 'DESCENDING' }],
    limit: pageSize,
  });
  return { items, cursor: null };
}

export async function getProfiles(deviceId) {
  return restQuery('profiles', {
    filters: [
      { field: 'deviceId', op: 'EQUAL', value: deviceId },
      { field: 'status', op: 'EQUAL', value: 'approved' },
    ],
    orderBy: [{ field: 'createdAt', dir: 'DESCENDING' }],
    limit: 100,
  });
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
    trace: { points, sampleIntervalSec },
    stats: stats && typeof stats === 'object' ? stats : cycleStats(points),
    cycleSchemaVersion: CYCLE_SCHEMA_VERSION,
    downloads: 0,
    commentCount: 0,
    qc: qcCode,
    createdAt: serverTimestamp(),
  };

  if (_estimateDocSize(docData) > MAX_DOC_BYTES) {
    throw new Error(`Cycle exceeds the ${Math.round(MAX_DOC_BYTES / 1024)}KB size limit. Downsample the trace further.`);
  }

  const ref = await addDoc(collection(_db, 'cycles'), docData);
  return ref.id;
}

export async function getReferenceCycles(profileId, { pageSize = 24, cursor = null } = {}) {
  const cons = [
    where('profileId', '==', profileId),
    where('status', '==', 'approved'),
    orderBy('createdAt', 'desc'),
    limit(pageSize),
  ];
  if (cursor) cons.push(startAfter(cursor));
  const snap = await getDocs(query(collection(_db, 'cycles'), ...cons));
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { items, cursor: snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1] : null };
}

// A signed-in user's own uploaded cycles (any status).
export async function myCycles({ pageSize = 24, cursor = null } = {}) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const cons = [where('uploaderUid', '==', user.uid), orderBy('createdAt', 'desc'), limit(pageSize)];
  if (cursor) cons.push(startAfter(cursor));
  const snap = await getDocs(query(collection(_db, 'cycles'), ...cons));
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { items, cursor: snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1] : null };
}

export async function getCycle(id) {
  const rec = await restGet(`cycles/${id}`);
  if (!rec) throw new Error('Cycle not found');
  return rec;
}

export async function deleteCycle(id) {
  await deleteDoc(doc(_db, 'cycles', id));
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
  const items = await restQuery('cycles', {
    filters,
    orderBy: [{ field: 'createdAt', dir: 'DESCENDING' }],
    limit: pageSize,
    startAfter: cursor ? [cursor] : null,
    auth: true,
  });
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
    banned: true,
    banReason: reason,
    bannedAt: serverTimestamp(),
    bannedBy: user.uid,
  });
}

export async function adminUnbanUser(uid) {
  await updateDoc(doc(_db, 'users', uid), {
    banned: false,
    banReason: null,
    bannedAt: null,
    bannedBy: null,
  });
}

export async function adminDeleteComment(cycleId, commentId) {
  await deleteComment(cycleId, commentId);
}

export async function adminGetStats() {
  const st = (s) => restCount('cycles', [{ field: 'status', op: 'EQUAL', value: s }], { auth: true });
  const [pending, approved, rejected, removed, bannedUsers] = await Promise.all([
    st('pending'), st('approved'), st('rejected'), st('removed'),
    restCount('users', [{ field: 'banned', op: 'EQUAL', value: true }], { auth: true }),
  ]);
  return { pending, approved, rejected, removed, bannedUsers };
}
