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
// Firestore rules unit tests. Requires the emulator + Java:
//   npm run test:rules
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { doc, collection, setDoc, updateDoc, writeBatch, getDoc, serverTimestamp, increment } from 'firebase/firestore';

let env;
const PID = 'washdata-store';

// No hardcoded host/port: `firebase emulators:exec` exports FIRESTORE_EMULATOR_HOST for the
// port configured in firebase.json, and initializeTestEnvironment reads it. A local run on
// another port (8080 taken) then only needs a different firebase.json, e.g.
//   firebase emulators:exec -c /tmp/fb/firebase.json --project washdata-store --only firestore "node --test test/rules/"
before(async () => {
  env = await initializeTestEnvironment({
    projectId: PID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});
after(async () => { await env.cleanup(); });

function gh(uid) { return env.authenticatedContext(uid, { firebase: { sign_in_provider: 'github.com' } }); }
function anon() { return env.unauthenticatedContext(); }

// The cycle's parent profile must exist and belong to its device (seeded below).
const validCycle = (uid) => ({
  profileId: 'washer__bosch__cyc__cotton-40', deviceId: 'washer__bosch__cyc',
  brand_lc: 'bosch', program_lc: 'cotton-40', applianceType: 'washer',
  uploaderUid: uid, uploaderName: 'x', status: 'pending', rejectionReason: null,
  // Traces are stored as {o, w} maps, not nested arrays (Firestore rejects nested arrays).
  trace: { points: [{ o: 0, w: 1 }, { o: 5, w: 100 }], sampleIntervalSec: 5 },
  stats: { duration: 3600, energy_wh: 800, peak_w: 2000, mean_w: 200, signature: {} },
  cycleSchemaVersion: 1, downloads: 0, commentCount: 0, confirmCount: 0, qc: 1,
  // Rules require createdAt == request.time, which only holds for serverTimestamp().
  createdAt: serverTimestamp(),
});

test('github user can create a pending cycle; anon cannot', async () => {
  await seedCycleParents();
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
  // A decrement (or any non +1 step) is rejected -- the counter is monotone.
  await assertFails(updateDoc(doc(anon().firestore(), 'cycles/c6'), { downloads: 0 }));
  await assertFails(updateDoc(doc(anon().firestore(), 'cycles/c6'), { downloads: 3 }));
  await assertFails(updateDoc(doc(anon().firestore(), 'cycles/c6'), { downloads: 2, status: 'removed' }));
});

test('a banned user cannot flip their own banned flag', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users/u1'), { uid: 'u1', banned: true });
  });
  await assertFails(updateDoc(doc(gh('u1').firestore(), 'users/u1'), { banned: false }));
});

test('a user may update their own favorites (together with the device counter)', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users/u2'), { uid: 'u2', banned: false, favorites: [] });
    await setDoc(doc(ctx.firestore(), 'devices/washer__bosch__fav0'), { applianceType: 'washer', status: 'approved', favoriteCount: 0 });
  });
  // washstore.favoriteDevice: one batch moves the user's list and the device's count.
  const db = gh('u2').firestore();
  const b = writeBatch(db);
  b.update(doc(db, 'users/u2'), { favorites: ['washer__bosch__fav0'] });
  b.update(doc(db, 'devices/washer__bosch__fav0'), { favoriteCount: increment(1) });
  await assertSucceeds(b.commit());
  // The list alone can no longer change: that was half of the favoriteCount pump.
  await assertFails(updateDoc(doc(db, 'users/u2'), { favorites: [] }));
});

const validDevice = (uid, over = {}) => ({
  applianceType: 'washer', brand: 'Bosch', brand_lc: 'bosch', model: 'WAT', model_lc: 'wat',
  status: 'pending', createdByUid: uid, createdByName: null, manualUrl: null,
  createdAt: serverTimestamp(), profileCount: 0, favoriteCount: 0, confirmCount: 0, ...over,
});

test('device create requires github + matching brand_lc; anon denied', async () => {
  await assertSucceeds(setDoc(doc(gh('u1').firestore(), 'devices/washer__bosch__wat'), validDevice('u1')));
  // brand_lc must equal brand.lower(); a lowercase-but-wrong value still fails the rule.
  await assertFails(setDoc(doc(gh('u1').firestore(), 'devices/washer__bosch__bad-lc'), validDevice('u1', { brand_lc: 'other' })));
  await assertFails(setDoc(doc(anon().firestore(), 'devices/y'), validDevice('anon')));
});

test('device create validates confirmCount, manualUrl and createdByName', async () => {
  await assertFails(setDoc(doc(gh('u1').firestore(), 'devices/washer__bosch__cc'), validDevice('u1', { confirmCount: 3 })));
  await assertFails(setDoc(doc(gh('u1').firestore(), 'devices/washer__bosch__url'), validDevice('u1', { manualUrl: 'javascript:alert(1)' })));
  await assertFails(setDoc(doc(gh('u1').firestore(), 'devices/washer__bosch__url2'), validDevice('u1', { manualUrl: 'a'.repeat(501) })));
  await assertSucceeds(setDoc(doc(gh('u1').firestore(), 'devices/washer__bosch__url-ok'), validDevice('u1', { manualUrl: 'https://example.com/manual.pdf', createdByName: 'Alice' })));
  await assertFails(setDoc(doc(gh('u1').firestore(), 'devices/washer__bosch__name'), validDevice('u1', { createdByName: 'x'.repeat(101) })));
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
  b1.set(doc(db, 'devices/d_conf/confirmations/voter1'), { uid: 'voter1', createdAt: serverTimestamp() });
  b1.update(doc(db, 'devices/d_conf'), { confirmCount: 1 });
  await assertSucceeds(b1.commit());
  // Same user cannot bump again (confirmation doc already exists).
  const b2 = writeBatch(db);
  b2.set(doc(db, 'devices/d_conf/confirmations/voter1'), { uid: 'voter1', createdAt: serverTimestamp() });
  b2.update(doc(db, 'devices/d_conf'), { confirmCount: 2 });
  await assertFails(b2.commit());
  // Bumping by more than 1 -> denied.
  const db2 = gh('voter2').firestore();
  const b3 = writeBatch(db2);
  b3.set(doc(db2, 'devices/d_conf/confirmations/voter2'), { uid: 'voter2', createdAt: serverTimestamp() });
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
  createdByUid: uid, createdAt: serverTimestamp(), cycleCount: 0, ...over,
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
  // Out-of-range rating rejected on the create path too (fresh user, own uid doc).
  await assertFails(setDoc(doc(gh('r3').firestore(), 'devices/d_rate/ratings/r3'), { uid: 'r3', rating: 9, updatedAt: new Date() }));
  // Cannot write another user's rating doc (doc id must equal your uid).
  await assertFails(setDoc(doc(gh('r1').firestore(), 'devices/d_rate/ratings/r2'), { uid: 'r2', rating: 3, updatedAt: new Date() }));
});

test('cycle rating counter: honest ratingSum/ratingCount tied to the batch rating write', async () => {
  await seedDoc('cycles/c_rate', { status: 'approved' });
  const db = gh('rater1').firestore();
  // Bare counter bump without writing my rating doc -> denied.
  await assertFails(updateDoc(doc(db, 'cycles/c_rate'), { ratingCount: increment(1), ratingSum: increment(5) }));
  // First rating: batch (my rating doc = 5) + count +1 + sum +5 -> allowed.
  const b1 = writeBatch(db);
  b1.set(doc(db, 'cycles/c_rate/ratings/rater1'), { uid: 'rater1', rating: 5, updatedAt: new Date() });
  b1.update(doc(db, 'cycles/c_rate'), { ratingCount: increment(1), ratingSum: increment(5) });
  await assertSucceeds(b1.commit());
  // A sum that does not match the rated value (rated 5, claims +3) -> denied.
  const db2 = gh('rater2').firestore();
  const bBad = writeBatch(db2);
  bBad.set(doc(db2, 'cycles/c_rate/ratings/rater2'), { uid: 'rater2', rating: 5, updatedAt: new Date() });
  bBad.update(doc(db2, 'cycles/c_rate'), { ratingCount: increment(1), ratingSum: increment(3) });
  await assertFails(bBad.commit());
  // Count bumped by more than 1 -> denied.
  const bBad2 = writeBatch(db2);
  bBad2.set(doc(db2, 'cycles/c_rate/ratings/rater2'), { uid: 'rater2', rating: 5, updatedAt: new Date() });
  bBad2.update(doc(db2, 'cycles/c_rate'), { ratingCount: increment(2), ratingSum: increment(5) });
  await assertFails(bBad2.commit());
  // Edit my own rating (5 -> 2): count unchanged, sum shifts by (2 - 5) = -3 -> allowed.
  const bEdit = writeBatch(db);
  bEdit.set(doc(db, 'cycles/c_rate/ratings/rater1'), { uid: 'rater1', rating: 2, updatedAt: new Date() }, { merge: true });
  bEdit.update(doc(db, 'cycles/c_rate'), { ratingSum: increment(-3) });
  await assertSucceeds(bEdit.commit());
  // An edit whose sum shift does not match the new value -> denied.
  const bEditBad = writeBatch(db);
  bEditBad.set(doc(db, 'cycles/c_rate/ratings/rater1'), { uid: 'rater1', rating: 4, updatedAt: new Date() }, { merge: true });
  bEditBad.update(doc(db, 'cycles/c_rate'), { ratingSum: increment(5) });  // should be +2
  await assertFails(bEditBad.commit());
});

