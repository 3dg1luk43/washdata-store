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
// One-off, idempotent backfill for the community-catalog fields (admin SDK, bypasses rules).
//
// Ensures every device has confirmCount/manualUrl/createdByName so the confirm-count
// bump rule (which reads resource.data.confirmCount) can never hit a missing field, and
// seeds config/site.confirmThreshold so the auto-promotion rule's lookup resolves.
// Safe to re-run.
//
//   npm install firebase-admin
//   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
//   node scripts/backfill_confirm.mjs washdata-store

import admin from 'firebase-admin';

const projectId = process.argv[2];
if (!projectId) { console.error('Usage: node scripts/backfill_confirm.mjs <projectId>'); process.exit(1); }

admin.initializeApp({ projectId, credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const now = admin.firestore.FieldValue.serverTimestamp();

async function run() {
  // 1) config/site must carry a numeric confirmThreshold (default 5).
  const siteRef = db.collection('config').doc('site');
  const site = await siteRef.get();
  const thr = site.exists ? site.data().confirmThreshold : undefined;
  if (typeof thr !== 'number') {
    await siteRef.set({ confirmThreshold: 5, updatedAt: now }, { merge: true });
    console.log('Seeded config/site.confirmThreshold = 5');
  }

  // 2) Backfill device fields in batches.
  const snap = await db.collection('devices').get();
  let patched = 0;
  let batch = db.batch();
  let ops = 0;
  for (const d of snap.docs) {
    const data = d.data();
    const patch = {};
    if (typeof data.confirmCount !== 'number') patch.confirmCount = 0;
    if (!('manualUrl' in data)) patch.manualUrl = null;
    if (!('createdByName' in data)) patch.createdByName = null;
    if (Object.keys(patch).length === 0) continue;
    batch.set(d.ref, patch, { merge: true });
    patched++;
    if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
  if (ops > 0) await batch.commit();

  // 3) Backfill brand attribution field.
  const bsnap = await db.collection('brands').get();
  let bBatch = db.batch();
  let bOps = 0;
  let bPatched = 0;
  for (const b of bsnap.docs) {
    if ('createdByName' in b.data()) continue;
    bBatch.set(b.ref, { createdByName: null }, { merge: true });
    bPatched++;
    if (++bOps >= 400) { await bBatch.commit(); bBatch = db.batch(); bOps = 0; }
  }
  if (bOps > 0) await bBatch.commit();

  console.log(`Backfilled ${patched} device(s) and ${bPatched} brand(s).`);
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
