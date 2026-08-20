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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDeviceMergeOk, assertProfileMergeOk, assertCycleMoveOk, assertBrandMergeOk,
  assertSameApplianceType,
} from '../lib/merge_guard.js';
import { deviceId, profileId } from '../lib/ids.js';

const wm = (brand, model) => deviceId('washer', brand, model);

test('device merge: the "boch abc123 -> bosch abc123" case is allowed (cross-brand is the point)', () => {
  const from = wm('boch', 'abc123');
  const to = wm('bosch', 'abc123');
  assert.notEqual(from, to);
  assert.doesNotThrow(() => assertDeviceMergeOk(from, to,
    { applianceType: 'washer', brand_lc: 'boch', status: 'pending' },
    { applianceType: 'washer', brand_lc: 'bosch', status: 'approved' }));
});

test('device merge: refuses a missing target instead of orphaning the children', () => {
  assert.throws(() => assertDeviceMergeOk('a', 'b', { applianceType: 'washer' }, null),
    /Target device not found/);
  assert.throws(() => assertDeviceMergeOk('a', 'b', null, { applianceType: 'washer' }),
    /Source device not found/);
});

test('device merge: refuses self-merge and empty ids', () => {
  assert.throws(() => assertDeviceMergeOk('a', 'a', {}, {}), /into itself/);
  assert.throws(() => assertDeviceMergeOk('', 'b', {}, {}), /source and a target device/);
  assert.throws(() => assertDeviceMergeOk('a', '', {}, {}), /source and a target device/);
});

test('device merge: refuses crossing appliance type', () => {
  assert.throws(() => assertDeviceMergeOk('a', 'b',
    { applianceType: 'washer' }, { applianceType: 'dishwasher' }),
    /washing machine device into a dishwasher device/);
});

test('appliance type is only compared when both sides declare one (legacy docs stay fixable)', () => {
  assert.doesNotThrow(() => assertSameApplianceType({}, { applianceType: 'dryer' }));
  assert.doesNotThrow(() => assertSameApplianceType({ applianceType: 'dryer' }, {}));
  assert.throws(() => assertSameApplianceType({ applianceType: 'dryer' }, { applianceType: 'washer' }));
});

test('profile merge: same-device is reported as such and needs no device docs', () => {
  const dev = wm('bosch', 'abc123');
  const res = assertProfileMergeOk(profileId(dev, 'Eco 50'), profileId(dev, 'Eco 50C'),
    { deviceId: dev, program: 'Eco 50' }, { deviceId: dev, program: 'Eco 50C' });
  assert.deepEqual(res, { crossDevice: false });
});

test('profile merge: cross-device requires the target device and a matching type', () => {
  const a = wm('boch', 'abc123');
  const b = wm('bosch', 'abc123');
  const fromProf = { deviceId: a, program: 'Eco' };
  const toProf = { deviceId: b, program: 'Eco' };
  assert.throws(
    () => assertProfileMergeOk('p1', 'p2', fromProf, toProf, { applianceType: 'washer' }, null),
    /Target profile's device not found/);
  assert.deepEqual(
    assertProfileMergeOk('p1', 'p2', fromProf, toProf,
      { applianceType: 'washer' }, { applianceType: 'washer' }),
    { crossDevice: true });
  assert.throws(
    () => assertProfileMergeOk('p1', 'p2', fromProf, toProf,
      { applianceType: 'washer' }, { applianceType: 'dryer' }),
    /appliance type/i);
});

test('profile merge: refuses missing target / self / a target with no device', () => {
  assert.throws(() => assertProfileMergeOk('p1', 'p1', {}, {}), /into itself/);
  assert.throws(() => assertProfileMergeOk('p1', 'p2', { deviceId: 'd' }, null), /Target profile not found/);
  assert.throws(() => assertProfileMergeOk('p1', 'p2', null, { deviceId: 'd' }), /Source profile not found/);
  assert.throws(() => assertProfileMergeOk('p1', 'p2', { deviceId: 'd' }, {}), /no device/);
});

test('cycle move: a no-op move is reported, not thrown', () => {
  const res = assertCycleMoveOk('c1', 'p1', { profileId: 'p1', deviceId: 'd1' }, { deviceId: 'd1' });
  assert.deepEqual(res, { moved: false, crossDevice: false });
});

test('cycle move: same-device vs cross-device is classified', () => {
  assert.deepEqual(
    assertCycleMoveOk('c1', 'p2', { profileId: 'p1', deviceId: 'd1' }, { deviceId: 'd1' }),
    { moved: true, crossDevice: false });
  assert.deepEqual(
    assertCycleMoveOk('c1', 'p2', { profileId: 'p1', deviceId: 'd1', applianceType: 'washer' },
      { deviceId: 'd2' }, { applianceType: 'washer' }, { applianceType: 'washer' }),
    { moved: true, crossDevice: true });
});

test('cycle move: falls back to the cycle own applianceType when the source device is gone', () => {
  assert.throws(() => assertCycleMoveOk('c1', 'p2',
    { profileId: 'p1', deviceId: 'd1', applianceType: 'washer' },
    { deviceId: 'd2' }, null, { applianceType: 'dishwasher' }), /appliance type/i);
});

test('cycle move: refuses a missing cycle / target', () => {
  assert.throws(() => assertCycleMoveOk('c1', 'p2', null, { deviceId: 'd' }), /Cycle not found/);
  assert.throws(() => assertCycleMoveOk('c1', 'p2', { deviceId: 'd' }, null), /Target profile not found/);
  assert.throws(() => assertCycleMoveOk('c1', '', { deviceId: 'd' }, { deviceId: 'd' }), /target program/);
});

test('brand merge: trims the name and rejects ids Firestore cannot address', () => {
  assert.equal(assertBrandMergeOk('boch', '  Bosch  '), 'Bosch');
  assert.throws(() => assertBrandMergeOk('boch', ''), /Brand name is required/);
  assert.throws(() => assertBrandMergeOk('boch', '   '), /Brand name is required/);
  assert.throws(() => assertBrandMergeOk('', 'Bosch'), /Source brand is required/);
  assert.throws(() => assertBrandMergeOk('boch', 'Bosch/Siemens'), /may not contain/);
  assert.throws(() => assertBrandMergeOk('boch', 'a\\b'), /may not contain/);
  assert.throws(() => assertBrandMergeOk('boch', '..'), /may not contain/);
  assert.throws(() => assertBrandMergeOk('boch', 'x'.repeat(41)), /40 characters/);
});