test('device rating counter: honest ratingSum/ratingCount tied to the batch rating write', async () => {
  await seedDoc('devices/d_ratec', { status: 'approved' });
  const db = gh('dr1').firestore();
  await assertFails(updateDoc(doc(db, 'devices/d_ratec'), { ratingCount: increment(1), ratingSum: increment(4) }));
  const b1 = writeBatch(db);
  b1.set(doc(db, 'devices/d_ratec/ratings/dr1'), { uid: 'dr1', rating: 4, updatedAt: new Date() });
  b1.update(doc(db, 'devices/d_ratec'), { ratingCount: increment(1), ratingSum: increment(4) });
  await assertSucceeds(b1.commit());
  // A sum that does not match the rated value (rated 4, claims +2) -> denied.
  const db2 = gh('dr2').firestore();
  const bBad = writeBatch(db2);
  bBad.set(doc(db2, 'devices/d_ratec/ratings/dr2'), { uid: 'dr2', rating: 4, updatedAt: new Date() });
  bBad.update(doc(db2, 'devices/d_ratec'), { ratingCount: increment(1), ratingSum: increment(2) });
  await assertFails(bBad.commit());
  // Count bumped by more than 1 -> denied.
  const bBad2 = writeBatch(db2);
  bBad2.set(doc(db2, 'devices/d_ratec/ratings/dr2'), { uid: 'dr2', rating: 4, updatedAt: new Date() });
  bBad2.update(doc(db2, 'devices/d_ratec'), { ratingCount: increment(2), ratingSum: increment(4) });
  await assertFails(bBad2.commit());
  // Edit 4 -> 1: count unchanged, sum shifts by -3 -> allowed.
  const bEdit = writeBatch(db);
  bEdit.set(doc(db, 'devices/d_ratec/ratings/dr1'), { uid: 'dr1', rating: 1, updatedAt: new Date() }, { merge: true });
  bEdit.update(doc(db, 'devices/d_ratec'), { ratingSum: increment(-3) });
  await assertSucceeds(bEdit.commit());
  // An edit whose sum shift does not match the new value -> denied.
  const bEditBad = writeBatch(db);
  bEditBad.set(doc(db, 'devices/d_ratec/ratings/dr1'), { uid: 'dr1', rating: 3, updatedAt: new Date() }, { merge: true });
  bEditBad.update(doc(db, 'devices/d_ratec'), { ratingSum: increment(5) });  // should be +2
  await assertFails(bEditBad.commit());
});

test('device owner can update settings only; cannot touch other fields', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'devices/d_owned'), validDevice('creator', { ownerId: 'owner1' }));
  });
  const db = gh('owner1').firestore();
  // settings-only update -> allowed
  await assertSucceeds(updateDoc(doc(db, 'devices/d_owned'), { settings: { min_power: 5 } }));
  // cannot touch status or other fields
  await assertFails(updateDoc(doc(db, 'devices/d_owned'), { status: 'approved' }));
  await assertFails(updateDoc(doc(db, 'devices/d_owned'), { settings: { min_power: 5 }, brand: 'Other' }));
  // non-owner cannot use this path
  await assertFails(updateDoc(doc(gh('stranger').firestore(), 'devices/d_owned'), { settings: { min_power: 5 } }));
  // device without ownerId set -> non-owner still cannot use this path
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'devices/d_noowner'), validDevice('creator'));
  });
  await assertFails(updateDoc(doc(db, 'devices/d_noowner'), { settings: { min_power: 5 } }));
});

test('profile owner (device ownerId) can update phases only; non-owner cannot', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'devices/d_pown'), validDevice('creator', { ownerId: 'powner1' }));
    await setDoc(doc(ctx.firestore(), 'profiles/p_pown'), validProfile('creator', { deviceId: 'd_pown' }));
  });
  const db = gh('powner1').firestore();
  // phases-only update -> allowed
  await assertSucceeds(updateDoc(doc(db, 'profiles/p_pown'), { phases: [{ name: 'Wash', start: 0, end: 1800 }] }));
  // cannot touch other profile fields
  await assertFails(updateDoc(doc(db, 'profiles/p_pown'), { status: 'approved' }));
  await assertFails(updateDoc(doc(db, 'profiles/p_pown'), { phases: [], program: 'Other' }));
  // non-owner cannot update phases
  await assertFails(updateDoc(doc(gh('stranger2').firestore(), 'profiles/p_pown'), { phases: [] }));
});

// ── Analytics usage counters (anonymous-writable but bounded to +1 per event) ──
test('analytics: anon can create a doc with a single +1 counter (+ short date)', async () => {
  await assertSucceeds(setDoc(doc(anon().firestore(), 'analytics/daily_20260717'), { downloads: 1, date: '2026-07-17' }));
  await assertSucceeds(setDoc(doc(anon().firestore(), 'analytics/totals'), { cycle_details: 1 }));
});

test('analytics: create rejects >1 total, multiple counters, junk fields, and a long date', async () => {
  await assertFails(setDoc(doc(anon().firestore(), 'analytics/d_big'), { downloads: 5 }));
  await assertFails(setDoc(doc(anon().firestore(), 'analytics/d_two'), { downloads: 1, searches: 1 }));
  await assertFails(setDoc(doc(anon().firestore(), 'analytics/d_junk'), { downloads: 1, evil: 1 }));
  await assertFails(setDoc(doc(anon().firestore(), 'analytics/d_date'), { downloads: 1, date: 'x'.repeat(20) }));
});

test('analytics: anon +1 on one counter allowed; bigger jump / two counters / decrement / overwrite / junk rejected', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'analytics/totals2'), { downloads: 10, cycle_details: 3 });
  });
  const db = anon().firestore();
  await assertSucceeds(updateDoc(doc(db, 'analytics/totals2'), { downloads: increment(1) }));
  await assertFails(updateDoc(doc(db, 'analytics/totals2'), { downloads: increment(1000) }));
  await assertFails(updateDoc(doc(db, 'analytics/totals2'), { downloads: increment(1), cycle_details: increment(1) }));
  await assertFails(updateDoc(doc(db, 'analytics/totals2'), { downloads: increment(-1) }));
  await assertFails(updateDoc(doc(db, 'analytics/totals2'), { downloads: 99999 }));
  await assertFails(updateDoc(doc(db, 'analytics/totals2'), { evil: 1 }));
});

test('analytics is admin-read-only', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'analytics/totals3'), { downloads: 1 });
    await setDoc(doc(ctx.firestore(), 'admins/adminU'), { uid: 'adminU' });
  });
  await assertFails(getDoc(doc(anon().firestore(), 'analytics/totals3')));
  await assertSucceeds(getDoc(doc(gh('adminU').firestore(), 'analytics/totals3')));
});

// ------------------------------------------------------------------
// Content reports (moderation) + repeat-offender strike counter
// ------------------------------------------------------------------
// Create rules require the parent object to EXIST and the target* fields to match the
// report's real location, so seed the parent first.
async function seedDoc(path, data) {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path), data); });
}
async function seedCycleParents() {
  await seedDoc('devices/washer__bosch__cyc', { applianceType: 'washer', brand: 'Bosch', brand_lc: 'bosch', model: 'CYC', model_lc: 'cyc', status: 'approved' });
  await seedDoc('profiles/washer__bosch__cyc__cotton-40', { deviceId: 'washer__bosch__cyc', program: 'Cotton 40', program_lc: 'cotton 40', status: 'approved' });
}
const deviceReport = (uid, deviceId = 'd_rep', over = {}) => ({
  reporterUid: uid, reporterName: 'Rep', reason: 'spam', comment: 'looks like spam',
  targetType: 'device', targetId: deviceId, targetPath: 'devices/' + deviceId,
  parentCycleId: null, targetLabel: 'Bosch WAT', targetCreatedByUid: 'creatorX',
  status: 'open', createdAt: serverTimestamp(), ...over,
});

test('report: a github user can file on an existing object; anon cannot', async () => {
  await seedDoc('devices/d_rep', validDevice('u9'));
  await assertSucceeds(setDoc(doc(gh('r1').firestore(), 'devices/d_rep/reports/r1'), deviceReport('r1')));
  await assertFails(setDoc(doc(anon().firestore(), 'devices/d_rep/reports/anon'), deviceReport('anon')));
});

test('report: cannot file on a non-existent parent object', async () => {
  await assertFails(setDoc(doc(gh('r1').firestore(), 'devices/d_missing/reports/r1'), deviceReport('r1', 'd_missing')));
});

test('report: cannot spoof target* to another object or lie about the type', async () => {
  await seedDoc('devices/d_real', validDevice('u9'));
  await seedDoc('devices/d_victim', validDevice('u9'));
  // Physically under d_real but claims to target d_victim -> path binding rejects it.
  await assertFails(setDoc(doc(gh('r1').firestore(), 'devices/d_real/reports/r1'), deviceReport('r1', 'd_victim')));
  // targetType lying about the parent collection is rejected.
  await assertFails(setDoc(doc(gh('r1').firestore(), 'devices/d_real/reports/r2'), deviceReport('r1', 'd_real', { targetType: 'brand' })));
});

