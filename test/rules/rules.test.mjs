// Firestore rules unit tests. Requires the emulator + Java:
//   npm run test:rules
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, updateDoc } from 'firebase/firestore';

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

test('device create requires github + matching brand_lc; anon denied', async () => {
  const dev = {
    applianceType: 'washer', brand: 'Bosch', brand_lc: 'bosch', model: 'WAT', model_lc: 'wat',
    status: 'pending', createdByUid: 'u1', createdAt: new Date(), profileCount: 0, favoriteCount: 0,
  };
  await assertSucceeds(setDoc(doc(gh('u1').firestore(), 'devices/washer__bosch__wat'), dev));
  await assertFails(setDoc(doc(gh('u1').firestore(), 'devices/x'), { ...dev, brand_lc: 'WRONG' }));
  await assertFails(setDoc(doc(anon().firestore(), 'devices/y'), dev));
});
