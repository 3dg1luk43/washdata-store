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
// Brand auto-approval: a brand rides on its MODELS. Every time one of its devices becomes
// approved the brand's approvedDeviceCount goes up by one, and once that reaches
// config/site.brandConfirmThreshold the brand is promoted too.
//
// The un-gameability of the counter lives in firestore.rules (the bump must name the device
// it claims credit for, and that device must go pending -> approved in the same commit) and
// is covered by test/rules/rules.test.mjs. What this file covers is the client half: that the
// counter is credited on every path that approves a device, that it is never credited twice,
// and that the promotion fires at exactly the configured threshold.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./helpers/washstore_loader.mjs', import.meta.url));
const fake = await import('./helpers/fake_firestore.mjs');
const ws = await import('../washstore.js');
const { deviceId } = await import('../lib/ids.js');

ws.init({});

const WM = 'washer';
const dev = (brand, model) => deviceId(WM, brand, model);

function seedBrand(name, status = 'pending', extra = {}) {
  fake.seed(`brands/${name.toLowerCase()}`, {
    brand: name, brand_lc: name.toLowerCase(), status,
    deviceCount: 0, cycleCount: 0, approvedDeviceCount: 0, ...extra,
  });
}
function seedDevice(brand, model, status = 'pending', confirmCount = 0) {
  const id = dev(brand, model);
  fake.seed(`devices/${id}`, {
    applianceType: WM, brand, brand_lc: brand.toLowerCase(), model, model_lc: model.toLowerCase(),
    status, confirmCount, favoriteCount: 0, profileCount: 0, cycleCount: 0,
  });
  const b = fake.raw(`brands/${brand.toLowerCase()}`);
  if (b) {
    fake.seed(`brands/${brand.toLowerCase()}`, {
      ...b,
      deviceCount: (b.deviceCount || 0) + 1,
      approvedDeviceCount: (b.approvedDeviceCount || 0) + (status === 'approved' ? 1 : 0),
    });
  }
  return id;
}

// The threshold accessors memoize, so set them through the real API after every reset --
// that writes config/site AND refreshes the module cache deterministically.
async function setThresholds({ device = 1, brand = 2 } = {}) {
  fake.seed('config/site', {});
  await ws.setConfirmThreshold(device);
  await ws.setBrandConfirmThreshold(brand);
}

beforeEach(() => fake.reset());

test('a brand is promoted exactly when its Nth model is approved', async () => {
  await setThresholds({ device: 1, brand: 2 });
  seedBrand('Bosch');
  const d1 = seedDevice('Bosch', 'abc123', 'pending', 1);
  const d2 = seedDevice('Bosch', 'abc124', 'pending', 1);

  const r1 = await ws.confirmDevice(d1);
  assert.equal(r1.status, 'approved', 'the device itself is approved');
  assert.equal(fake.raw('brands/bosch').approvedDeviceCount, 1);
  assert.equal(fake.raw('brands/bosch').status, 'pending', 'one model is below the brand bar');
  assert.equal(r1.brand.status, 'pending');

  const r2 = await ws.confirmDevice(d2);
  assert.equal(fake.raw('brands/bosch').approvedDeviceCount, 2);
  assert.equal(fake.raw('brands/bosch').status, 'approved', 'the second model carries the brand');
  assert.equal(r2.brand.status, 'approved');
  // Provenance the rule reads back: which device earned the last credit.
  assert.equal(fake.raw('brands/bosch').lastApprovedDeviceId, d2);
});

test('the device flip and the brand credit are committed together', async () => {
  // The rule authorizes the bump only while the same commit turns the device approved, so a
  // split into two writes would be denied in production. Assert they share one batch.
  await setThresholds({ device: 1, brand: 5 });
  seedBrand('Bosch');
  const d = seedDevice('Bosch', 'abc123', 'pending', 1);
  await ws.confirmDevice(d);
  const w = fake.writes();
  // confirmDevice touches the device twice: the confirmCount bump first, then the status
  // flip in the promotion batch. It is the LAST device write that must sit with the brand
  // credit, so search from the end.
  const devFlip = w.map((x) => x.path).lastIndexOf(`devices/${d}`);
  const brandBump = w.map((x) => x.path).lastIndexOf('brands/bosch');
  assert.ok(devFlip >= 0 && brandBump >= 0);
  assert.equal(brandBump - devFlip, 1, 'the status flip and the brand credit are one batch');
});

test('confirming an already-approved device credits the brand no further', async () => {
  await setThresholds({ device: 1, brand: 5 });
  seedBrand('Bosch');
  const d = seedDevice('Bosch', 'abc123', 'approved', 1);
  fake.seed(`devices/${d}/confirmations/other`, { uid: 'other' });

  const before = fake.raw('brands/bosch').approvedDeviceCount;
  await ws.confirmDevice(d);
  assert.equal(fake.raw('brands/bosch').approvedDeviceCount, before,
    'an approved device cannot be counted a second time');
});