test('report: reporterUid must match doc id + auth; bad status / empty comment rejected', async () => {
  await seedDoc('devices/d_rep2', validDevice('u9'));
  await assertFails(setDoc(doc(gh('r1').firestore(), 'devices/d_rep2/reports/r1'), deviceReport('r1', 'd_rep2', { reporterUid: 'other' })));
  await assertFails(setDoc(doc(gh('r1').firestore(), 'devices/d_rep2/reports/r2'), deviceReport('r1', 'd_rep2')));
  await assertFails(setDoc(doc(gh('r1').firestore(), 'devices/d_rep2/reports/r1'), deviceReport('r1', 'd_rep2', { status: 'resolved' })));
  await assertFails(setDoc(doc(gh('r1').firestore(), 'devices/d_rep2/reports/r1'), deviceReport('r1', 'd_rep2', { comment: '' })));
});

test('report: a banned user cannot file a report', async () => {
  await seedDoc('devices/d_rep3', validDevice('u9'));
  await seedDoc('users/rb', { uid: 'rb', status: 'banned' });
  await assertFails(setDoc(doc(gh('rb').firestore(), 'devices/d_rep3/reports/rb'), deviceReport('rb', 'd_rep3')));
});

test('report: private reads - reporter + admin only', async () => {
  await seedDoc('devices/d_rep4', validDevice('u9'));
  await seedDoc('devices/d_rep4/reports/r1', deviceReport('r1', 'd_rep4'));
  await seedDoc('admins/adminU', { uid: 'adminU' });
  await assertSucceeds(getDoc(doc(gh('r1').firestore(), 'devices/d_rep4/reports/r1')));    // own
  await assertFails(getDoc(doc(gh('r2').firestore(), 'devices/d_rep4/reports/r1')));        // other user
  await assertFails(getDoc(doc(anon().firestore(), 'devices/d_rep4/reports/r1')));           // anon
  await assertSucceeds(getDoc(doc(gh('adminU').firestore(), 'devices/d_rep4/reports/r1'))); // admin
});

test('report: only admin resolves/deletes; reporter cannot overwrite their report', async () => {
  await seedDoc('devices/d_rep5', validDevice('u9'));
  await seedDoc('devices/d_rep5/reports/r1', deviceReport('r1', 'd_rep5'));
  await seedDoc('admins/adminU', { uid: 'adminU' });
  await assertFails(updateDoc(doc(gh('r1').firestore(), 'devices/d_rep5/reports/r1'), { status: 'resolved' }));
  await assertSucceeds(updateDoc(doc(gh('adminU').firestore(), 'devices/d_rep5/reports/r1'), { status: 'resolved', resolution: 'dismissed' }));
});

test('report: comment reports require the parent comment to exist + a bound path', async () => {
  await seedDoc('cycles/c_x/comments/cm1', { authorUid: 'u9', text: 'hi', createdAt: serverTimestamp() });
  const commentReport = {
    reporterUid: 'r1', reporterName: 'Rep', reason: 'offensive', comment: 'abuse',
    targetType: 'comment', targetId: 'cm1', parentCycleId: 'c_x', targetPath: 'cycles/c_x/comments/cm1',
    status: 'open', createdAt: serverTimestamp(),
  };
  await assertSucceeds(setDoc(doc(gh('r1').firestore(), 'cycles/c_x/comments/cm1/reports/r1'), commentReport));
  // A report under a non-existent comment is rejected.
  await assertFails(setDoc(doc(gh('r1').firestore(), 'cycles/c_x/comments/missing/reports/r1'),
    { ...commentReport, targetId: 'missing', targetPath: 'cycles/c_x/comments/missing' }));
});

test('report: brand / profile / cycle parents each bind target* + require existence', async () => {
  await seedDoc('brands/b_rep', { brand: 'Bosch', brand_lc: 'bosch', status: 'approved' });
  await seedDoc('profiles/p_rep', { deviceId: 'd', program: 'Cotton', program_lc: 'cotton', status: 'approved' });
  await seedDoc('cycles/cy_rep', { ...validCycle('u9'), status: 'approved' });
  const rep = (uid, type, id, path) => ({
    reporterUid: uid, reporterName: 'Rep', reason: 'wrong', comment: 'bad data',
    targetType: type, targetId: id, targetPath: path, parentCycleId: null,
    status: 'open', createdAt: serverTimestamp(),
  });
  await assertSucceeds(setDoc(doc(gh('r1').firestore(), 'brands/b_rep/reports/r1'), rep('r1', 'brand', 'b_rep', 'brands/b_rep')));
  await assertSucceeds(setDoc(doc(gh('r1').firestore(), 'profiles/p_rep/reports/r1'), rep('r1', 'profile', 'p_rep', 'profiles/p_rep')));
  await assertSucceeds(setDoc(doc(gh('r1').firestore(), 'cycles/cy_rep/reports/r1'), rep('r1', 'cycle', 'cy_rep', 'cycles/cy_rep')));
  // Wrong targetType for the parent collection is rejected.
  await assertFails(setDoc(doc(gh('r2').firestore(), 'brands/b_rep/reports/r2'), rep('r2', 'cycle', 'b_rep', 'brands/b_rep')));
  // Non-existent parent is rejected.
  await assertFails(setDoc(doc(gh('r1').firestore(), 'profiles/p_missing/reports/r1'), rep('r1', 'profile', 'p_missing', 'profiles/p_missing')));
});

test('report: unknown extra fields are rejected (keys allowlist)', async () => {
  await seedDoc('devices/d_keys', validDevice('u9'));
  await assertFails(setDoc(doc(gh('r1').firestore(), 'devices/d_keys/reports/r1'),
    deviceReport('r1', 'd_keys', { evil: 'inject' })));
});

test('strike counter: admin may bump removedContentCount; the user may not', async () => {
  await seedDoc('users/rc', { uid: 'rc', status: 'active', removedContentCount: 0 });
  await seedDoc('admins/adminU', { uid: 'adminU' });
  await assertFails(updateDoc(doc(gh('rc').firestore(), 'users/rc'), { removedContentCount: increment(1) }));
  await assertSucceeds(updateDoc(doc(gh('adminU').firestore(), 'users/rc'), { removedContentCount: increment(1) }));
});

// ------------------------------------------------------------------
// Admin direct create (faithful ID migration for rename / merge / move)
// ------------------------------------------------------------------
// Renaming a brand/model/program changes the derived doc id, so the doc must be RE-CREATED
// under the new id with its original fields (status/owner/createdAt/counters). The
// contributor-create branch forbids that (status must be 'pending', createdByUid == self,
// createdAt == now, counters zeroed), so the migration relies on an admin-only create rule.
test('admin may create brand/device/profile/cycle docs directly with preserved fields', async () => {
  await seedDoc('admins/adminU', { uid: 'adminU' });
  const adb = gh('adminU').firestore();
  await assertSucceeds(setDoc(doc(adb, 'brands/migrated'), {
    brand: 'Bosch', brand_lc: 'bosch', status: 'approved', createdByUid: 'someoneElse',
    deviceCount: 3, cycleCount: 12, createdAt: serverTimestamp(),
  }));
  await assertSucceeds(setDoc(doc(adb, 'devices/washer__bosch__wat-new'), {
    applianceType: 'washer', brand: 'Bosch', brand_lc: 'bosch', model: 'WAT-new', model_lc: 'wat-new',
    status: 'approved', createdByUid: 'someoneElse', favoriteCount: 7, confirmCount: 4,
    profileCount: 2, cycleCount: 9, createdAt: serverTimestamp(),
  }));
  await assertSucceeds(setDoc(doc(adb, 'profiles/washer__bosch__wat-new__eco'), {
    deviceId: 'washer__bosch__wat-new', program: 'Eco', program_lc: 'eco',
    status: 'approved', createdByUid: 'someoneElse', cycleCount: 5, createdAt: serverTimestamp(),
  }));
  await assertSucceeds(setDoc(doc(adb, 'cycles/migrated-cycle'), {
    ...validCycle('someoneElse'), status: 'approved',
    profileId: 'washer__bosch__wat-new__eco', deviceId: 'washer__bosch__wat-new',
    downloads: 42, confirmCount: 3,
  }));
});

