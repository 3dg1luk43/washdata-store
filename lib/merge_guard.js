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
// Pure pre-flight validation for the admin merge / move operations. No Firebase import,
// so washstore.js (browser) and node tests share exactly one copy of the rules.
//
// The merge helpers move children between parents and then DELETE the source parent, so a
// merge onto a wrong or missing target is unrecoverable. Every one of these guards exists
// because the corresponding mistake silently produced junk before:
//
//   - a missing target left children pointing at a doc that does not exist (the batch only
//     fails when the target also has a counter write, so an all-hidden source merged
//     "successfully" into nothing);
//   - a cross-appliance-type merge parked washing-machine cycles under a dishwasher, whose
//     `applianceType` then disagreed with every cycle it served;
//   - a cross-device profile merge left cycles whose `deviceId` and `profileId` named
//     different devices.
//
// Cross-BRAND is deliberately allowed: folding "boch" into "bosch" is the whole point.

const TYPE_LABEL = {
  washer: 'washing machine',
  dryer: 'dryer',
  dishwasher: 'dishwasher',
  washer_dryer: 'washer-dryer',
};

function typeLabel(t) { return TYPE_LABEL[t] || t || 'unknown type'; }

// Appliance type is the one axis a merge must never cross. Types are compared only when
// BOTH sides declare one, so a legacy doc with no `applianceType` is not blocked from being
// cleaned up. Returns nothing; throws with an admin-readable message.
export function assertSameApplianceType(fromObj, toObj, what = 'device') {
  const a = fromObj && fromObj.applianceType;
  const b = toObj && toObj.applianceType;
  if (a && b && a !== b) {
    throw new Error(
      `Cannot merge a ${typeLabel(a)} ${what} into a ${typeLabel(b)} ${what}. `
      + 'Appliance types must match - rename the entry instead.');
  }
}

// Guard `adminMergeDevices(fromId, toId)`.
export function assertDeviceMergeOk(fromId, toId, fromDev, toDev) {
  if (!fromId || !toId) throw new Error('Both a source and a target device are required');
  if (fromId === toId) throw new Error('Cannot merge a device into itself');
  if (!fromDev) throw new Error('Source device not found');
  if (!toDev) throw new Error('Target device not found');
  assertSameApplianceType(fromDev, toDev, 'device');
}

// Guard `adminMergeProfiles(fromId, toId)`. `fromDev`/`toDev` are only needed when the two
// profiles sit on different devices (the cross-device path relabels the cycles' deviceId /
// brand_lc / applianceType, so it needs both device docs).
export function assertProfileMergeOk(fromId, toId, fromProf, toProf, fromDev, toDev) {
  if (!fromId || !toId) throw new Error('Both a source and a target program are required');
  if (fromId === toId) throw new Error('Cannot merge a profile into itself');
  if (!fromProf) throw new Error('Source profile not found');
  if (!toProf) throw new Error('Target profile not found');
  if (!toProf.deviceId) throw new Error('Target profile has no device');
  if (fromProf.deviceId === toProf.deviceId) return { crossDevice: false };
  if (!toDev) throw new Error("Target profile's device not found");
  assertSameApplianceType(fromDev, toDev, 'device');
  return { crossDevice: true };
}

// Guard `adminMoveCycle(cycleId, toProfileId)`. Moving to a profile on ANOTHER device is
// allowed (a cycle uploaded under a misspelled device belongs on the correct one), so long
// as the appliance type matches.
export function assertCycleMoveOk(cycleId, toProfileId, cyc, toProf, fromDev, toDev) {
  if (!cycleId) throw new Error('Cycle is required');
  if (!toProfileId) throw new Error('A target program is required');
  if (!cyc) throw new Error('Cycle not found');
  if (!toProf) throw new Error('Target profile not found');
  if (!toProf.deviceId) throw new Error('Target profile has no device');
  if (cyc.profileId === toProfileId) return { moved: false, crossDevice: false };
  if (cyc.deviceId === toProf.deviceId) return { moved: true, crossDevice: false };
  if (!toDev) throw new Error("Target profile's device not found");
  assertSameApplianceType(fromDev || { applianceType: cyc.applianceType }, toDev, 'device');
  return { moved: true, crossDevice: true };
}

// Guard `adminMergeBrands(fromLc, toBrandName)` / `adminRenameBrand`.
export function assertBrandMergeOk(fromLc, toBrandName) {
  if (!fromLc) throw new Error('Source brand is required');
  const brand = String(toBrandName == null ? '' : toBrandName).trim();
  if (!brand) throw new Error('Brand name is required');
  // Firestore doc ids are the lowercased display name, so these characters would produce an
  // unaddressable brand document.
  if (/[/\\]/.test(brand) || brand === '.' || brand === '..') {
    throw new Error('Brand name may not contain "/" or "\\"');
  }
  if (brand.length > 40) throw new Error('Brand name must be 40 characters or fewer');
  return brand;
}
