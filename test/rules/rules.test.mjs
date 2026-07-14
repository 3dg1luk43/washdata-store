// Firestore rules unit tests. Requires the emulator + Java:
//   npm run test:rules
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, updateDoc, writeBatch, getDoc } from 'firebase/firestore';

let env;
const PID = 'washdata-store';

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env.cleanup(); });

function gh(uid) { return env.authenticatedContext(uid, { firebase: { sign_in_provider: 'github.com' } }); }
function anon() { return env.unauthenticatedContext(); }

const validCycle = (uid) => ({
  profileId: 'washer__bosch__wat__cotton-40', deviceId: 'washer__bosch__wat',
  brand_lc: 'bosch', program_lc: 'cotton-40', applianceType: 'washer',
  uploaderUid: uid, uploaderName: 'x', status: 'pending', rejectionReason: null,
  trace: { points: [[0, 1], [5, 100]], sampleIntervalSec: 5 },
  stats: { duration: 3600, energy_wh: 800, peak_w: 2000, mean_w: 200, signature: {} },
  cycleSchemaVersion: 1, downloads: 0, commentCount: 0, qc: 1,
  createdAt: new Date(),
});

test('github user can create a pending cycle; anon cannot', async () => {
  await assertSucceeds(setDoc(doc(gh('u1').firestore(), 'cycles/c1'), validCycle('u1')));
  await assertFails(setDoc(doc(anon().firestore(), 'cycles/c2'), validCycle('anon')));
});

test('cannot create cycle with status approved, foreign uploaderUid, or qc out of range', async () => {
  await assertFails(setDoc(doc(gh('u1').firestore(), 'cycles/c3'), { ...validCycle('u1'), status: 'approved' }));
  await assertFails(setDoc(doc(gh('u1').firestore(), 'cycles/c4'), { ...validCycle('u2') }));
  await assertFails(setDoc(doc(gh('u1').firestore(), 'cycles/c5'), { ...validCycle('u1'), qc: 9 }));
});

test('public can bump downloads by exactly 1 and nothing else', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'cycles/c6'), { ...validCycle('u1'), status: 'approved', downloads: 0 });
  });
  await assertSucceeds(updateDoc(doc(anon().firestore(), 'cycles/c6'), { downloads: 1 }));
  await assertFails(updateDoc(doc(anon().firestore(), 'cycles/c6'), { downloads: 3 }));
  await assertFails(updateDoc(doc(anon().firestore(), 'cycles/c6'), { downloads: 2, status: 'removed' }));
});

test('a banned user cannot flip their own banned flag', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users/u1'), { uid: 'u1', banned: true });
  });
  await assertFails(updateDoc(doc(gh('u1').firestore(), 'users/u1'), { banned: false }));
});

test('a user may update their own favorites', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users/u2'), { uid: 'u2', banned: false, favorites: [] });
  });
  await assertSucceeds(updateDoc(doc(gh('u2').firestore(), 'users/u2'), { favorites: ['washer__bosch__wat'] }));
});

const validDevice = (uid, over = {}) => ({
  applianceType: 'washer', brand: 'Bosch', brand_lc: 'bosch', model: 'WAT', model_lc: 'wat',
  status: 'pending', createdByUid: uid, createdByName: null, manualUrl: null,
  createdAt: new Date(), profileCount: 0, favoriteCount: 0, confirmCount: 0, ...over,
});

test('device create requires github + matching brand_lc; anon denied', async () => {
  await assertSucceeds(setDoc(doc(gh('u1').firestore(), 'devices/washer__bosch__wat'), validDevice('u1')));
  await assertFails(setDoc(doc(gh('u1').firestore(), 'devices/x'), validDevice('u1', { brand_lc: 'WRONG' })));
  await assertFails(setDoc(doc(anon().firestore(), 'devices/y'), validDevice('anon')));
});

test('device create validates confirmCount, manualUrl and createdByName', async () => {
  await assertFails(setDoc(doc(gh('u1').firestore(), 'devices/d_cc'), validDevice('u1', { confirmCount: 3 })));
  await assertFails(setDoc(doc(gh('u1').firestore(), 'devices/d_url'), validDevice('u1', { manualUrl: 'javascript:alert(1)' })));
  await assertFails(setDoc(doc(gh('u1').firestore(), 'devices/d_url2'), validDevice('u1', { manualUrl: 'a'.repeat(501) })));
  await assertSucceeds(setDoc(doc(gh('u1').firestore(), 'devices/d_url_ok'), validDevice('u1', { manualUrl: 'https://example.com/manual.pdf', createdByName: 'Alice' })));
  await assertFails(setDoc(doc(gh('u1').firestore(), 'devices/d_name'), validDevice('u1', { createdByName: 'x'.repeat(101) })));
});