test('admin-create allowance does not weaken the contributor branch', async () => {
  // A regular github user still cannot forge status/owner on a new catalog doc.
  const u = gh('u1').firestore();
  await assertFails(setDoc(doc(u, 'brands/forge'), {
    brand: 'Bosch', brand_lc: 'bosch', status: 'approved', createdByUid: 'someoneElse', createdAt: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(u, 'devices/washer__bosch__forge'), validDevice('u1', { status: 'approved' })));
  await assertFails(setDoc(doc(u, 'cycles/forge'), { ...validCycle('u1'), status: 'approved', downloads: 5 }));
});

test('admin rename cascade: re-create child under new id + delete old in one batch', async () => {
  // The core of _reidDevice / adminRenameProfile: an approved profile is re-created under a
  // new profileId (all fields preserved) and the old doc removed, atomically.
  await seedDoc('admins/adminU', { uid: 'adminU' });
  await seedDoc('profiles/washer__bosch__wat__old', {
    deviceId: 'washer__bosch__wat', program: 'Old', program_lc: 'old',
    status: 'approved', createdByUid: 'contribX', cycleCount: 4, createdAt: serverTimestamp(),
  });
  const adb = gh('adminU').firestore();
  const b = writeBatch(adb);
  b.set(doc(adb, 'profiles/washer__bosch__wat__renamed'), {
    deviceId: 'washer__bosch__wat', program: 'Renamed', program_lc: 'renamed',
    status: 'approved', createdByUid: 'contribX', cycleCount: 4, createdAt: serverTimestamp(),
  });
  b.delete(doc(adb, 'profiles/washer__bosch__wat__old'));
  await assertSucceeds(b.commit());
});

// ---------------------------------------------------------------------------
// Brand auto-approval (approved-device counter)
//
// Rules cannot run a query, so they cannot count a brand's approved devices. The counter bump
// therefore has to NAME the device claiming credit, and the rule verifies that device three
// ways: it belongs to this brand, it was pending before the write, and it is approved after
// it. These tests are the proof that the naming cannot be abused -- they are the whole reason
// the counter is trustworthy enough to gate a status change.
// ---------------------------------------------------------------------------

const brandDoc = (uid, over = {}) => ({
  brand: 'Bosch', brand_lc: 'bosch', status: 'pending', createdByUid: uid, createdByName: null,
  createdAt: serverTimestamp(), deviceCount: 0, cycleCount: 0, approvedDeviceCount: 0, ...over,
});

test('brand create must start every counter at zero', async () => {
  await assertSucceeds(setDoc(doc(gh('u1').firestore(), 'brands/bosch'), brandDoc('u1')));
  // approvedDeviceCount gates auto-approval, so seeding it would be self-promotion.
  await assertFails(setDoc(doc(gh('u1').firestore(), 'brands/b_seed'),
    brandDoc('u1', { brand: 'Seed', brand_lc: 'b_seed', approvedDeviceCount: 99 })));
  await assertFails(setDoc(doc(gh('u1').firestore(), 'brands/b_seed2'),
    brandDoc('u1', { brand: 'Seed2', brand_lc: 'b_seed2', deviceCount: 5 })));
  await assertFails(setDoc(doc(gh('u1').firestore(), 'brands/b_seed3'),
    brandDoc('u1', { brand: 'Seed3', brand_lc: 'b_seed3', cycleCount: 5 })));
});

// Seed a brand + one of its devices at a chosen status, bypassing rules.
async function seedBrandAndDevice(brandId, devId, devStatus, confirmCount = 99) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `brands/${brandId}`), {
      brand: brandId, brand_lc: brandId, status: 'pending',
      deviceCount: 1, cycleCount: 0, approvedDeviceCount: 0,
    });
    await setDoc(doc(ctx.firestore(), `devices/${devId}`), {
      applianceType: 'washer', brand: brandId, brand_lc: brandId, model: 'm', model_lc: 'm',
      status: devStatus, confirmCount, profileCount: 0, cycleCount: 0, favoriteCount: 0,
    });
  });
}

test('brand approved-device credit is allowed only alongside that device pending -> approved', async () => {
  await seedBrandAndDevice('bcredit', 'washer__bcredit__m', 'pending');
  const db = gh('u1').firestore();
  // The honest path: device flip + brand credit in ONE batch.
  const ok = writeBatch(db);
  ok.update(doc(db, 'devices/washer__bcredit__m'), { status: 'approved' });
  ok.update(doc(db, 'brands/bcredit'),
    { approvedDeviceCount: increment(1), lastApprovedDeviceId: 'washer__bcredit__m' });
  await assertSucceeds(ok.commit());
  const after = await getDoc(doc(db, 'brands/bcredit'));
  assert.equal(after.data().approvedDeviceCount, 1);
});

test('brand credit is denied without the device flip in the same batch', async () => {
  await seedBrandAndDevice('bnoflip', 'washer__bnoflip__m', 'pending');
  const db = gh('u1').firestore();
  // Naming a device that stays pending: the getAfter() check fails.
  await assertFails(updateDoc(doc(db, 'brands/bnoflip'),
    { approvedDeviceCount: increment(1), lastApprovedDeviceId: 'washer__bnoflip__m' }));
});

test('brand credit cannot be claimed twice for the same device', async () => {
  // Device already approved => the get() "was pending" check fails, so no second credit.
  await seedBrandAndDevice('bdouble', 'washer__bdouble__m', 'approved');
  const db = gh('u1').firestore();
  await assertFails(updateDoc(doc(db, 'brands/bdouble'),
    { approvedDeviceCount: increment(1), lastApprovedDeviceId: 'washer__bdouble__m' }));
  // Even re-flipping it to approved in the same batch is a no-op transition and still fails.
  const b = writeBatch(db);
  b.update(doc(db, 'devices/washer__bdouble__m'), { status: 'approved' });
  b.update(doc(db, 'brands/bdouble'),
    { approvedDeviceCount: increment(1), lastApprovedDeviceId: 'washer__bdouble__m' });
  await assertFails(b.commit());
});

test('brand credit cannot be claimed using another brand device', async () => {
  await seedBrandAndDevice('bmine', 'washer__bmine__m', 'pending');
  await seedBrandAndDevice('bother', 'washer__bother__m', 'pending');
  const db = gh('u1').firestore();
  // Flip the OTHER brand's device but credit mine: the brand_lc check fails.
  const b = writeBatch(db);
  b.update(doc(db, 'devices/washer__bother__m'), { status: 'approved' });
  b.update(doc(db, 'brands/bmine'),
    { approvedDeviceCount: increment(1), lastApprovedDeviceId: 'washer__bother__m' });
  await assertFails(b.commit());
});

test('brand credit must step by exactly +1 and touch nothing else', async () => {
  await seedBrandAndDevice('bstep', 'washer__bstep__m', 'pending');
  const db = gh('u1').firestore();
  const attempt = (data) => {
    const b = writeBatch(db);
    b.update(doc(db, 'devices/washer__bstep__m'), { status: 'approved' });
    b.update(doc(db, 'brands/bstep'), data);
    return b.commit();
  };
  await assertFails(attempt({ approvedDeviceCount: increment(5), lastApprovedDeviceId: 'washer__bstep__m' }));
  await assertFails(attempt({ approvedDeviceCount: increment(-1), lastApprovedDeviceId: 'washer__bstep__m' }));
  // Riding a status change along with the credit is refused (that is a separate rule).
  await assertFails(attempt({
    approvedDeviceCount: increment(1), lastApprovedDeviceId: 'washer__bstep__m', status: 'approved',
  }));
  // A credit with no device named at all cannot be verified.
  await assertFails(attempt({ approvedDeviceCount: increment(1) }));
});

test('brand credit rejects a device id that could escape the document path', async () => {
  await seedBrandAndDevice('bpath', 'washer__bpath__m', 'pending');
  const db = gh('u1').firestore();
  const b = writeBatch(db);
  b.update(doc(db, 'devices/washer__bpath__m'), { status: 'approved' });
  b.update(doc(db, 'brands/bpath'),
    { approvedDeviceCount: increment(1), lastApprovedDeviceId: 'washer__bpath__m/confirmations/u1' });
  await assertFails(b.commit());
});

test('brand auto-promotes at the configured brand threshold, not below it', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'config/site'), { confirmThreshold: 5, brandConfirmThreshold: 2 });
    await setDoc(doc(ctx.firestore(), 'brands/bthr'), {
      brand: 'bthr', brand_lc: 'bthr', status: 'pending',
      deviceCount: 3, cycleCount: 0, approvedDeviceCount: 1,
    });
  });
  const db = gh('u1').firestore();
  // 1 approved model, brand bar is 2 -> denied.
  await assertFails(updateDoc(doc(db, 'brands/bthr'), { status: 'approved' }));
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'brands/bthr'), { approvedDeviceCount: 2 });
  });
  // 2 approved models -> the community may promote the brand.
  await assertSucceeds(updateDoc(doc(db, 'brands/bthr'), { status: 'approved' }));
});

test('the brand threshold is independent of the device threshold', async () => {
  // Device bar 5, brand bar 2: two approved models is enough for the BRAND even though no
  // single device could be approved on two confirmations.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'config/site'), { confirmThreshold: 5, brandConfirmThreshold: 2 });
    await setDoc(doc(ctx.firestore(), 'brands/bindep'), {
      brand: 'bindep', brand_lc: 'bindep', status: 'pending',
      deviceCount: 2, cycleCount: 0, approvedDeviceCount: 2,
    });
    await setDoc(doc(ctx.firestore(), 'devices/washer__bindep__m'), {
      applianceType: 'washer', brand: 'bindep', brand_lc: 'bindep', model: 'm', model_lc: 'm',
      status: 'pending', confirmCount: 2, profileCount: 0, cycleCount: 0, favoriteCount: 0,
    });
  });
  const db = gh('u1').firestore();
  await assertSucceeds(updateDoc(doc(db, 'brands/bindep'), { status: 'approved' }));
  // The device still needs 5 of its own confirmations.
  await assertFails(updateDoc(doc(db, 'devices/washer__bindep__m'), { status: 'approved' }));
});

test('brand promotion is status-only, one-way, and denied to anon', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'config/site'), { confirmThreshold: 5, brandConfirmThreshold: 1 });
    await setDoc(doc(ctx.firestore(), 'brands/bone'), {
      brand: 'bone', brand_lc: 'bone', status: 'pending',
      deviceCount: 1, cycleCount: 0, approvedDeviceCount: 4,
    });
  });
  await assertFails(updateDoc(doc(anon().firestore(), 'brands/bone'), { status: 'approved' }));
  // Cannot smuggle other fields through the status rule.
  await assertFails(updateDoc(doc(gh('u1').firestore(), 'brands/bone'), { status: 'approved', brand: 'Hijack' }));
  // Cannot jump to a status other than approved.
  await assertFails(updateDoc(doc(gh('u1').firestore(), 'brands/bone'), { status: 'removed' }));
  await assertSucceeds(updateDoc(doc(gh('u1').firestore(), 'brands/bone'), { status: 'approved' }));
  // Already approved: the rule requires the previous status to be pending, so no re-flip.
  await assertFails(updateDoc(doc(gh('u1').firestore(), 'brands/bone'), { status: 'pending' }));
});

