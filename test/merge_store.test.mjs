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
// End-to-end tests for the ADMIN MERGE paths, driving the real washstore.js functions
// against an in-memory Firestore double (see helpers/fake_firestore.mjs). These exist to
// prove the two things a merge can silently get wrong: a child left pointing at a deleted
// parent, and a denormalized counter that drifts.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The hook has to be installed before washstore.js is resolved (it imports Firebase from
// gstatic), so both happen here rather than via a CLI flag -- that keeps the file runnable
// by the plain `node --test test/*.test.mjs` suite.
register(new URL('./helpers/washstore_loader.mjs', import.meta.url));
const fake = await import('./helpers/fake_firestore.mjs');
const ws = await import('../washstore.js');
const { deviceId, profileId } = await import('../lib/ids.js');

ws.init({});

const WM = 'washer';
const dev = (brand, model) => deviceId(WM, brand, model);

function seedBrand(name, extra = {}) {
  fake.seed(`brands/${name.toLowerCase()}`, {
    brand: name, brand_lc: name.toLowerCase(), status: 'approved',
    createdByUid: `u-${name}`, deviceCount: 0, cycleCount: 0, ...extra,
  });
}
function seedDevice(brand, model, extra = {}) {
  const id = dev(brand, model);
  fake.seed(`devices/${id}`, {
    applianceType: WM, brand, brand_lc: brand.toLowerCase(), model, model_lc: model.toLowerCase(),
    status: 'approved', createdByUid: `u-${brand}`, profileCount: 0, cycleCount: 0,
    favoriteCount: 0, confirmCount: 0, ...extra,
  });
  const b = fake.raw(`brands/${brand.toLowerCase()}`);
  if (b) fake.seed(`brands/${brand.toLowerCase()}`, { ...b, deviceCount: (b.deviceCount || 0) + 1 });
  return id;
}
function seedProfile(devId, program, extra = {}) {
  const id = profileId(devId, program);
  fake.seed(`profiles/${id}`, {
    deviceId: devId, program, program_lc: program.toLowerCase(), status: 'approved',
    createdByUid: 'u-p', cycleCount: 0, phases: [], ...extra,
  });
  const d = fake.raw(`devices/${devId}`);
  fake.seed(`devices/${devId}`, { ...d, profileCount: (d.profileCount || 0) + 1 });
  return id;
}
// Seeds one cycle and bumps every denormalized counter, exactly as uploadReferenceCycle does,
// so the "counters are exact afterwards" assertions start from a consistent world.
function seedCycle(id, devId, profId, program, brandLc, extra = {}) {
  fake.seed(`cycles/${id}`, {
    deviceId: devId, profileId: profId, program_lc: program.toLowerCase(), brand_lc: brandLc,
    applianceType: WM, status: 'approved', uploaderUid: 'u-c', downloads: 0, ...extra,
  });
  const visible = (extra.status || 'approved') === 'approved' || (extra.status || '') === 'pending';
  if (!visible) return id;
  for (const [path, key] of [[`profiles/${profId}`, 'cycleCount'], [`devices/${devId}`, 'cycleCount'],
    [`brands/${brandLc}`, 'cycleCount']]) {
    const cur = fake.raw(path);
    if (cur) fake.seed(path, { ...cur, [key]: (cur[key] || 0) + 1 });
  }
  return id;
}

// Recompute every counter from the surviving documents. The stored values must equal these.
function expectedCounts() {
  const vis = (s) => s === 'approved' || s === 'pending';
  const all = (prefix) => fake.paths(`${prefix}/`)
    .filter((p) => p.split('/').length === 2)
    .map((p) => ({ id: p.split('/')[1], ...fake.raw(p) }));
  const cycles = all('cycles').filter((c) => vis(c.status));
  const profiles = all('profiles').filter((p) => vis(p.status));
  const devices = all('devices').filter((d) => vis(d.status));
  const out = { brands: {}, devices: {}, profiles: {} };
  for (const b of all('brands')) out.brands[b.id] = { deviceCount: 0, cycleCount: 0 };
  for (const d of all('devices')) out.devices[d.id] = { profileCount: 0, cycleCount: 0 };
  for (const p of all('profiles')) out.profiles[p.id] = { cycleCount: 0 };
  for (const d of devices) if (out.brands[d.brand_lc]) out.brands[d.brand_lc].deviceCount += 1;
  for (const p of profiles) if (out.devices[p.deviceId]) out.devices[p.deviceId].profileCount += 1;
  for (const c of cycles) {
    if (out.brands[c.brand_lc]) out.brands[c.brand_lc].cycleCount += 1;
    if (out.devices[c.deviceId]) out.devices[c.deviceId].cycleCount += 1;
    if (out.profiles[c.profileId]) out.profiles[c.profileId].cycleCount += 1;
  }
  return out;
}

