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
  getCountFromServer,
  runTransaction,
  writeBatch,
  collectionGroup,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

export const STORE_SCHEMA_VERSION = 1;
export const ENVELOPE_SCHEMA_VERSION = 1;
export const ENVELOPE_SCHEMA_VERSIONS = {
  1: { fields: ['avg', 'min', 'max', 'target_duration', 'avg_energy', 'duration_std_dev', 'cycle_count'] },
};

let _app = null;
let _auth = null;
let _db = null;

export function init(config) {
  _app = initializeApp(config);
  _auth = getAuth(_app);
  _db = getFirestore(_app);
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

export async function ensureUserProfile(user) {
  const ref = doc(_db, 'users', user.uid);
  const snap = await getDoc(ref);
  const now = serverTimestamp();
  if (!snap.exists()) {
    await setDoc(ref, {
      uid: user.uid,
      displayName: user.displayName || null,
      photoURL: user.photoURL || null,
      createdAt: now,
      lastSeen: now,
      banned: false,
      banReason: null,
    }, { merge: true });
  } else {
    await updateDoc(ref, { lastSeen: now });
  }
}

export function downsampleCycle(points, max = 3000) {
  if (!Array.isArray(points) || points.length <= max) return points;
  const step = points.length / max;
  const result = [];
  for (let i = 0; i < max; i++) {
    result.push(points[Math.floor(i * step)]);
  }
  return result;
}

export function parseCycle(text) {
  if (!text || !text.trim()) throw new Error('Empty input');
  const trimmed = text.trim();

  // Try JSON first
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      // Array of [t,v] pairs or array of objects
      if (parsed.length === 0) throw new Error('Empty array');
      if (Array.isArray(parsed[0])) return parsed;
      // Array of {t, v} or {time, value} objects
      return parsed.map((p) => {
        const t = p.t ?? p.time ?? p.x ?? 0;
        const v = p.v ?? p.value ?? p.y ?? p.power ?? 0;
        return [t, v];
      });
    }
    if (typeof parsed === 'object' && parsed !== null) {
      // {times: [...], values: [...]} or similar
      const times = parsed.times ?? parsed.t ?? parsed.x ?? [];
      const values = parsed.values ?? parsed.v ?? parsed.y ?? parsed.power ?? [];
      if (!Array.isArray(times) || !Array.isArray(values)) {
        throw new Error('Unrecognised object structure');
      }
      return times.map((t, i) => [t, values[i] ?? 0]);
    }
    throw new Error('Unrecognised JSON structure');
  }

  // CSV/TSV
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length === 0) throw new Error('No data rows');
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const result = [];
  for (const line of lines) {
    const parts = line.split(sep).map((s) => s.trim());
    if (parts.length < 2) continue;
    const t = parseFloat(parts[0]);
    const v = parseFloat(parts[1]);
    if (isNaN(t) || isNaN(v)) continue;
    result.push([t, v]);
  }
  if (result.length === 0) throw new Error('No valid numeric rows found');
  return result;
}

