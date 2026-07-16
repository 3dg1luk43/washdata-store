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
// Site-level toggles (not the Firebase config - see config.js for that).

// Maintenance mode: while true, non-admin visitors see a "coming soon" screen and
// the store UI is hidden. Signed-in admins still see the full site (with a banner) so
// they can preview. Flip to false to open the store publicly.
export const MAINTENANCE = true;

export const SITE_NAME = 'WashData Store';
