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
// Deterministic, convergent IDs. Shared by browser (washstore.js) and node tests.
// Two users with the same appliance/program produce the same device/profile id,
// so their contributions aggregate without a server.
export function lc(s) {
  return String(s == null ? '' : s).toLowerCase();
}

// Lowercase, trim, collapse any run of separator chars to a single hyphen.
// NFKD + a combining-mark strip fold diacritics, so an accented spelling and its
// plain-ASCII equivalent converge to the same token. Letters/numbers of ANY script are
// kept (Unicode-aware), so a non-Latin name (e.g. Cyrillic/CJK) keeps its own distinct
// token instead of collapsing to an empty string and colliding with every other one.
export function normalizeToken(s) {
  return lc(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip combining diacritics
    .replace(/[^\p{L}\p{N}]+/gu, '-')  // keep letters/numbers of any script
    .replace(/^-+|-+$/g, '');
}

export function deviceId(applianceType, brand, model) {
  return [normalizeToken(applianceType), normalizeToken(brand), normalizeToken(model)].join('__');
}

export function profileId(devId, program) {
  return `${devId}__${normalizeToken(program)}`;
}