// ===========================================================================
// Audit 2026-10-02 (STORE-01 / STORE-02 / STORE-16): the nine abuse writes the auditor's
// emulator probe found ACCEPTED. Each must now be refused. Kept close to the probe's own
// payloads so a regression reads as "probe A<n> is open again".
// ===========================================================================

const XSS = '<img src=x onerror=alert(document.domain)>';
async function seedProbeWorld() {
  await seedDoc('config/site', { confirmThreshold: 5 });
  await seedDoc('devices/washer__miele__w1', {
    applianceType: 'washer', brand: 'Miele', brand_lc: 'miele', model: 'W1', model_lc: 'w1',
    status: 'approved', createdByUid: 'victim', favoriteCount: 0, confirmCount: 7,
  });
  await seedDoc('profiles/washer__miele__w1__eco', {
    deviceId: 'washer__miele__w1', program: 'Eco', program_lc: 'eco', status: 'approved', createdByUid: 'victim',
  });
}
const probeCycle = (uid, extra = {}) => ({
  profileId: 'washer__miele__w1__eco', deviceId: 'washer__miele__w1', brand_lc: 'miele', program_lc: 'eco',
  applianceType: 'washer', uploaderUid: uid, uploaderName: null, status: 'pending',
  trace: { points: [{ o: 0, w: 1 }, { o: 60, w: 2000 }], sampleIntervalSec: 5 },
  stats: { duration: 60, peak_w: 2000 }, cycleSchemaVersion: 1, downloads: 0, commentCount: 0, confirmCount: 0,
  qc: 1, createdAt: serverTimestamp(), ...extra,
});

test('probe control: the honest probe cycle is accepted (so every refusal below is the abuse, not the base)', async () => {
  await seedProbeWorld();
  await assertSucceeds(setDoc(doc(gh('atk').firestore(), 'cycles/x0'), probeCycle('atk')));
});

test('A1 cycle with HTML in stats.peak_w / trace.sampleIntervalSec is refused', async () => {
  await seedProbeWorld();
  const db = gh('atk').firestore();
  await assertFails(setDoc(doc(db, 'cycles/x1'), probeCycle('atk', {
    stats: { peak_w: XSS, duration: 'x' }, trace: { points: [{ o: 0, w: 1 }, { o: 5, w: 2 }], sampleIntervalSec: XSS } })));
  // Each half on its own, so neither check can mask the other.
  await assertFails(setDoc(doc(db, 'cycles/x1a'), probeCycle('atk', { stats: { duration: 60, peak_w: XSS } })));
  await assertFails(setDoc(doc(db, 'cycles/x1b'), probeCycle('atk', {
    trace: { points: [{ o: 0, w: 1 }, { o: 5, w: 2 }], sampleIntervalSec: XSS } })));
  await assertFails(setDoc(doc(db, 'cycles/x1c'), probeCycle('atk', { stats: { duration: 60, peak_w: 1, evil: XSS } })));
  await assertFails(setDoc(doc(db, 'cycles/x1d'), probeCycle('atk', { stats: { duration: NaN, peak_w: 1 } })));
});

test('A2 cycle attached to a program that does not exist or belongs to another device is refused', async () => {
  await seedProbeWorld();
  const db = gh('atk').firestore();
  // The auditor's payload: a program id under a foreign device that was never created.
  await assertFails(setDoc(doc(db, 'cycles/x2'), probeCycle('atk', { profileId: 'washer__miele__w1__cotton-90' })));
  // An existing program, but the cycle claims a different device.
  await seedDoc('devices/washer__atk__m1', { applianceType: 'washer', brand: 'Atk', brand_lc: 'atk', model: 'M1', model_lc: 'm1', status: 'pending' });
  await assertFails(setDoc(doc(db, 'cycles/x2b'), probeCycle('atk', { deviceId: 'washer__atk__m1' })));
  // Ids that do not nest (<device>__<program>) or are not catalog ids at all.
  await assertFails(setDoc(doc(db, 'cycles/x2c'), probeCycle('atk', { profileId: 'washer__atk__m1__eco' })));
  await assertFails(setDoc(doc(db, 'cycles/x2d'), probeCycle('atk', { profileId: 'washer__miele__w1__eco/ratings/x' })));
  // The cycle's applianceType must match its device id.
  await assertFails(setDoc(doc(db, 'cycles/x2e'), probeCycle('atk', { applianceType: 'dryer' })));
});

test('A3 cycle pointing at a device that does not exist is refused', async () => {
  await seedProbeWorld();
  await assertFails(setDoc(doc(gh('atk').firestore(), 'cycles/x3'), probeCycle('atk', { deviceId: 'nope__nope__nope', profileId: 'nope' })));
  await assertFails(setDoc(doc(gh('atk').firestore(), 'cycles/x3b'),
    probeCycle('atk', { deviceId: 'washer__nope__nope', profileId: 'washer__nope__nope__eco' })));
});

test('A4 cycle created with a forged rating aggregate is refused', async () => {
  await seedProbeWorld();
  await assertFails(setDoc(doc(gh('atk').firestore(), 'cycles/x4'), probeCycle('atk', { ratingSum: 500, ratingCount: 100 })));
  // Zero-initialised aggregates (STORE-15) stay allowed.
  await assertSucceeds(setDoc(doc(gh('atk').firestore(), 'cycles/x4ok'), probeCycle('atk', { ratingSum: 0, ratingCount: 0 })));
});

test('A5 cycle with garbage trace contents is refused', async () => {
  await seedProbeWorld();
  const db = gh('atk').firestore();
  await assertFails(setDoc(doc(db, 'cycles/x5'), probeCycle('atk', {
    trace: { points: [{ o: 'a', w: { z: 1 } }, { evil: XSS }], sampleIntervalSec: -1 } })));
  // Malformed end points, an out-of-range interval, junk trace keys, a one-point trace.
  await assertFails(setDoc(doc(db, 'cycles/x5b'), probeCycle('atk', {
    trace: { points: [{ o: 'a', w: { z: 1 } }, { evil: XSS }], sampleIntervalSec: 5 } })));
  await assertFails(setDoc(doc(db, 'cycles/x5c'), probeCycle('atk', {
    trace: { points: [{ o: 0, w: 1 }, { o: 60, w: 2 }], sampleIntervalSec: -1 } })));
  await assertFails(setDoc(doc(db, 'cycles/x5d'), probeCycle('atk', {
    trace: { points: [{ o: 0, w: 1 }, { o: 60, w: 2 }], sampleIntervalSec: 5, html: XSS } })));
  await assertFails(setDoc(doc(db, 'cycles/x5e'), probeCycle('atk', {
    trace: { points: [{ o: 0, w: 1 }], sampleIntervalSec: 5 } })));
});

test('A6 device created with self ownerId + forged counters is refused; settings cannot be rewritten freely', async () => {
  const db = gh('atk').firestore();
  await assertFails(setDoc(doc(db, 'devices/washer__atk__m1x'), {
    applianceType: 'washer', brand: 'Atk', brand_lc: 'atk', model: 'M1', model_lc: 'm1', status: 'pending',
    createdByUid: 'atk', favoriteCount: 0, confirmCount: 0, ownerId: 'atk', ratingSum: 50, ratingCount: 10,
    profileCount: 999, cycleCount: 999, createdAt: serverTimestamp(),
  }));
  // Each forged field on its own.
  for (const extra of [{ ownerId: 'atk' }, { ratingSum: 50 }, { ratingCount: 10 }, { profileCount: 999 },
    { cycleCount: 999 }, { profileCount: XSS }, { approvedAt: 1 }]) {
    await assertFails(setDoc(doc(db, 'devices/washer__atk__m1y'), validDevice('atk', { brand: 'Atk', brand_lc: 'atk', ...extra })));
  }
  // Settings at create: allow-listed numeric keys only.
  await assertFails(setDoc(doc(db, 'devices/washer__atk__m1z'), validDevice('atk', { settings: { junk: XSS } })));
  await assertFails(setDoc(doc(db, 'devices/washer__atk__m1z'), validDevice('atk', { settings: { min_power: XSS } })));
  await assertFails(setDoc(doc(db, 'devices/washer__atk__m1z'), validDevice('atk', { settings: { off_delay: -1 } })));
  // The doc id must carry the device's own appliance type.
  await assertFails(setDoc(doc(db, 'devices/dryer__atk__m1'), validDevice('atk')));
  // Even a REAL (admin-assigned) owner cannot write junk into settings.
  await seedDoc('devices/washer__atk__owned', validDevice('creator', { ownerId: 'atk' }));
  await assertFails(updateDoc(doc(db, 'devices/washer__atk__owned'), { settings: { min_power: 99999, off_delay: 1, junk: XSS } }));
  await assertFails(updateDoc(doc(db, 'devices/washer__atk__owned'), { settings: { min_power: XSS } }));
  await assertSucceeds(updateDoc(doc(db, 'devices/washer__atk__owned'), { settings: { min_power: 99999, off_delay: 1 } }));
});

