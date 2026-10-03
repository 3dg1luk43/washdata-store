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

// Merge one page of approved and one of pending brands into a single page with a cursor.
//
// The landing used to merge the two first pages, slice to 60 and return no cursor, so every
// brand after the 60th (Miele, Siemens, Samsung, Whirlpool...) was reachable only through
// search. Each status is its own brand_lc-ordered stream behind ONE shared cursor: a page may
// only end where both streams are complete, i.e. at the earlier last name of any stream that
// came back full, or the next page would skip what that stream had not fetched yet. Code-unit
// order, as Firestore orders brand_lc (it is ASCII-lowercased; localeCompare would not match).
export function mergeBrandPages(a, p, pageSize) {
  const lc = (b) => String((b && b.brand_lc) || '');
  let bound = null;
  for (const s of [a, p]) {
    if (s.length === pageSize) {
      const last = lc(s[s.length - 1]);
      if (bound === null || last < bound) bound = last;
    }
  }
  const byId = new Map();
  for (const b of [...a, ...p]) byId.set(b.id, b);
  let items = [...byId.values()].sort((x, y) => (lc(x) < lc(y) ? -1 : lc(x) > lc(y) ? 1 : 0));
  if (bound !== null) items = items.filter((b) => lc(b) <= bound);
  const more = bound !== null || items.length > pageSize;
  items = items.slice(0, pageSize);
  return { items, cursor: more && items.length ? lc(items[items.length - 1]) : null };
}