export function saveAsFile(record) {
  const brand = (record.brand_lc || record.brand || 'unknown').replace(/\s+/g, '_');
  const model = (record.model_lc || record.model || 'unknown').replace(/\s+/g, '_');
  const program = (record.program || 'unknown').replace(/\s+/g, '_');
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

export async function uploadEnvelope(meta, envelope, cyclePoints = null) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');

  const {
    applianceType,
    brand,
    model,
    program,
    sensor = '',
    metric = 'power_w',
    sampleIntervalSec,
    notes = null,
    envelopeSchemaVersion = ENVELOPE_SCHEMA_VERSION,
  } = meta;

  if (!applianceType || !brand || !model || !program || !sampleIntervalSec) {
    throw new Error('Missing required fields');
  }
  if (!['washer', 'dryer', 'dishwasher', 'washer_dryer'].includes(applianceType)) {
    throw new Error('Invalid applianceType');
  }
  if (typeof brand !== 'string' || brand.length < 1 || brand.length > 40) {
    throw new Error('brand must be 1-40 chars');
  }
  if (typeof model !== 'string' || model.length < 1 || model.length > 60) {
    throw new Error('model must be 1-60 chars');
  }
  if (typeof program !== 'string' || program.length < 1 || program.length > 60) {
    throw new Error('program must be 1-60 chars');
  }
  if (notes !== null && (typeof notes !== 'string' || notes.length > 500)) {
    throw new Error('notes must be null or string <= 500 chars');
  }
  if (typeof sampleIntervalSec !== 'number' || sampleIntervalSec <= 0 || sampleIntervalSec > 3600) {
    throw new Error('sampleIntervalSec must be number in (0, 3600]');
  }
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('envelope must be a map');
  }

  const cycleField = cyclePoints != null
    ? { points: downsampleCycle(cyclePoints) }
    : null;

  const docData = {
    schemaVersion: STORE_SCHEMA_VERSION,
    envelopeSchemaVersion,
    uploaderUid: user.uid,
    uploaderName: user.displayName || null,
    applianceType,
    brand,
    brand_lc: brand.toLowerCase(),
    model,
    model_lc: model.toLowerCase(),
    program,
    sensor,
    metric,
    sampleIntervalSec,
    notes: notes ?? null,
    envelope,
    cycle: cycleField,
    status: 'pending',
    downloads: 0,
    ratingCount: 0,
    commentCount: 0,
    avgRating: null,
    createdAt: serverTimestamp(),
  };

  if (_estimateDocSize(docData) > 800 * 1024) {
    throw new Error('Document exceeds 800KB size limit');
  }

  const ref = await addDoc(collection(_db, 'envelopes'), docData);
  return ref.id;
}

export async function listEnvelopes({ applianceType = null, brand = null, mine = false, pageSize = 24, cursor = null } = {}) {
  const constraints = [];

  if (mine) {
    const user = _auth.currentUser;
    if (!user) throw new Error('Not signed in');
    constraints.push(where('uploaderUid', '==', user.uid));
  } else {
    constraints.push(where('status', '==', 'approved'));
    if (applianceType) constraints.push(where('applianceType', '==', applianceType));
    if (brand) constraints.push(where('brand_lc', '==', brand.toLowerCase()));
  }

  constraints.push(orderBy('createdAt', 'desc'));
  constraints.push(limit(pageSize));

  if (cursor) constraints.push(startAfter(cursor));

  const q = query(collection(_db, 'envelopes'), ...constraints);
  const snap = await getDocs(q);
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const nextCursor = snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1] : null;
  return { items, cursor: nextCursor };
}

export async function getEnvelope(id) {
  const snap = await getDoc(doc(_db, 'envelopes', id));
  if (!snap.exists()) throw new Error('Envelope not found');
  return { id: snap.id, ...snap.data() };
}

export async function deleteEnvelope(id) {
  await deleteDoc(doc(_db, 'envelopes', id));
}

export async function bumpDownload(id) {
  try {
    await updateDoc(doc(_db, 'envelopes', id), { downloads: increment(1) });
  } catch (_) {
    // best-effort
  }
}

export async function addComment(envelopeId, text, parentId = null) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');

  const commentData = {
    authorUid: user.uid,
    authorName: user.displayName || null,
    text,
    createdAt: serverTimestamp(),
  };
  if (parentId != null) commentData.parentId = parentId;

  const batch = writeBatch(_db);
  const commentRef = doc(collection(_db, 'envelopes', envelopeId, 'comments'));
  batch.set(commentRef, commentData);
  batch.update(doc(_db, 'envelopes', envelopeId), { commentCount: increment(1) });
  await batch.commit();
  return commentRef.id;
}

export async function listComments(envelopeId, pageSize = 50) {
  const constraints = [orderBy('createdAt', 'asc'), limit(pageSize)];
  const q = query(collection(_db, 'envelopes', envelopeId, 'comments'), ...constraints);
  const snap = await getDocs(q);
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const nextCursor = snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1] : null;
  return { items, cursor: nextCursor };
}

export async function deleteComment(envelopeId, commentId) {
  const batch = writeBatch(_db);
  batch.delete(doc(_db, 'envelopes', envelopeId, 'comments', commentId));
  batch.update(doc(_db, 'envelopes', envelopeId), { commentCount: increment(-1) });
  await batch.commit();
}