test('A7 profile with self ownerId / oversized description / unrelated id is refused; phases bounded', async () => {
  await seedProbeWorld();
  const db = gh('atk').firestore();
  await assertFails(setDoc(doc(db, 'profiles/totally-unrelated-id'), {
    deviceId: 'washer__miele__w1', program: 'Eco', program_lc: 'eco', status: 'pending', createdByUid: 'atk',
    ownerId: 'atk', description: 'y'.repeat(200000), createdAt: serverTimestamp(),
  }));
  const prof = (over = {}) => ({ deviceId: 'washer__miele__w1', program: 'Cotton', program_lc: 'cotton', status: 'pending',
    createdByUid: 'atk', createdAt: serverTimestamp(), ...over });
  await assertFails(setDoc(doc(db, 'profiles/totally-unrelated-id'), prof()));                       // id not <device>__<program>
  await assertFails(setDoc(doc(db, 'profiles/washer__miele__w1__cotton'), prof({ ownerId: 'atk' })));
  await assertFails(setDoc(doc(db, 'profiles/washer__miele__w1__cotton'), prof({ description: 'y'.repeat(2001) })));
  await assertFails(setDoc(doc(db, 'profiles/washer__miele__w1__cotton'), prof({ cycleCount: 99 })));
  await assertFails(setDoc(doc(db, 'profiles/washer__miele__w1__cotton'), prof({ phases: Array(51).fill({ name: 'p', start: 0, end: 1 }) })));
  await assertFails(setDoc(doc(db, 'profiles/washer__miele__w1__cotton'), prof({ applianceType: 'dryer' })));
  await assertFails(setDoc(doc(db, 'profiles/washer__nope__x__cotton'), prof({ deviceId: 'washer__nope__x' })));  // no parent device
  // Contributing a program under someone else's device is the normal case and stays allowed.
  await assertSucceeds(setDoc(doc(db, 'profiles/washer__miele__w1__cotton'), prof({ description: 'ok' })));
  // Phases: a non-owner cannot rewrite them, an owner only with a bounded list.
  await assertFails(updateDoc(doc(db, 'profiles/washer__miele__w1__cotton'), { phases: [{ name: XSS, start: 'a', end: [] }] }));
  await seedDoc('profiles/washer__miele__w1__owned', { deviceId: 'washer__miele__w1', program: 'Owned', program_lc: 'owned', status: 'approved', ownerId: 'atk' });
  await assertFails(updateDoc(doc(db, 'profiles/washer__miele__w1__owned'), { phases: 'not a list' }));
  await assertFails(updateDoc(doc(db, 'profiles/washer__miele__w1__owned'), { phases: Array(51).fill({ name: 'p', start: 0, end: 1 }) }));
  await assertSucceeds(updateDoc(doc(db, 'profiles/washer__miele__w1__owned'), { phases: [{ name: 'Wash', start: 0, end: 600 }] }));
});

test('A8 favoriteCount cannot be pumped (one +1 per user, tied to their favorites list)', async () => {
  await seedProbeWorld();
  await seedDoc('users/atk', { uid: 'atk', status: 'active', favorites: [] });
  const db = gh('atk').firestore();
  // The probe: bare +1, three times.
  await assertFails(updateDoc(doc(db, 'devices/washer__miele__w1'), { favoriteCount: 1 }));
  await assertFails(updateDoc(doc(db, 'devices/washer__miele__w1'), { favoriteCount: increment(1) }));
  // The honest add works once...
  const fav = (favorites, delta) => {
    const b = writeBatch(db);
    b.update(doc(db, 'users/atk'), { favorites });
    b.update(doc(db, 'devices/washer__miele__w1'), { favoriteCount: increment(delta) });
    return b.commit();
  };
  await assertSucceeds(fav(['washer__miele__w1'], 1));
  // ...and cannot be repeated while the device is already in the list.
  await assertFails(updateDoc(doc(db, 'devices/washer__miele__w1'), { favoriteCount: increment(1) }));
  await assertFails(fav(['washer__miele__w1'], 1));
  // Dropping it from the list without the -1 (the other half of a pump loop) is refused.
  await assertFails(updateDoc(doc(db, 'users/atk'), { favorites: [] }));
  // A +2 / mismatched step is refused; the honest remove works.
  await assertFails(fav([], 1));
  await assertSucceeds(fav([], -1));
  const after = await getDoc(doc(db, 'devices/washer__miele__w1'));
  assert.equal(after.data().favoriteCount, 0);
  // A fresh user doc cannot be created with favorites pre-filled (that would allow a free -1).
  await assertFails(setDoc(doc(gh('atk2').firestore(), 'users/atk2'), { uid: 'atk2', status: 'active', favorites: ['washer__miele__w1'] }));
});

test('A9 counter +1 is refused unless it names a child created in the same batch', async () => {
  await seedProbeWorld();
  await seedDoc('brands/miele', { brand: 'Miele', brand_lc: 'miele', status: 'approved', deviceCount: 1, cycleCount: 0 });
  const db = gh('atk').firestore();
  // The probe: a bare bump on each counter.
  await assertFails(updateDoc(doc(db, 'devices/washer__miele__w1'), { cycleCount: 1 }));
  await assertFails(updateDoc(doc(db, 'devices/washer__miele__w1'), { profileCount: increment(1) }));
  await assertFails(updateDoc(doc(db, 'profiles/washer__miele__w1__eco'), { cycleCount: increment(1) }));
  await assertFails(updateDoc(doc(db, 'brands/miele'), { deviceCount: increment(1) }));
  await assertFails(updateDoc(doc(db, 'brands/miele'), { cycleCount: increment(1) }));
  // Naming a child that already exists (re-using an old id) is refused too.
  await seedDoc('cycles/old-cycle', { ...probeCycle('victim'), createdAt: new Date() });
  await assertFails(updateDoc(doc(db, 'devices/washer__miele__w1'), { cycleCount: increment(1), lastCycleId: 'old-cycle' }));
  // Naming a NEW child of a different parent is refused.
  await seedDoc('devices/washer__other__x', { applianceType: 'washer', brand: 'Other', brand_lc: 'other', model: 'X', model_lc: 'x', status: 'approved' });
  await seedDoc('profiles/washer__other__x__eco', { deviceId: 'washer__other__x', program: 'Eco', program_lc: 'eco', status: 'approved' });
  const b = writeBatch(db);
  b.set(doc(db, 'cycles/x9'), probeCycle('atk', { profileId: 'washer__other__x__eco', deviceId: 'washer__other__x', brand_lc: 'other' }));
  b.update(doc(db, 'devices/washer__miele__w1'), { cycleCount: increment(1), lastCycleId: 'x9' });
  await assertFails(b.commit());
});

test('probe control: a banned user is refused', async () => {
  await seedProbeWorld();
  await seedDoc('users/bad', { uid: 'bad', status: 'banned' });
  await assertFails(setDoc(doc(gh('bad').firestore(), 'cycles/xb'), probeCycle('bad')));
});

test('users create: only the ensureUserProfile fields; no moderation field can be pre-seeded', async () => {
  const mk = (uid, over = {}) => ({ uid, displayName: 'N', photoURL: null, createdAt: serverTimestamp(),
    lastSeen: serverTimestamp(), status: 'active', favorites: [], githubLogin: 'n', ...over });
  await assertSucceeds(setDoc(doc(gh('nu1').firestore(), 'users/nu1'), mk('nu1'), { merge: true }));
  await assertFails(setDoc(doc(gh('nu2').firestore(), 'users/nu2'), mk('nu2', { removedContentCount: XSS })));
  await assertFails(setDoc(doc(gh('nu3').firestore(), 'users/nu3'), mk('nu3', { banReason: 'x' })));
  await assertFails(setDoc(doc(gh('nu4').firestore(), 'users/nu4'), mk('nu4', { status: 'banned' })));
  // Returning-user self-service update (ensureUserProfile) still works.
  await assertSucceeds(updateDoc(doc(gh('nu1').firestore(), 'users/nu1'), { displayName: 'New', lastSeen: serverTimestamp() }));
});

// ===========================================================================
// Legitimate writes must keep working. Each test below replays one client's EXACT payload:
// the website through the JS SDK (washstore.js), the Home Assistant integration through the
// Firestore REST :commit body it really sends (custom_components/ha_washdata/store_client.py).
// ===========================================================================

// ---- website (washstore.js) -----------------------------------------------------------

test('web ensureBrand: brand create with zeroed counters', async () => {
  await assertSucceeds(setDoc(doc(gh('w1').firestore(), 'brands/webbrand'), {
    brand: 'WebBrand', brand_lc: 'webbrand', status: 'pending', createdByUid: 'w1', createdByName: null,
    createdAt: serverTimestamp(), deviceCount: 0, cycleCount: 0, approvedDeviceCount: 0,
  }));
  // The doc id is the lowercased brand: an alias id is refused.
  await assertFails(setDoc(doc(gh('w1').firestore(), 'brands/alias'), {
    brand: 'WebBrand2', brand_lc: 'webbrand2', status: 'pending', createdByUid: 'w1', createdAt: serverTimestamp(),
  }));
});

const webDevice = (uid, over = {}) => ({
  applianceType: 'washer', brand: 'WebBrand', brand_lc: 'webbrand', model: 'M1', model_lc: 'm1',
  status: 'pending', createdByUid: uid, createdByName: null, manualUrl: null, createdAt: serverTimestamp(),
  favoriteCount: 0, confirmCount: 0, ...over,
});