function assertCountersExact() {
  const exp = expectedCounts();
  for (const [id, c] of Object.entries(exp.brands)) {
    const doc = fake.raw(`brands/${id}`);
    assert.equal(doc.deviceCount, c.deviceCount, `brands/${id}.deviceCount`);
    assert.equal(doc.cycleCount, c.cycleCount, `brands/${id}.cycleCount`);
  }
  for (const [id, c] of Object.entries(exp.devices)) {
    const doc = fake.raw(`devices/${id}`);
    assert.equal(doc.profileCount, c.profileCount, `devices/${id}.profileCount`);
    assert.equal(doc.cycleCount, c.cycleCount, `devices/${id}.cycleCount`);
  }
  for (const [id, c] of Object.entries(exp.profiles)) {
    assert.equal(fake.raw(`profiles/${id}`).cycleCount, c.cycleCount, `profiles/${id}.cycleCount`);
  }
}

// Nothing may reference a document that no longer exists.
function assertNoDanglingRefs() {
  for (const p of fake.paths('cycles/')) {
    if (p.split('/').length !== 2) continue;
    const c = fake.raw(p);
    assert.ok(fake.raw(`devices/${c.deviceId}`), `${p}.deviceId -> missing ${c.deviceId}`);
    assert.ok(fake.raw(`profiles/${c.profileId}`), `${p}.profileId -> missing ${c.profileId}`);
    assert.ok(fake.raw(`brands/${c.brand_lc}`), `${p}.brand_lc -> missing ${c.brand_lc}`);
  }
  for (const p of fake.paths('profiles/')) {
    if (p.split('/').length !== 2) continue;
    assert.ok(fake.raw(`devices/${fake.raw(p).deviceId}`), `${p}.deviceId dangling`);
  }
  for (const p of fake.paths('devices/')) {
    if (p.split('/').length !== 2) continue;
    assert.ok(fake.raw(`brands/${fake.raw(p).brand_lc}`), `${p}.brand_lc dangling`);
  }
}

// A cycle must never disagree with the device/profile it hangs off.
function assertLabelsConsistent() {
  for (const p of fake.paths('cycles/')) {
    if (p.split('/').length !== 2) continue;
    const c = fake.raw(p);
    const d = fake.raw(`devices/${c.deviceId}`);
    const prof = fake.raw(`profiles/${c.profileId}`);
    assert.equal(c.brand_lc, d.brand_lc, `${p}.brand_lc vs its device`);
    assert.equal(c.applianceType, d.applianceType, `${p}.applianceType vs its device`);
    assert.equal(c.program_lc, prof.program_lc, `${p}.program_lc vs its profile`);
    assert.equal(prof.deviceId, c.deviceId, `${p} profile belongs to another device`);
  }
}

beforeEach(() => fake.reset());