test('pending device is publicly readable; removed is not', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'devices/d_pending'), validDevice('u9', { status: 'pending' }));
    await setDoc(doc(ctx.firestore(), 'devices/d_removed'), validDevice('u9', { status: 'removed' }));
  });
  await assertSucceeds(getDoc(doc(anon().firestore(), 'devices/d_pending')));
  await assertFails(getDoc(doc(anon().firestore(), 'devices/d_removed')));
});

test('confirm is honest: +1 only with the matching confirmation doc, once per user', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'config/site'), { maintenance: false, confirmThreshold: 5 });
    await setDoc(doc(ctx.firestore(), 'devices/d_conf'), validDevice('owner', { confirmCount: 0 }));
  });
  const db = gh('voter1').firestore();
  // Bare +1 without creating the confirmation doc -> denied.
  await assertFails(updateDoc(doc(db, 'devices/d_conf'), { confirmCount: 1 }));
  // Batch: create my confirmation doc + increment -> allowed.
  const b1 = writeBatch(db);
  b1.set(doc(db, 'devices/d_conf/confirmations/voter1'), { uid: 'voter1', createdAt: new Date() });
  b1.update(doc(db, 'devices/d_conf'), { confirmCount: 1 });
  await assertSucceeds(b1.commit());
  // Same user cannot bump again (confirmation doc already exists).
  const b2 = writeBatch(db);
  b2.set(doc(db, 'devices/d_conf/confirmations/voter1'), { uid: 'voter1', createdAt: new Date() });
  b2.update(doc(db, 'devices/d_conf'), { confirmCount: 2 });
  await assertFails(b2.commit());
  // Bumping by more than 1 -> denied.
  const db2 = gh('voter2').firestore();
  const b3 = writeBatch(db2);
  b3.set(doc(db2, 'devices/d_conf/confirmations/voter2'), { uid: 'voter2', createdAt: new Date() });
  b3.update(doc(db2, 'devices/d_conf'), { confirmCount: 4 });
  await assertFails(b3.commit());
});

test('auto-promotion: only status flip, only at/above threshold', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'config/site'), { maintenance: false, confirmThreshold: 5 });
    await setDoc(doc(ctx.firestore(), 'devices/d_lo'), validDevice('o', { status: 'pending', confirmCount: 4 }));
    await setDoc(doc(ctx.firestore(), 'devices/d_hi'), validDevice('o', { status: 'pending', confirmCount: 5 }));
  });
  const db = gh('promoter').firestore();
  await assertFails(updateDoc(doc(db, 'devices/d_lo'), { status: 'approved' }));       // below threshold
  await assertSucceeds(updateDoc(doc(db, 'devices/d_hi'), { status: 'approved' }));     // at threshold
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'devices/d_hi2'), validDevice('o', { status: 'pending', confirmCount: 6 }));
  });
  // status + another field together is not a bare status flip -> denied for non-admin.
  await assertFails(updateDoc(doc(db, 'devices/d_hi2'), { status: 'approved', favoriteCount: 9 }));
});

const validProfile = (uid, over = {}) => ({
  deviceId: 'washer__bosch__wat', applianceType: 'washer',
  program: 'Cotton 40', program_lc: 'cotton 40', status: 'pending',
  createdByUid: uid, createdAt: new Date(), cycleCount: 0, ...over,
});

test('profile create by github user; pending is publicly readable, removed is not', async () => {
  await assertSucceeds(setDoc(doc(gh('u1').firestore(), 'profiles/washer__bosch__wat__cotton-40'), validProfile('u1')));
  await assertFails(setDoc(doc(anon().firestore(), 'profiles/x'), validProfile('anon')));
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'profiles/p_pending'), validProfile('u9', { status: 'pending' }));
    await setDoc(doc(ctx.firestore(), 'profiles/p_removed'), validProfile('u9', { status: 'removed' }));
  });
  await assertSucceeds(getDoc(doc(anon().firestore(), 'profiles/p_pending')));
  await assertFails(getDoc(doc(anon().firestore(), 'profiles/p_removed')));
});

test('device quality rating: own uid, 1-5 only', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'devices/d_rate'), validDevice('o'));
  });
  await assertSucceeds(setDoc(doc(gh('r1').firestore(), 'devices/d_rate/ratings/r1'), { uid: 'r1', rating: 4, updatedAt: new Date() }));
  await assertFails(setDoc(doc(gh('r1').firestore(), 'devices/d_rate/ratings/r1'), { uid: 'r1', rating: 9, updatedAt: new Date() }));
  await assertFails(setDoc(doc(gh('r1').firestore(), 'devices/d_rate/ratings/r2'), { uid: 'r2', rating: 3, updatedAt: new Date() }));
});