test('web ensureDevice: device create + brand deviceCount +1 in one batch (and the no-counter fallback)', async () => {
  await seedDoc('brands/webbrand2', { brand: 'WebBrand2', brand_lc: 'webbrand2', status: 'pending', deviceCount: 0 });
  const db = gh('w1').firestore();
  const b = writeBatch(db);
  b.set(doc(db, 'devices/washer__webbrand2__m1'), webDevice('w1', { brand: 'WebBrand2', brand_lc: 'webbrand2' }));
  b.update(doc(db, 'brands/webbrand2'), { deviceCount: increment(1), lastDeviceId: 'washer__webbrand2__m1' });
  await assertSucceeds(b.commit());
  assert.equal((await getDoc(doc(db, 'brands/webbrand2'))).data().deviceCount, 1);
  // _createWithCounters fallback: the device on its own.
  await assertSucceeds(setDoc(doc(db, 'devices/washer__webbrand2__m2'), webDevice('w1', { brand: 'WebBrand2', brand_lc: 'webbrand2', model: 'M2', model_lc: 'm2' })));
  // washer_dryer is spelled washer-dryer in the id (normalizeToken).
  await assertSucceeds(setDoc(doc(db, 'devices/washer-dryer__webbrand2__wd1'),
    webDevice('w1', { applianceType: 'washer_dryer', brand: 'WebBrand2', brand_lc: 'webbrand2', model: 'WD1', model_lc: 'wd1' })));
});

test('web ensureProfile: profile create + device profileCount +1 in one batch', async () => {
  await seedDoc('devices/washer-dryer__webbrand3__wd', { applianceType: 'washer_dryer', brand: 'WebBrand3', brand_lc: 'webbrand3', status: 'pending', profileCount: 0 });
  const db = gh('w1').firestore();
  const b = writeBatch(db);
  // applianceType comes from deviceId.split('__')[0] on the website.
  b.set(doc(db, 'profiles/washer-dryer__webbrand3__wd__bawełna-40'), {
    deviceId: 'washer-dryer__webbrand3__wd', applianceType: 'washer-dryer', program: 'Bawełna 40',
    program_lc: 'bawełna 40', description: '', status: 'pending', createdByUid: 'w1', createdAt: serverTimestamp(),
  });
  b.update(doc(db, 'devices/washer-dryer__webbrand3__wd'), { profileCount: increment(1), lastProfileId: 'washer-dryer__webbrand3__wd__bawełna-40' });
  await assertSucceeds(b.commit());
});

test('web uploadReferenceCycle: cycle create + profile/device/brand cycleCount +1 in one batch', async () => {
  await seedDoc('brands/webbrand4', { brand: 'WebBrand4', brand_lc: 'webbrand4', status: 'pending', cycleCount: 0 });
  await seedDoc('devices/washer__webbrand4__m', { applianceType: 'washer', brand: 'WebBrand4', brand_lc: 'webbrand4', status: 'pending', cycleCount: 0 });
  await seedDoc('profiles/washer__webbrand4__m__eco-50', { deviceId: 'washer__webbrand4__m', program: 'Eco 50', program_lc: 'eco 50', status: 'pending', cycleCount: 0 });
  const db = gh('w1').firestore();
  const ref = doc(collection(db, 'cycles'));
  const b = writeBatch(db);
  b.set(ref, {
    profileId: 'washer__webbrand4__m__eco-50', deviceId: 'washer__webbrand4__m', brand_lc: 'webbrand4',
    program_lc: 'eco 50', applianceType: 'washer', uploaderUid: 'w1', uploaderName: 'Web User',
    status: 'pending', rejectionReason: null,
    trace: { points: [{ o: 0, w: 2.5 }, { o: 30, w: 2100 }, { o: 3600, w: 1 }], sampleIntervalSec: 30 },
    stats: { duration: 3600, energy_wh: 512.25, peak_w: 2100, mean_w: 700 },
    cycleSchemaVersion: 1, downloads: 0, commentCount: 0, confirmCount: 0, qc: 3, createdAt: serverTimestamp(),
  });
  b.update(doc(db, 'profiles/washer__webbrand4__m__eco-50'), { cycleCount: increment(1), lastCycleId: ref.id });
  b.update(doc(db, 'devices/washer__webbrand4__m'), { cycleCount: increment(1), lastCycleId: ref.id });
  b.update(doc(db, 'brands/webbrand4'), { cycleCount: increment(1), lastCycleId: ref.id });
  await assertSucceeds(b.commit());
});

test('web confirmCycle: confirmation doc + confirmCount +1 batch, then promotion at threshold', async () => {
  await seedDoc('config/site', { confirmThreshold: 1 });
  await seedDoc('cycles/c_conf', { ...validCycle('owner'), confirmCount: 0, createdAt: new Date() });
  const db = gh('cv1').firestore();
  const b = writeBatch(db);
  b.set(doc(db, 'cycles/c_conf/confirmations/cv1'), { uid: 'cv1', createdAt: serverTimestamp() });
  b.update(doc(db, 'cycles/c_conf'), { confirmCount: increment(1) });
  await assertSucceeds(b.commit());
  await assertSucceeds(updateDoc(doc(db, 'cycles/c_conf'), { status: 'approved' }));
  await seedDoc('config/site', { confirmThreshold: 5 });
});

test('web addComment / deleteComment: comment + commentCount batches', async () => {
  await seedDoc('cycles/c_cmt', { ...validCycle('owner'), status: 'approved', commentCount: 0, createdAt: new Date() });
  const db = gh('cm1').firestore();
  const ref = doc(collection(db, 'cycles/c_cmt/comments'));
  const b = writeBatch(db);
  b.set(ref, { authorUid: 'cm1', authorName: 'C', text: 'works for me', createdAt: serverTimestamp() });
  b.update(doc(db, 'cycles/c_cmt'), { commentCount: increment(1) });
  await assertSucceeds(b.commit());
  const d = writeBatch(db);
  d.delete(ref);
  d.update(doc(db, 'cycles/c_cmt'), { commentCount: increment(-1) });
  await assertSucceeds(d.commit());
});

test('web owner editors: updateDeviceSettings with every editor field, updateProfilePhases', async () => {
  await seedDoc('devices/washer__ed__m', { applianceType: 'washer', status: 'approved', ownerId: 'own1' });
  await seedDoc('profiles/washer__ed__m__eco', { deviceId: 'washer__ed__m', program: 'Eco', program_lc: 'eco', status: 'approved' });
  const db = gh('own1').firestore();
  // editors.js SETTINGS_FIELDS, parseFloat() values.
  const keys = ['min_power', 'off_delay', 'start_threshold_w', 'stop_threshold_w', 'start_duration_threshold',
    'start_energy_threshold', 'completion_min_seconds', 'running_dead_zone', 'min_off_gap', 'end_energy_threshold',
    'power_off_threshold_w', 'power_off_delay', 'profile_match_threshold', 'profile_unmatch_threshold',
    'profile_match_interval', 'profile_match_min_duration_ratio', 'profile_match_max_duration_ratio',
    'profile_duration_tolerance', 'duration_tolerance', 'auto_label_confidence', 'learning_confidence'];
  const settings = Object.fromEntries(keys.map((k, i) => [k, i % 2 ? i + 0.5 : i]));
  await assertSucceeds(updateDoc(doc(db, 'devices/washer__ed__m'), { settings }));
  await assertSucceeds(updateDoc(doc(db, 'devices/washer__ed__m'), { settings: {} }));    // all fields cleared
  // The device owner edits a program's phase map (editors.js keeps any extra keys of old phases).
  await assertSucceeds(updateDoc(doc(db, 'profiles/washer__ed__m__eco'),
    { phases: [{ name: 'Wash', start: 0, end: 1800 }, { name: 'Spin', start: 1800, end: 2400, color: 'x' }] }));
});

// ---- Home Assistant integration (store_client.py REST :commit) ------------------------

// The integration talks REST with a Firebase ID token. The emulator accepts an unsigned
// token (alg none), the same thing @firebase/rules-unit-testing builds for its contexts.
function b64url(s) { return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function idToken(uid) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://securetoken.google.com/${PID}`, aud: PID, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, firebase: { sign_in_provider: 'github.com', identities: {} },
  };
  return [b64url(JSON.stringify({ alg: 'none', kid: 'fakekid', type: 'JWT' })), b64url(JSON.stringify(payload)), ''].join('.');
}
// Python floats -> doubleValue, ints -> integerValue: mark floats explicitly so the typed
// payload is byte-for-byte what store_client._encode emits.
class F { constructor(v) { this.v = v; } }
const f = (v) => new F(v);
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof F) return { doubleValue: v.v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(v) };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
}
const DOCS = `projects/${PID}/databases/(default)/documents`;
async function restCommit(writes, uid = null) {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const res = await fetch(`http://${host}/v1/${DOCS}:commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer ${idToken(uid)}` } : {}) },
    body: JSON.stringify({ writes }),
  });
  return { status: res.status, body: await res.text() };
}
// StoreClient._commit_create_ex: create-if-missing with a server createdAt.
const restCreate = (path, fields, uid) => restCommit([{
  update: { name: `${DOCS}/${path}`, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, enc(v)])) },
  currentDocument: { exists: false },
  updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
}], uid);
// What the client counts as success: created, or "already exists" (idempotent re-share).
const createOk = (r) => r.status === 200 || r.status === 409 || r.body.includes('ALREADY_EXISTS') || r.body.includes('FAILED_PRECONDITION');

