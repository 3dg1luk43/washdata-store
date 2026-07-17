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
