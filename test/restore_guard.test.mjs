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
// Soft removal must be reversible and must never strand an appliance under a hidden or
// missing brand. Drives the real washstore.js admin functions against the in-memory
// Firestore double, like merge_store.test.mjs.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./helpers/washstore_loader.mjs', import.meta.url));
const fake = await import('./helpers/fake_firestore.mjs');
const ws = await import('../washstore.js');
const { deviceId, profileId } = await import('../lib/ids.js');

ws.init({});

function brand(name, extra = {}) {
  fake.seed(`brands/${name.toLowerCase()}`, {
    brand: name, brand_lc: name.toLowerCase(), status: 'approved',
    deviceCount: 0, cycleCount: 0, approvedDeviceCount: 0, ...extra,
  });
}
function device(brandName, model, extra = {}) {
  const id = deviceId('washer', brandName, model);
  fake.seed(`devices/${id}`, {
    applianceType: 'washer', brand: brandName, brand_lc: brandName.toLowerCase(), model,
    status: 'approved', profileCount: 0, cycleCount: 0, favoriteCount: 0, confirmCount: 0, ...extra,
  });
  return id;
}

beforeEach(() => {
  fake.reset();
  // Brands auto-approve once two of their models are.
  fake.seed('config/site', { confirmThreshold: 3, brandConfirmThreshold: 2 });
});

test('a brand with visible appliances can be neither removed nor deleted', async () => {
  brand('Sharp', { status: 'pending', deviceCount: 1 });
  device('Sharp', 'ES-1', { status: 'pending' });
  await assert.rejects(ws.adminSetBrandStatus('sharp', 'removed'), /still has 1 appliance/);
  await assert.rejects(ws.adminDeleteBrand('sharp'), /still has 1 appliance/);
  assert.equal(fake.raw('brands/sharp').status, 'pending');
});

test('removal records the old status, and delete still refuses while removed appliances remain', async () => {
  brand('Sharp', { status: 'approved' });
  const d = device('Sharp', 'ES-1', { status: 'removed' });
  await ws.adminSetBrandStatus('sharp', 'removed');
  assert.equal(fake.raw('brands/sharp').status, 'removed');
  assert.equal(fake.raw('brands/sharp').removedFrom, 'approved');
  await assert.rejects(ws.adminDeleteBrand('sharp'), /1 appliance \(1 of them removed\)/);
  await ws.adminDeleteDevice(d);
  await ws.adminDeleteBrand('sharp');
  assert.equal(fake.raw('brands/sharp'), null);
});

test('restoring an appliance restores its removed brand first, each to its old status', async () => {
  brand('Sharp', { status: 'removed', removedFrom: 'approved' });
  const d = device('Sharp', 'ES-1', { status: 'removed', removedFrom: 'pending' });
  const restored = await ws.adminRestore('device', d);
  assert.deepEqual(restored.map((r) => [r.kind, r.status]), [['brand', 'approved'], ['device', 'pending']]);
  const b = fake.raw('brands/sharp');
  assert.equal(b.status, 'approved');
  assert.equal(b.removedFrom, null);
  assert.equal(b.deviceCount, 1, 'the restored appliance is counted again');
  assert.equal(fake.raw(`devices/${d}`).status, 'pending');
});

test('restoring a cycle walks brand -> appliance -> program and fixes every counter', async () => {
  brand('Miele', { status: 'approved', deviceCount: 0, cycleCount: 0 });
  const d = device('Miele', 'W1', { status: 'removed', removedFrom: 'approved' });
  const p = profileId(d, 'Cotton 40');
  fake.seed(`profiles/${p}`, { deviceId: d, program: 'Cotton 40', program_lc: 'cotton 40', status: 'removed', removedFrom: 'approved', cycleCount: 0 });
  fake.seed('cycles/c1', { deviceId: d, profileId: p, brand_lc: 'miele', program_lc: 'cotton 40', applianceType: 'washer', status: 'removed' });
  const restored = await ws.adminRestore('cycle', 'c1');
  assert.deepEqual(restored.map((r) => r.kind), ['device', 'profile', 'cycle']);
  assert.equal(fake.raw('cycles/c1').status, 'pending', 'no recorded status -> pending');
  assert.equal(fake.raw(`profiles/${p}`).status, 'approved');
  assert.equal(fake.raw(`profiles/${p}`).cycleCount, 1);
  assert.equal(fake.raw(`devices/${d}`).cycleCount, 1);
  assert.equal(fake.raw(`devices/${d}`).profileCount, 1);
  assert.equal(fake.raw('brands/miele').cycleCount, 1);
  assert.equal(fake.raw('brands/miele').approvedDeviceCount, 1);
});

test('restore refuses when the parent appliance is gone', async () => {
  fake.seed('profiles/x__y', { deviceId: 'washer__gone__y', program: 'Y', status: 'removed' });
  await assert.rejects(ws.adminRestore('profile', 'x__y'), /no longer exists/);
});

test('merging an approved appliance into a pending one keeps the approval and promotes the brand', async () => {
  brand('Bosch', { status: 'pending', deviceCount: 3, approvedDeviceCount: 2 });
  device('Bosch', 'A', { status: 'approved' });
  const from = device('Bosch', 'B-dup', { status: 'approved' });
  const to = device('Bosch', 'B', { status: 'pending' });
  const res = await ws.adminMergeDevices(from, to);
  assert.equal(res.approved, true);
  assert.equal(fake.raw(`devices/${to}`).status, 'approved');
  const b = fake.raw('brands/bosch');
  assert.equal(b.deviceCount, 2);
  assert.equal(b.approvedDeviceCount, 2, 'the approval moved, it was neither lost nor duplicated');
  assert.equal(b.status, 'approved', 'two approved models meet the brand bar');
});

test('a merge into a removed appliance is refused', async () => {
  brand('Bosch');
  const from = device('Bosch', 'B-dup');
  const to = device('Bosch', 'B', { status: 'removed' });
  await assert.rejects(ws.adminMergeDevices(from, to), /target appliance is removed/);
  assert.ok(fake.raw(`devices/${from}`), 'source untouched');
});

test('per-brand recount repairs a drifted approved tally and promotes the brand', async () => {
  brand('Siemens', { status: 'pending', deviceCount: 9, approvedDeviceCount: 0 });
  device('Siemens', 'A', { status: 'approved' });
  device('Siemens', 'B', { status: 'approved' });
  device('Siemens', 'C', { status: 'pending' });
  const res = await ws.adminRecountBrand('siemens');
  assert.equal(res.deviceCount, 3);
  assert.equal(res.approvedDeviceCount, 2);
  assert.equal(fake.raw('brands/siemens').status, 'approved');
});

test('global recount promotes every pending brand that has enough approved models', async () => {
  brand('LG', { status: 'pending', approvedDeviceCount: 0 });
  brand('Haier', { status: 'pending', approvedDeviceCount: 0 });
  device('LG', 'A', { status: 'approved' });
  device('LG', 'B', { status: 'approved' });
  device('Haier', 'A', { status: 'approved' });
  const res = await ws.adminRecount();
  assert.equal(res.promotedBrands, 1);
  assert.equal(fake.raw('brands/lg').status, 'approved');
  assert.equal(fake.raw('brands/lg').approvedDeviceCount, 2);
  assert.equal(fake.raw('brands/haier').status, 'pending');
});