// store_client.upload_reference_cycle, field for field (brand -> device -> profile -> cycle).
function haShare(uid, { type = 'washer', brand = 'HaBrand', model = 'HM-1', program = 'Eco 40', settings, phases, points, interval = 30.0 } = {}) {
  const typeTok = type.replace('_', '-');
  const tokn = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const bId = brand.toLowerCase();
  const dId = `${typeTok}__${tokn(brand)}__${tokn(model)}`;
  const pId = `${dId}__${tokn(program)}`;
  const device = { applianceType: type, brand, brand_lc: bId, model, model_lc: model.toLowerCase(), status: 'pending',
    createdByUid: uid, createdByName: null, manualUrl: null, favoriteCount: 0, confirmCount: 0 };
  if (settings) device.settings = settings;
  const profile = { deviceId: dId, applianceType: type, program, program_lc: program.toLowerCase(), description: '',
    status: 'pending', createdByUid: uid };
  if (phases) Object.assign(profile, { phases, phaseSourceCycleId: 'a'.repeat(64), phasesSchemaVersion: 1 });
  const pts = points || [[0, 1.5], [30, 2150.0], [5400, 0.8]];
  // store_client.trace_hash: sha256 over the profile id + rounded points; the doc id.
  const cycId = createHash('sha256').update(`${pId}|${JSON.stringify(pts)}`).digest('hex');
  const cycle = { profileId: pId, deviceId: dId, brand_lc: bId, program_lc: program.toLowerCase(), applianceType: type,
    uploaderUid: uid, uploaderName: 'Ha User', status: 'pending', rejectionReason: null, traceHash: cycId,
    trace: { points: pts.map(([o, w]) => ({ o: f(o), w: f(w) })), sampleIntervalSec: f(interval) },
    stats: { duration: f(5400.0), peak_w: f(2150.0), mean_w: f(717.4),
      signature: { duration: f(5400.0), total_energy: f(1076.1), max_power: f(2150.0), time_to_first_high: f(30.0),
        high_phase_ratio: f(0.31), p05: f(0.8), p25: f(1.5), p50: f(12.0), p75: f(1900.0), p95: f(2150.0) } },
    cycleSchemaVersion: 1, downloads: 0, commentCount: 0, confirmCount: 0, qc: 1 };
  return { bId, dId, pId, cycId, brand: { brand, brand_lc: bId, status: 'pending', createdByUid: uid }, device, profile, cycle };
}

test('integration share: brand -> device(+settings) -> profile(+phases) -> cycle, exact REST payloads', async () => {
  const s = haShare('ha1', {
    // Every SHAREABLE_SETTING_KEYS entry, as entry.options holds them (ints and floats).
    settings: { min_power: 2, off_delay: f(180.0), start_threshold_w: f(5.0), stop_threshold_w: f(2.5),
      start_duration_threshold: 10, start_energy_threshold: f(0.2), completion_min_seconds: 600, min_off_gap: 900,
      end_energy_threshold: f(0.05), power_off_threshold_w: 0, power_off_delay: 300, profile_match_threshold: f(0.4),
      profile_unmatch_threshold: f(0.35), profile_match_interval: 300, profile_match_min_duration_ratio: f(0.1),
      profile_match_max_duration_ratio: f(1.8), profile_duration_tolerance: f(0.25), duration_tolerance: f(0.1),
      auto_label_confidence: f(0.9), learning_confidence: f(0.6) },
    phases: [{ name: 'Wash', start: f(0.0), end: f(1800.0) }, { name: 'Spin', start: f(4800.0), end: f(5400.0) }],
  });
  for (const [path, fields] of [[`brands/${s.bId}`, s.brand], [`devices/${s.dId}`, s.device],
    [`profiles/${s.pId}`, s.profile], [`cycles/${s.cycId}`, s.cycle]]) {
    const r = await restCreate(path, fields, 'ha1');
    assert.equal(r.status, 200, `${path}: HTTP ${r.status} ${r.body.slice(0, 300)}`);
  }
});

test('integration share: unknown sampling interval (0.0), no energy, washer_dryer, second cycle of an existing program', async () => {
  const s = haShare('ha2', { type: 'washer_dryer', brand: 'Fisher & Paykel', model: 'WD 8060', program: 'Cotton', interval: 0.0 });
  for (const [path, fields] of [[`brands/${s.bId}`, s.brand], [`devices/${s.dId}`, s.device],
    [`profiles/${s.pId}`, s.profile], [`cycles/${s.cycId}`, s.cycle]]) {
    const r = await restCreate(path, fields, 'ha2');
    assert.equal(r.status, 200, `${path}: HTTP ${r.status} ${r.body.slice(0, 300)}`);
  }
  // Re-share (another user, same program): ancestors already exist, so the create
  // precondition refuses them -- which the client treats as success -- and the new cycle lands.
  const t = haShare('ha3', { type: 'washer_dryer', brand: 'Fisher & Paykel', model: 'WD 8060', program: 'Cotton',
    points: [[0, 1.0], [60, 2000.0], [6000, 0.5]] });
  for (const [path, fields] of [[`brands/${t.bId}`, t.brand], [`devices/${t.dId}`, t.device], [`profiles/${t.pId}`, t.profile]]) {
    const r = await restCreate(path, fields, 'ha3');
    assert.ok(createOk(r), `${path}: HTTP ${r.status} ${r.body.slice(0, 300)}`);
  }
  const r = await restCreate(`cycles/${t.cycId}x`, { ...t.cycle, traceHash: `${t.cycId}x` }, 'ha3');
  assert.equal(r.status, 200, `cycle: HTTP ${r.status} ${r.body.slice(0, 300)}`);
  // An identical re-upload collides on the content-hash id: refused, counted as "duplicate".
  const dup = await restCreate(`cycles/${t.cycId}x`, { ...t.cycle, traceHash: `${t.cycId}x` }, 'ha3');
  assert.ok(createOk(dup) && dup.status !== 200, `duplicate: HTTP ${dup.status} ${dup.body.slice(0, 300)}`);
});

test('integration share is refused when its payload is tampered (same REST path)', async () => {
  const s = haShare('ha4', { brand: 'TamperCo' });
  for (const [path, fields] of [[`brands/${s.bId}`, s.brand], [`devices/${s.dId}`, s.device], [`profiles/${s.pId}`, s.profile]]) {
    assert.equal((await restCreate(path, fields, 'ha4')).status, 200);
  }
  const bad = await restCreate(`cycles/${s.cycId}`, { ...s.cycle, stats: { ...s.cycle.stats, peak_w: XSS } }, 'ha4');
  assert.equal(bad.status, 403);
  const badId = await restCreate(`cycles/${s.cycId}`, { ...s.cycle, traceHash: 'not-the-doc-id' }, 'ha4');
  assert.equal(badId.status, 403);
  const badSettings = await restCreate('devices/washer__tamperco__other', { ...s.device, model: 'Other', model_lc: 'other', settings: { junk: 1 } }, 'ha4');
  assert.equal(badSettings.status, 403);
});

test('integration confirm_device / promote / rate_device / bump_downloads / bump_analytics', async () => {
  await seedDoc('config/site', { confirmThreshold: 1 });
  await seedDoc('devices/washer__haconf__m', { applianceType: 'washer', brand: 'HaConf', brand_lc: 'haconf', status: 'pending', confirmCount: 0 });
  await seedDoc('cycles/ha-dl', { ...validCycle('owner'), status: 'approved', downloads: 0, createdAt: new Date() });
  const dev = `${DOCS}/devices/washer__haconf__m`;
  const conf = await restCommit([
    { update: { name: `${dev}/confirmations/hc1`, fields: { uid: enc('hc1') } }, currentDocument: { exists: false },
      updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }] },
    { transform: { document: dev, fieldTransforms: [{ fieldPath: 'confirmCount', increment: enc(1) }] } },
  ], 'hc1');
  assert.equal(conf.status, 200, conf.body.slice(0, 300));
  const promote = await restCommit([{ update: { name: dev, fields: { status: enc('approved') } },
    updateMask: { fieldPaths: ['status'] }, currentDocument: { exists: true } }], 'hc1');
  assert.equal(promote.status, 200, promote.body.slice(0, 300));
  const rate = await restCommit([{ update: { name: `${dev}/ratings/hc1`, fields: { uid: enc('hc1'), rating: enc(4) } },
    updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }] }], 'hc1');
  assert.equal(rate.status, 200, rate.body.slice(0, 300));
  // Anonymous, as the integration sends them.
  const dl = await restCommit([{ transform: { document: `${DOCS}/cycles/ha-dl`,
    fieldTransforms: [{ fieldPath: 'downloads', increment: enc(1) }] } }]);
  assert.equal(dl.status, 200, dl.body.slice(0, 300));
  const an = await restCommit([
    { transform: { document: `${DOCS}/analytics/daily_20261002`, fieldTransforms: [{ fieldPath: 'downloads', increment: enc(1) }] } },
    { transform: { document: `${DOCS}/analytics/totals`, fieldTransforms: [{ fieldPath: 'downloads', increment: enc(1) }] } },
  ]);
  assert.equal(an.status, 200, an.body.slice(0, 300));
  await seedDoc('config/site', { confirmThreshold: 5 });
});
