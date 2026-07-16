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
import { downsampleCycle, parseCycle, cycleStats, packPoints, unpackPoints } from '../lib/trace.js';

test('packPoints -> {o,w} maps (Firestore-legal); unpackPoints round-trips to pairs', () => {
  const pairs = [[0, 2000], [60, 100]];
  const packed = packPoints(pairs);
  assert.deepEqual(packed, [{ o: 0, w: 2000 }, { o: 60, w: 100 }]);
  // No element is an array (Firestore forbids nested arrays).
  assert.ok(packed.every((p) => !Array.isArray(p)));
  assert.deepEqual(unpackPoints(packed), pairs);
  // unpackPoints is defensive: already-paired data passes through.
  assert.deepEqual(unpackPoints(pairs), pairs);
});

test('downsampleCycle caps to max points, keeps short traces intact', () => {
  const short = [[0, 1], [1, 2]];
  assert.deepEqual(downsampleCycle(short, 3000), short);
  const long = Array.from({ length: 10000 }, (_, i) => [i, i]);
  const ds = downsampleCycle(long, 3000);
  assert.equal(ds.length, 3000);
  // First and last samples are always preserved (true cycle start/end).
  assert.deepEqual(ds[0], long[0]);
  assert.deepEqual(ds[ds.length - 1], long[long.length - 1]);
});

test('parseCycle handles JSON array of pairs', () => {
  assert.deepEqual(parseCycle('[[0,1],[5,100]]'), [[0, 1], [5, 100]]);
});

test('parseCycle handles CSV with header comment lines skipped', () => {
  assert.deepEqual(parseCycle('# t,w\n0,1\n5,100'), [[0, 1], [5, 100]]);
});

test('parseCycle handles {times,values} object form', () => {
  assert.deepEqual(parseCycle('{"times":[0,5],"values":[1,100]}'), [[0, 1], [5, 100]]);
});

test('parseCycle throws on empty input', () => {
  assert.throws(() => parseCycle(''));
});

test('cycleStats integrates energy (Wh) via trapezoid and reports duration/peak/mean', () => {
  // Constant 3600 W for 3600 s = 3600 Wh.
  const pts = [[0, 3600], [1800, 3600], [3600, 3600]];
  const s = cycleStats(pts);
  assert.equal(s.duration, 3600);
  assert.equal(s.energy_wh, 3600);
  assert.equal(s.peak_w, 3600);
  assert.equal(s.mean_w, 3600);
});

test('cycleStats returns zeros for degenerate input', () => {
  assert.deepEqual(cycleStats([[0, 5]]), { duration: 0, energy_wh: 0, peak_w: 0, mean_w: 0 });
});
