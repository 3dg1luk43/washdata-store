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

// Thin wrapper around window.gtag. Safe to call before the gtag script has
// loaded (slow network, ad-blocker, GA_MEASUREMENT_ID not set): events are
// silently dropped. Do not import this in admin.js — admin actions aren't
// tracked, only public store browsing/download actions are.

export function trackEvent(name, params = {}) {
  if (typeof window.gtag === 'function') {
    try { window.gtag('event', name, params); } catch (_) {}
  }
}
