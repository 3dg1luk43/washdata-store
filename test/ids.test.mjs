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
import { normalizeToken, deviceId, profileId } from '../lib/ids.js';

test('normalizeToken lowercases, trims, collapses whitespace and punctuation', () => {
  assert.equal(normalizeToken('  Serie 6  WAT28660GB/01 '), 'serie-6-wat28660gb-01');
  assert.equal(normalizeToken('Bosch'), 'bosch');
});

test('deviceId converges for equivalent brand/model spellings', () => {
  const a = deviceId('washer', 'Bosch', 'WAT 28660');
  const b = deviceId('washer', ' bosch ', 'wat-28660');
  assert.equal(a, b);
  assert.equal(a, 'washer__bosch__wat-28660');
});

test('normalizeToken folds diacritics so accented spellings converge', () => {
  // Accent decomposes then the combining mark is stripped, not turned into a hyphen.
  assert.equal(normalizeToken('Crème'), 'creme');
  assert.equal(normalizeToken('Crème'), normalizeToken('Creme'));
  assert.equal(normalizeToken('Café'), 'cafe');
});

test('normalizeToken keeps non-Latin letters (no empty-token collision)', () => {
  // Cyrillic/CJK names must keep their own distinct token, not collapse to ''.
  assert.equal(normalizeToken('Бош'), 'бош');
  assert.notEqual(normalizeToken('Бош'), normalizeToken('Электролюкс'));
  assert.equal(normalizeToken('東芝'), '東芝');
  assert.notEqual(normalizeToken('東芝'), '');
});

test('profileId nests under deviceId', () => {
  const d = deviceId('washer', 'Bosch', 'WAT28660');
  assert.equal(profileId(d, 'Cotton 40'), `${d}__cotton-40`);
});
