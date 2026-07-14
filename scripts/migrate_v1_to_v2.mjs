// One-shot v1 -> v2 migration (OPTIONAL).
//
// v1 stored a flat `envelopes` collection (the computed envelope was the shared unit).
// v2 stores `devices` -> `profiles` -> `cycles`, where the shared unit is a raw reference
// cycle. This script converts any existing v1 `envelopes` docs into the v2 hierarchy,
// synthesising a reference-cycle trace from the envelope's raw `cycle.points` when present,
// otherwise from its `avg` curve.
//
// Most deployments have no real v1 data yet - in that case prefer wiping the old
// `envelopes` collection in the Firebase console and just deploying v2. Run this only if
// you have v1 envelopes worth keeping.
//
// Requires firebase-admin and a service-account key:
//   npm install firebase-admin
//   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
//   node scripts/migrate_v1_to_v2.mjs <projectId>
//
// Idempotent: skips a cycle whose deterministic id already exists.

import admin from 'firebase-admin';
import { deviceId as mkDeviceId, profileId as mkProfileId } from '../lib/ids.js';
import { packPoints } from '../lib/trace.js';

const projectId = process.argv[2];
if (!projectId) {
  console.error('Usage: node scripts/migrate_v1_to_v2.mjs <projectId>');
  process.exit(1);
}

admin.initializeApp({ projectId, credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const now = admin.firestore.FieldValue.serverTimestamp();

// Build a [ [offset_s, watts], ... ] trace from a v1 envelope doc.
function traceFrom(env) {
  if (env.cycle && Array.isArray(env.cycle.points) && env.cycle.points.length >= 2) {
    return env.cycle.points;
  }
  const avg = env.envelope && Array.isArray(env.envelope.avg) ? env.envelope.avg : null;
  if (!avg || avg.length < 2) return null;
  const dur = (env.envelope && env.envelope.target_duration) || avg.length;
  const step = dur / (avg.length - 1);
  return avg.map((v, i) => [Math.round(i * step), v]);
}

function statsFrom(env, points) {
  const e = env.envelope || {};
  let peak = 0;
  let sum = 0;
  for (const p of points) { peak = Math.max(peak, Number(p[1]) || 0); sum += Number(p[1]) || 0; }
  return {
    duration: Math.round(e.target_duration || points[points.length - 1][0] || 0),
    energy_wh: e.avg_energy != null ? Math.round(e.avg_energy * 1000 * 1000) / 1000 : Math.round(sum),
    peak_w: Math.round(peak),
    mean_w: Math.round(sum / points.length),
    signature: {},
  };
}

async function run() {
  const snap = await db.collection('envelopes').get();
  if (snap.empty) {
    console.log('0 envelopes, nothing to do.');
    return;
  }
  let migrated = 0;
  let skipped = 0;
  for (const d of snap.docs) {
    const env = d.data();
    const applianceType = env.applianceType || 'washer';
    const brand = env.brand || 'Unknown';
    const model = env.model || 'Unknown';
    const program = env.program || 'Program';
    const points = traceFrom(env);
    if (!points) { skipped++; continue; }

    const devId = mkDeviceId(applianceType, brand, model);
    const profId = mkProfileId(devId, program);
    const brandLc = brand.toLowerCase();
    const cycleId = `mig_${d.id}`;
    const cycleRef = db.collection('cycles').doc(cycleId);
    if ((await cycleRef.get()).exists) { skipped++; continue; }

    const approved = env.status === 'approved';

    await db.collection('brands').doc(brandLc).set({
      brand, brand_lc: brandLc,
      status: approved ? 'approved' : 'pending',
      createdByUid: env.uploaderUid || 'migration', createdAt: now,
    }, { merge: true });

    await db.collection('devices').doc(devId).set({
      applianceType, brand, brand_lc: brand.toLowerCase(), model, model_lc: model.toLowerCase(),
      status: env.status === 'approved' ? 'approved' : 'pending',
      createdByUid: env.uploaderUid || 'migration', createdAt: now, profileCount: 0, favoriteCount: 0,
    }, { merge: true });

    await db.collection('profiles').doc(profId).set({
      deviceId: devId, applianceType, program, program_lc: program.toLowerCase(), description: env.notes || '',
      status: env.status === 'approved' ? 'approved' : 'pending',
      createdByUid: env.uploaderUid || 'migration', createdAt: now, cycleCount: 0,
    }, { merge: true });

    await cycleRef.set({
      profileId: profId, deviceId: devId,
      brand_lc: brand.toLowerCase(), program_lc: program.toLowerCase(), applianceType,
      uploaderUid: env.uploaderUid || 'migration', uploaderName: env.uploaderName || null,
      status: env.status || 'pending', rejectionReason: env.rejectionReason || null,
      trace: { points: packPoints(points), sampleIntervalSec: env.sampleIntervalSec || 5 },
      stats: statsFrom(env, points),
      cycleSchemaVersion: 1, downloads: env.downloads || 0, commentCount: 0,
      qc: 3, createdAt: now,
    });
    migrated++;
  }
  console.log(`Migrated ${migrated} cycle(s); skipped ${skipped}.`);
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
