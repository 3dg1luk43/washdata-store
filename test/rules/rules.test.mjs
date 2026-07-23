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
import { doc, setDoc, updateDoc, writeBatch, getDoc, serverTimestamp, increment } from 'firebase/firestore';

let env;
const PID = 'washdata-store';

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: "127.0.0.1", port: 8080 },
  });
});
after(async () => { await env.cleanup(); });

function gh(uid) { return env.authenticatedContext(uid, { firebase: { sign_in_provider: 'github.com' } }); }
function anon() { return env.unauthenticatedContext(); }

const validCycle = (uid) => ({
  profileId: 'washer__bosch__wat__cotton-40', deviceId: 'washer__bosch__wat',
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

test('a user may update their own favorites', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users/u2'), { uid: 'u2', banned: false, favorites: [] });
  });
  await assertSucceeds(updateDoc(doc(gh('u2').firestore(), 'users/u2'), { favorites: ['washer__bosch__wat'] }));
});

const validDevice = (uid, over = {}) => ({
  applianceType: 'washer', brand: 'Bosch', brand_lc: 'bosch', model: 'WAT', model_lc: 'wat',
  status: 'pending', createdByUid: uid, createdByName: null, manualUrl: null,
  createdAt: serverTimestamp(), profileCount: 0, favoriteCount: 0, confirmCount: 0, ...over,
});

test('device create requires github + matching brand_lc; anon denied', async () => {
  await assertSucceeds(setDoc(doc(gh('u1').firestore(), 'devices/washer__bosch__wat'), validDevice('u1')));
  // brand_lc must equal brand.lower(); a lowercase-but-wrong value still fails the rule.
  await assertFails(setDoc(doc(gh('u1').firestore(), 'devices/d_bad_brand_lc'), validDevice('u1', { brand_lc: 'other' })));
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
  // Edit 4 -> 1: sum shifts by -3.
  const bEdit = writeBatch(db);
  bEdit.set(doc(db, 'devices/d_ratec/ratings/dr1'), { uid: 'dr1', rating: 1, updatedAt: new Date() }, { merge: true });
  bEdit.update(doc(db, 'devices/d_ratec'), { ratingSum: increment(-3) });
  await assertSucceeds(bEdit.commit());
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