export async function submitRating(envelopeId, rating) {
  const user = _auth.currentUser;
  if (!user) throw new Error('Not signed in');
  if (![1, 2, 3, 4, 5].includes(rating)) throw new Error('Rating must be 1-5');

  const ratingRef = doc(_db, 'envelopes', envelopeId, 'ratings', user.uid);
  const envelopeRef = doc(_db, 'envelopes', envelopeId);

  await runTransaction(_db, async (tx) => {
    const existingSnap = await tx.get(ratingRef);
    const envSnap = await tx.get(envelopeRef);
    if (!envSnap.exists()) throw new Error('Envelope not found');

    const { ratingCount = 0, avgRating = null } = envSnap.data();

    let newCount;
    let newAvg;

    if (existingSnap.exists()) {
      const oldRating = existingSnap.data().rating;
      newCount = ratingCount;
      newAvg = newCount > 1
        ? ((avgRating * ratingCount) - oldRating + rating) / ratingCount
        : rating;
    } else {
      newCount = ratingCount + 1;
      newAvg = avgRating == null
        ? rating
        : ((avgRating * ratingCount) + rating) / newCount;
    }

    tx.set(ratingRef, {
      uid: user.uid,
      rating,
      createdAt: existingSnap.exists() ? existingSnap.data().createdAt : serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    tx.update(envelopeRef, { avgRating: newAvg, ratingCount: newCount });
  });
}

export async function getUserRating(envelopeId) {
  const user = _auth.currentUser;
  if (!user) return null;
  const snap = await getDoc(doc(_db, 'envelopes', envelopeId, 'ratings', user.uid));
  return snap.exists() ? snap.data().rating : null;
}

export async function getRatings(envelopeId) {
  const snap = await getDocs(collection(_db, 'envelopes', envelopeId, 'ratings'));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

// Admin functions

export async function adminListEnvelopes({ status = null, applianceType = null, pageSize = 24, cursor = null } = {}) {
  const constraints = [];
  if (status) constraints.push(where('status', '==', status));
  if (applianceType) constraints.push(where('applianceType', '==', applianceType));
  constraints.push(orderBy('createdAt', 'desc'));
  constraints.push(limit(pageSize));
  if (cursor) constraints.push(startAfter(cursor));

  const q = query(collection(_db, 'envelopes'), ...constraints);
  const snap = await getDocs(q);
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const nextCursor = snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1] : null;
  return { items, cursor: nextCursor };
}

export async function adminUpdateStatus(id, status, reason = null) {
  const update = { status };
  if (reason != null) update.rejectionReason = reason;
  await updateDoc(doc(_db, 'envelopes', id), update);
}

export async function adminListUsers({ pageSize = 50, cursor = null } = {}) {
  const constraints = [orderBy('createdAt', 'desc'), limit(pageSize)];
  if (cursor) constraints.push(startAfter(cursor));
  const q = query(collection(_db, 'users'), ...constraints);
  const snap = await getDocs(q);
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const nextCursor = snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1] : null;
  return { items, cursor: nextCursor };
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

export async function adminDeleteComment(envelopeId, commentId) {
  await deleteComment(envelopeId, commentId);
}

export async function adminGetStats() {
  const envelopesCol = collection(_db, 'envelopes');
  const usersCol = collection(_db, 'users');

  const [pending, approved, rejected, removed, bannedUsers] = await Promise.all([
    getCountFromServer(query(envelopesCol, where('status', '==', 'pending'))),
    getCountFromServer(query(envelopesCol, where('status', '==', 'approved'))),
    getCountFromServer(query(envelopesCol, where('status', '==', 'rejected'))),
    getCountFromServer(query(envelopesCol, where('status', '==', 'removed'))),
    getCountFromServer(query(usersCol, where('banned', '==', true))),
  ]);

  return {
    pending: pending.data().count,
    approved: approved.data().count,
    rejected: rejected.data().count,
    removed: removed.data().count,
    bannedUsers: bannedUsers.data().count,
  };
}