test('a second confirmation from the same user does not double-credit', async () => {
  await setThresholds({ device: 1, brand: 5 });
  seedBrand('Bosch');
  const d = seedDevice('Bosch', 'abc123', 'pending', 1);
  await ws.confirmDevice(d);
  assert.equal(fake.raw('brands/bosch').approvedDeviceCount, 1);
  await ws.confirmDevice(d);   // same uid, device already approved
  assert.equal(fake.raw('brands/bosch').approvedDeviceCount, 1);
});

test('a brand below its threshold stays pending however many models it has pending', async () => {
  await setThresholds({ device: 1, brand: 3 });
  seedBrand('Bosch');
  seedDevice('Bosch', 'a', 'pending', 1);
  seedDevice('Bosch', 'b', 'pending', 1);
  assert.equal(fake.raw('brands/bosch').status, 'pending');
  assert.equal(fake.raw('brands/bosch').approvedDeviceCount, 0,
    'pending models must not vouch for the brand');
});

test('an admin approving a model promotes the brand the same way a confirmation does', async () => {
  await setThresholds({ device: 5, brand: 1 });
  seedBrand('Bosch');
  const d = seedDevice('Bosch', 'abc123', 'pending', 0);
  await ws.adminSetDeviceStatus(d, 'approved');
  assert.equal(fake.raw('brands/bosch').approvedDeviceCount, 1);
  assert.equal(fake.raw('brands/bosch').status, 'approved');
});

test('an admin un-approving a model gives the credit back', async () => {
  await setThresholds({ device: 5, brand: 2 });
  seedBrand('Bosch', 'approved');
  const d = seedDevice('Bosch', 'abc123', 'approved', 0);
  assert.equal(fake.raw('brands/bosch').approvedDeviceCount, 1);
  await ws.adminSetDeviceStatus(d, 'removed');
  assert.equal(fake.raw('brands/bosch').approvedDeviceCount, 0);
  assert.equal(fake.raw('brands/bosch').deviceCount, 0, 'and it stops being visible');
  // Demotion of the brand itself stays an admin decision: an already-approved brand is not
  // silently un-approved when its models go away.
  assert.equal(fake.raw('brands/bosch').status, 'approved');
});

test('a device with no brand doc still gets approved (bookkeeping never blocks approval)', async () => {
  // Brand ids are lc(name) while device ids use a normalised token, so a device namespace can
  // exist with no brand document behind it. The combined batch fails as a whole there.
  await setThresholds({ device: 1, brand: 2 });
  const d = seedDevice('Bosch', 'abc123', 'pending', 1);   // no seedBrand
  const res = await ws.confirmDevice(d);
  assert.equal(res.status, 'approved');
  assert.equal(fake.raw(`devices/${d}`).status, 'approved');
  assert.equal(res.brand, null);
});

test('the brand threshold falls back to the device threshold when unset', async () => {
  // Both accessors memoize for the life of the module, and earlier tests have already primed
  // them. Import a SECOND washstore instance (distinct specifier, same in-memory store) so
  // the fallback is observed on cold caches rather than asserted against a primed one.
  fake.seed('config/site', { confirmThreshold: 4 });   // no brandConfirmThreshold
  const fresh = await import('../washstore.js?cold=fallback');
  fresh.init({});
  assert.equal(await fresh.confirmThresholdValue(), 4);
  assert.equal(await fresh.brandConfirmThresholdValue(), 4,
    'an unset brand threshold reuses the device threshold');
});

test('a set brand threshold is used in preference to the device threshold', async () => {
  fake.seed('config/site', { confirmThreshold: 9, brandConfirmThreshold: 2 });
  const fresh = await import('../washstore.js?cold=explicit');
  fresh.init({});
  assert.equal(await fresh.confirmThresholdValue(), 9);
  assert.equal(await fresh.brandConfirmThresholdValue(), 2);
});

test('adminRecount rebuilds approvedDeviceCount from the devices that exist', async () => {
  seedBrand('Bosch', 'approved', { approvedDeviceCount: 99 });   // drifted
  seedDevice('Bosch', 'a', 'approved');
  seedDevice('Bosch', 'b', 'pending');
  seedDevice('Bosch', 'c', 'removed');
  await ws.adminRecount();
  assert.equal(fake.raw('brands/bosch').approvedDeviceCount, 1, 'only the approved model counts');
  assert.equal(fake.raw('brands/bosch').deviceCount, 2, 'visible = approved + pending');
});
