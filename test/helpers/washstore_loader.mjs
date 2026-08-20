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
// ESM resolve hook: washstore.js imports Firebase straight from gstatic (it runs in the
// browser with no bundler), so node cannot load it. Redirect those specifiers -- and the
// REST helper -- to the in-memory double, which lets the tests drive the REAL merge
// functions rather than a copy of them.
const FAKE = new URL('./fake_firestore.mjs', import.meta.url).href;

const REDIRECT = [
  'firebase-app.js',
  'firebase-auth.js',
  'firebase-firestore.js',
];

export function resolve(specifier, context, next) {
  if (specifier.startsWith('https://www.gstatic.com/firebasejs/')
      && REDIRECT.some((f) => specifier.endsWith(f))) {
    return { url: FAKE, shortCircuit: true };
  }
  if (specifier === './firestore-rest.js') {
    return { url: FAKE, shortCircuit: true };
  }
  return next(specifier, context);
}