// --------------------------------------------------------------------------------
// The reported scenario: model abc123 exists under a misspelled brand AND the real one.
// --------------------------------------------------------------------------------
test('brand merge folds a colliding model into the target and leaves nothing behind', async () => {
  seedBrand('boch');
  seedBrand('Bosch');
  const bad = seedDevice('boch', 'abc123');
  const good = seedDevice('Bosch', 'abc123');
  const badEco = seedProfile(bad, 'Eco 50');
  const badQuick = seedProfile(bad, 'Quick');
  const goodEco = seedProfile(good, 'Eco 50');
  seedCycle('c1', bad, badEco, 'Eco 50', 'boch');
  seedCycle('c2', bad, badEco, 'Eco 50', 'boch');
  seedCycle('c3', bad, badQuick, 'Quick', 'boch');
  seedCycle('c4', good, goodEco, 'Eco 50', 'bosch');

  const res = await ws.adminMergeBrands('boch', 'Bosch');
  assert.deepEqual(res.failed, []);
  assert.equal(res.merged, 1);

  // The misspelled brand and its device are gone; the canonical ones absorbed everything.
  assert.equal(fake.raw('brands/boch'), null);
  assert.equal(fake.raw(`devices/${bad}`), null);
  assert.equal(fake.raw(`profiles/${badEco}`), null);
  assert.equal(fake.raw(`profiles/${badQuick}`), null);
  assert.ok(fake.raw(`devices/${good}`));
  assert.ok(fake.raw(`profiles/${goodEco}`));
  assert.ok(fake.raw(`profiles/${profileId(good, 'Quick')}`), 'the non-colliding program moved across');

  // Every cycle now hangs off the canonical device with canonical labels.
  for (const id of ['c1', 'c2', 'c4']) {
    const c = fake.raw(`cycles/${id}`);
    assert.equal(c.deviceId, good);
    assert.equal(c.profileId, goodEco);
    assert.equal(c.brand_lc, 'bosch');
  }
  assert.equal(fake.raw('cycles/c3').profileId, profileId(good, 'Quick'));

  assertNoDanglingRefs();
  assertLabelsConsistent();
  assertCountersExact();
  assert.equal(fake.raw(`devices/${good}`).cycleCount, 4);
  assert.equal(fake.raw(`profiles/${goodEco}`).cycleCount, 3);
  assert.equal(fake.raw('brands/bosch').cycleCount, 4);
  assert.equal(fake.raw('brands/bosch').deviceCount, 1);
});

test('brand merge into a brand that does not exist yet creates it with exact counts', async () => {
  seedBrand('bosh');
  const d = seedDevice('bosh', 'abc123');
  const p = seedProfile(d, 'Eco');
  seedCycle('c1', d, p, 'Eco', 'bosh');

  const res = await ws.adminMergeBrands('bosh', 'Bosch');
  assert.equal(res.id, 'bosch');
  assert.deepEqual(res.failed, []);
  assert.equal(fake.raw('brands/bosh'), null);
  const brand = fake.raw('brands/bosch');
  assert.equal(brand.brand, 'Bosch');
  assert.equal(brand.brand_lc, 'bosch');
  assertNoDanglingRefs();
  assertLabelsConsistent();
  assertCountersExact();
});

test('a cross-brand device merge keeps both brands cycle totals exact', async () => {
  seedBrand('boch');
  seedBrand('Bosch');
  const bad = seedDevice('boch', 'abc123');
  const good = seedDevice('Bosch', 'abc123');
  const bp = seedProfile(bad, 'Eco');
  seedCycle('c1', bad, bp, 'Eco', 'boch');
  seedCycle('c2', bad, bp, 'Eco', 'boch');

  await ws.adminMergeDevices(bad, good);
  assertNoDanglingRefs();
  assertLabelsConsistent();
  assertCountersExact();
  assert.equal(fake.raw('brands/boch').cycleCount, 0, 'source brand gave up its cycles');
  assert.equal(fake.raw('brands/boch').deviceCount, 0);
  assert.equal(fake.raw('brands/bosch').cycleCount, 2, 'target brand gained them');
});

// --------------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------------
test('merging across appliance types is refused', async () => {
  seedBrand('Bosch');
  const washer = seedDevice('Bosch', 'abc123');
  fake.seed(`devices/${deviceId('dishwasher', 'Bosch', 'xyz')}`, {
    applianceType: 'dishwasher', brand: 'Bosch', brand_lc: 'bosch', model: 'xyz',
    status: 'approved', profileCount: 0, cycleCount: 0,
  });
  await assert.rejects(
    () => ws.adminMergeDevices(washer, deviceId('dishwasher', 'Bosch', 'xyz')),
    /appliance types must match/i);
});

test('merging into a missing target is refused instead of orphaning the children', async () => {
  seedBrand('boch');
  const bad = seedDevice('boch', 'abc123');
  const p = seedProfile(bad, 'Eco');
  // All-hidden children used to make the target counter write vanish, so the merge
  // "succeeded" into a device that never existed.
  seedCycle('c1', bad, p, 'Eco', 'boch', { status: 'removed' });
  await assert.rejects(() => ws.adminMergeDevices(bad, dev('Bosch', 'abc123')),
    /Target device not found/);
  assert.ok(fake.raw(`devices/${bad}`), 'source survives a refused merge');
  assert.equal(fake.raw('cycles/c1').deviceId, bad, 'children untouched');
});

