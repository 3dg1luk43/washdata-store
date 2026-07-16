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
  assert.deepEqual(downsampleCycle(short, 10000), short);
  const long = Array.from({ length: 20000 }, (_, i) => [i * 2, 100]);
  const ds = downsampleCycle(long, 10000);
  assert.equal(ds.length, 10000);
  // First and last samples are always preserved (true cycle start/end).
  assert.deepEqual(ds[0], long[0]);
  assert.deepEqual(ds[ds.length - 1], long[long.length - 1]);
});

test('downsampleCycle (LTTB) preserves prominent peaks that nearest-index skips', () => {
  // 600 samples at 2 s intervals; single spike at sample 300 (3000 W); rest flat at 10 W.
  // At max=100, step≈6.05 so nearest-index rounds to indices 296 and 303, skipping 300.
  // LTTB selects the spike because it maximises triangle area in its bucket.
  const pts = Array.from({ length: 600 }, (_, i) => [i * 2, i === 300 ? 3000 : 10]);
  const ds = downsampleCycle(pts, 100);
  assert.equal(ds.length, 100);
  const maxW = Math.max(...ds.map((p) => p[1]));
  assert.equal(maxW, 3000, 'LTTB must preserve the prominent peak sample');
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
