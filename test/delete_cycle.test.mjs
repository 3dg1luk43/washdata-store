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
// Drives the real washstore.deleteCycle (uploader and admin delete) against the in-memory
// Firestore double: the parents' cycleCount must drop by exactly one, the subdocs must go
// with the cycle, and a missing parent must not sink the whole batch.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./helpers/washstore_loader.mjs', import.meta.url));
const fake = await import('./helpers/fake_firestore.mjs');
const ws = await import('../washstore.js');

ws.init({});

const DEV = 'washer__bosch__wat';
const PROF = `${DEV}__eco-40`;

function seedWorld({ count = 2, brand = true } = {}) {
  if (brand) fake.seed('brands/bosch', { brand: 'Bosch', brand_lc: 'bosch', status: 'approved', cycleCount: count });
  fake.seed(`devices/${DEV}`, { brand: 'Bosch', brand_lc: 'bosch', status: 'approved', cycleCount: count });
  fake.seed(`profiles/${PROF}`, { deviceId: DEV, program: 'Eco 40', status: 'approved', cycleCount: count });
}
function seedCycle(id, status = 'approved') {
  fake.seed(`cycles/${id}`, { profileId: PROF, deviceId: DEV, brand_lc: 'bosch', status, uploaderUid: 'u1' });
}
const counts = () => ['profiles/' + PROF, 'devices/' + DEV, 'brands/bosch'].map((p) => (fake.raw(p) || {}).cycleCount);

beforeEach(() => fake.reset());

test('deleteCycle removes the cycle, one count from each parent, and its subdocs', async () => {
  seedWorld();
  seedCycle('c1');
  seedCycle('c2');
  for (const p of ['confirmations/u2', 'ratings/u2', 'ratings/u3', 'comments/k1', 'comments/k2']) {
    fake.seed(`cycles/c1/${p}`, { x: 1 });
  }
  fake.seed('cycles/c1/reports/r1', { status: 'open' });
  fake.seed('cycles/c2/ratings/u2', { rating: 5 });

  await ws.deleteCycle('c1');

  assert.equal(fake.raw('cycles/c1'), null);
  assert.deepEqual(counts(), [1, 1, 1]);
  assert.equal(fake.raw(`profiles/${PROF}`).lastRemovedCycleId, 'c1');
  // Subdocs gone; reports kept for the admin queue; the sibling cycle untouched.
  assert.deepEqual(fake.paths('cycles/c1'), ['cycles/c1/reports/r1']);
  assert.ok(fake.raw('cycles/c2'));
  assert.ok(fake.raw('cycles/c2/ratings/u2'));
});

test('an uncounted (removed) cycle moves no counter', async () => {
  seedWorld();
  seedCycle('c1', 'removed');
  await ws.deleteCycle('c1');
  assert.equal(fake.raw('cycles/c1'), null);
  assert.deepEqual(counts(), [2, 2, 2]);
});

test('a missing parent doc or a counter already at 0 is skipped, the rest still move', async () => {
  seedWorld({ brand: false });
  seedCycle('c1');
  await ws.deleteCycle('c1');
  assert.equal(fake.raw('cycles/c1'), null);
  assert.deepEqual(counts(), [1, 1, undefined]);

  fake.reset();
  seedWorld({ count: 0 });
  seedCycle('c2');
  await ws.deleteCycle('c2');
  assert.equal(fake.raw('cycles/c2'), null);
  assert.deepEqual(counts(), [0, 0, 0]);
});

test('an unknown cycle id throws and writes nothing', async () => {
  seedWorld();
  await assert.rejects(ws.deleteCycle('nope'), /not found/);
  assert.equal(fake.writes().length, 0);
});