test('merging a profile into a missing target is refused', async () => {
  seedBrand('Bosch');
  const d = seedDevice('Bosch', 'abc123');
  const p = seedProfile(d, 'Eco');
  seedCycle('c1', d, p, 'Eco', 'bosch', { status: 'removed' });
  await assert.rejects(() => ws.adminMergeProfiles(p, profileId(d, 'Nope')),
    /Target profile not found/);
  assert.ok(fake.raw(`profiles/${p}`));
});

test('self-merge is refused for devices, profiles and brands', async () => {
  seedBrand('Bosch');
  const d = seedDevice('Bosch', 'abc123');
  const p = seedProfile(d, 'Eco');
  await assert.rejects(() => ws.adminMergeDevices(d, d), /into itself/);
  await assert.rejects(() => ws.adminMergeProfiles(p, p), /into itself/);
});

// --------------------------------------------------------------------------------
// program_lc: the label the integration names an imported profile from
// --------------------------------------------------------------------------------
test('a profile merge relabels the moved cycles program_lc to the target program', async () => {
  seedBrand('Bosch');
  const d = seedDevice('Bosch', 'abc123');
  const from = seedProfile(d, 'Eco 50');
  const to = seedProfile(d, 'Eco 50C');
  seedCycle('c1', d, from, 'Eco 50', 'bosch');

  await ws.adminMergeProfiles(from, to);
  // Left stale, the integration's import_cycle would re-create a local profile called
  // "eco 50" -- i.e. the duplicate the merge was supposed to remove.
  assert.equal(fake.raw('cycles/c1').program_lc, 'eco 50c');
  assert.equal(fake.raw('cycles/c1').profileId, to);
  assertNoDanglingRefs();
  assertLabelsConsistent();
  assertCountersExact();
});

test('a device merge relabels cycles absorbed by a colliding program', async () => {
  seedBrand('boch');
  seedBrand('Bosch');
  const bad = seedDevice('boch', 'abc123');
  const good = seedDevice('Bosch', 'abc123');
  // Two spellings that normalize to the same profile id but keep different program_lc.
  const badP = seedProfile(bad, 'Eco-50');
  const goodP = seedProfile(good, 'Eco 50');
  assert.equal(profileId(bad, 'Eco-50').split('__').pop(), profileId(good, 'Eco 50').split('__').pop());
  seedCycle('c1', bad, badP, 'Eco-50', 'boch');

  await ws.adminMergeDevices(bad, good);
  assert.equal(fake.raw('cycles/c1').profileId, goodP);
  assert.equal(fake.raw('cycles/c1').program_lc, 'eco 50');
  assertLabelsConsistent();
  assertCountersExact();
});

// --------------------------------------------------------------------------------
// Cross-device profile merge / cycle move
// --------------------------------------------------------------------------------
test('a cross-device profile merge re-points the cycles device, brand and type', async () => {
  seedBrand('boch');
  seedBrand('Bosch');
  const bad = seedDevice('boch', 'abc123');
  const good = seedDevice('Bosch', 'wat28660');
  const from = seedProfile(bad, 'Eco');
  const to = seedProfile(good, 'Eco');
  seedCycle('c1', bad, from, 'Eco', 'boch');
  seedCycle('c2', bad, from, 'Eco', 'boch');

  const res = await ws.adminMergeProfiles(from, to);
  assert.equal(res.crossDevice, true);
  for (const id of ['c1', 'c2']) {
    assert.equal(fake.raw(`cycles/${id}`).deviceId, good);
    assert.equal(fake.raw(`cycles/${id}`).brand_lc, 'bosch');
  }
  assertNoDanglingRefs();
  assertLabelsConsistent();
  assertCountersExact();
  assert.equal(fake.raw('brands/boch').cycleCount, 0);
  assert.equal(fake.raw('brands/bosch').cycleCount, 2);
});

test('a cross-device profile merge of mismatched types is refused', async () => {
  seedBrand('Bosch');
  const washer = seedDevice('Bosch', 'abc123');
  fake.seed(`devices/${deviceId('dryer', 'Bosch', 'dry1')}`, {
    applianceType: 'dryer', brand: 'Bosch', brand_lc: 'bosch', model: 'dry1',
    status: 'approved', profileCount: 0, cycleCount: 0,
  });
  const from = seedProfile(washer, 'Eco');
  const to = seedProfile(deviceId('dryer', 'Bosch', 'dry1'), 'Eco');
  await assert.rejects(() => ws.adminMergeProfiles(from, to), /appliance type/i);
});

test('a cycle moves across devices with every counter level rebalanced', async () => {
  seedBrand('boch');
  seedBrand('Bosch');
  const bad = seedDevice('boch', 'abc123');
  const good = seedDevice('Bosch', 'abc124');
  const from = seedProfile(bad, 'Eco');
  const to = seedProfile(good, 'Cotton 40');
  seedCycle('c1', bad, from, 'Eco', 'boch');

  const res = await ws.adminMoveCycle('c1', to);
  assert.equal(res.crossDevice, true);
  const c = fake.raw('cycles/c1');
  assert.equal(c.deviceId, good);
  assert.equal(c.profileId, to);
  assert.equal(c.program_lc, 'cotton 40');
  assert.equal(c.brand_lc, 'bosch');
  assertNoDanglingRefs();
  assertLabelsConsistent();
  assertCountersExact();
});

test('moving a cycle to a profile of another appliance type is refused', async () => {
  seedBrand('Bosch');
  const washer = seedDevice('Bosch', 'abc123');
  fake.seed(`devices/${deviceId('dryer', 'Bosch', 'dry1')}`, {
    applianceType: 'dryer', brand: 'Bosch', brand_lc: 'bosch', model: 'dry1',
    status: 'approved', profileCount: 0, cycleCount: 0,
  });
  const from = seedProfile(washer, 'Eco');
  const to = seedProfile(deviceId('dryer', 'Bosch', 'dry1'), 'Eco');
  seedCycle('c1', washer, from, 'Eco', 'bosch');
  await assert.rejects(() => ws.adminMoveCycle('c1', to), /appliance type/i);
});

// --------------------------------------------------------------------------------
// Subcollections that outlive their parent
// --------------------------------------------------------------------------------
test('a merged-away device leaves no confirmations or ratings to be inherited', async () => {
  seedBrand('boch');
  seedBrand('Bosch');
  const bad = seedDevice('boch', 'abc123', { confirmCount: 2 });
  const good = seedDevice('Bosch', 'abc123');
  fake.seed(`devices/${bad}/confirmations/u1`, { uid: 'u1' });
  fake.seed(`devices/${bad}/confirmations/u2`, { uid: 'u2' });
  fake.seed(`devices/${bad}/ratings/u1`, { uid: 'u1', rating: 4 });

  await ws.adminMergeDevices(bad, good);
  // Left behind, a re-contributed device deriving the same id would inherit these: every
  // previous confirmer is then locked out of bumping confirmCount, so it can never reach
  // the auto-approve threshold.
  assert.deepEqual(fake.paths(`devices/${bad}/`), []);
});

test('a merged-away object has its open reports resolved, not left haunting the queue', async () => {
  seedBrand('boch');
  seedBrand('Bosch');
  const bad = seedDevice('boch', 'abc123');
  const good = seedDevice('Bosch', 'abc123');
  fake.seed(`devices/${bad}/reports/r1`, { reporterUid: 'r1', reason: 'duplicate', status: 'open' });

  await ws.adminMergeDevices(bad, good);
  const rep = fake.raw(`devices/${bad}/reports/r1`);
  assert.equal(rep.status, 'resolved');
  assert.equal(rep.resolution, 'merged');
});

test('renaming a device model carries its confirmations, ratings and reports to the new id', async () => {
  seedBrand('Bosch');
  const old = seedDevice('Bosch', 'abc123', { confirmCount: 1, ratingCount: 1, ratingSum: 4 });
  const p = seedProfile(old, 'Eco');
  seedCycle('c1', old, p, 'Eco', 'bosch');
  fake.seed(`devices/${old}/confirmations/u1`, { uid: 'u1' });
  fake.seed(`devices/${old}/ratings/u1`, { uid: 'u1', rating: 4 });
  fake.seed(`devices/${old}/reports/r1`, { reporterUid: 'r1', status: 'open' });

  const res = await ws.adminRenameDevice(old, 'WAT 28660');
  assert.equal(res.merged, false);
  const now = dev('Bosch', 'WAT 28660');
  assert.equal(res.id, now);
  // The doc keeps confirmCount/ratingSum, so the subdocs backing them must come along or
  // the counters describe nothing.
  assert.ok(fake.raw(`devices/${now}/confirmations/u1`));
  assert.ok(fake.raw(`devices/${now}/ratings/u1`));
  assert.ok(fake.raw(`devices/${now}/reports/r1`));
  assert.deepEqual(fake.paths(`devices/${old}/`), []);
  assertNoDanglingRefs();
  assertLabelsConsistent();
  assertCountersExact();
});

test('a merge re-points favorites so they do not dangle, and credits the target', async () => {
  seedBrand('boch');
  seedBrand('Bosch');
  const bad = seedDevice('boch', 'abc123', { favoriteCount: 2 });
  const good = seedDevice('Bosch', 'abc123', { favoriteCount: 1 });
  fake.seed('users/u1', { uid: 'u1', favorites: [bad] });
  fake.seed('users/u2', { uid: 'u2', favorites: [bad, good] });

  await ws.adminMergeDevices(bad, good);
  assert.deepEqual(fake.raw('users/u1').favorites, [good]);
  assert.deepEqual(fake.raw('users/u2').favorites, [good], 'no duplicate entry for u2');
  // u1 gained the target, u2 already had it -- so exactly +1.
  assert.equal(fake.raw(`devices/${good}`).favoriteCount, 2);
});

// --------------------------------------------------------------------------------
// Hidden (removed/rejected) children must not move any counter
// --------------------------------------------------------------------------------
test('hidden cycles and profiles move without disturbing the visible counters', async () => {
  seedBrand('boch');
  seedBrand('Bosch');
  const bad = seedDevice('boch', 'abc123');
  const good = seedDevice('Bosch', 'abc123');
  const hiddenP = seedProfile(bad, 'Rejected', { status: 'rejected' });
  const okP = seedProfile(bad, 'Eco');
  seedCycle('c1', bad, hiddenP, 'Rejected', 'boch', { status: 'rejected' });
  seedCycle('c2', bad, okP, 'Eco', 'boch');

  await ws.adminMergeDevices(bad, good);
  assertNoDanglingRefs();
  assertLabelsConsistent();
  assertCountersExact();
  assert.equal(fake.raw(`devices/${good}`).profileCount, 1, 'the rejected profile is not counted');
  assert.equal(fake.raw(`devices/${good}`).cycleCount, 1);
});

// --------------------------------------------------------------------------------
// Idempotence / re-runnability
// --------------------------------------------------------------------------------
test('re-running a completed brand merge is a no-op that still deletes nothing extra', async () => {
  seedBrand('boch');
  seedBrand('Bosch');
  const bad = seedDevice('boch', 'abc123');
  const good = seedDevice('Bosch', 'abc123');
  const p = seedProfile(bad, 'Eco');
  seedCycle('c1', bad, p, 'Eco', 'boch');

  await ws.adminMergeBrands('boch', 'Bosch');
  const after = fake.paths();
  const counts = { dev: fake.raw(`devices/${good}`).cycleCount, brand: fake.raw('brands/bosch').cycleCount };
  await ws.adminMergeBrands('boch', 'Bosch');
  assert.deepEqual(fake.paths(), after, 'no documents created or destroyed on the second run');
  assert.equal(fake.raw(`devices/${good}`).cycleCount, counts.dev, 'counters not double-applied');
  assert.equal(fake.raw('brands/bosch').cycleCount, counts.brand);
});

test('two profiles orphaned by a missing device can still be consolidated', async () => {
  // No brand/device docs at all: an admin must still be able to clean this up, and the
  // counter writes must be skipped rather than failing the batch.
  fake.seed('profiles/ghost__eco', { deviceId: 'ghost', program: 'Eco', program_lc: 'eco', status: 'approved', cycleCount: 1 });
  fake.seed('profiles/ghost__eco-b', { deviceId: 'ghost', program: 'Eco B', program_lc: 'eco b', status: 'approved', cycleCount: 0 });
  fake.seed('cycles/c1', { deviceId: 'ghost', profileId: 'ghost__eco', program_lc: 'eco', brand_lc: 'gone', applianceType: WM, status: 'approved' });

  await ws.adminMergeProfiles('ghost__eco', 'ghost__eco-b');
  assert.equal(fake.raw('profiles/ghost__eco'), null);
  assert.equal(fake.raw('cycles/c1').profileId, 'ghost__eco-b');
  assert.equal(fake.raw('cycles/c1').program_lc, 'eco b');
  assert.equal(fake.raw('profiles/ghost__eco-b').cycleCount, 1);
});
