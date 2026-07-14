// Dev seed: insert a few APPROVED sample brands/devices/programs/reference cycles so
// you can see the browse + design working before real contributions exist. Safe to
// re-run (deterministic ids + merge). Delete the sample docs from the console when done.
//
//   npm install firebase-admin
//   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
//   node scripts/seed_sample.mjs washdata-store

import admin from 'firebase-admin';
import { deviceId as mkDeviceId, profileId as mkProfileId } from '../lib/ids.js';

const projectId = process.argv[2];
if (!projectId) { console.error('Usage: node scripts/seed_sample.mjs <projectId>'); process.exit(1); }

admin.initializeApp({ projectId, credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const now = admin.firestore.FieldValue.serverTimestamp();

// Synthetic washer trace: fill, heat spike, wash plateau, spin ramp. [offset_s, watts].
function washerTrace(peakHeat = 2100, durationS = 5400) {
  const pts = [];
  const step = 30;
  for (let t = 0; t <= durationS; t += step) {
    const f = t / durationS;
    let w = 15;                                   // idle/electronics
    if (f < 0.06) w = 60 + 200 * f;               // fill
    else if (f < 0.28) w = peakHeat * (0.9 + 0.1 * Math.sin(t));  // heating
    else if (f < 0.75) w = 90 + 40 * Math.sin(t / 60);            // wash tumble
    else if (f < 0.95) w = 180 + 900 * ((f - 0.75) / 0.2);        // spin ramp
    else w = 20;                                  // done
    pts.push([t, Math.round(w)]);
  }
  return pts;
}

function statsFrom(points) {
  let e = 0, peak = 0, sum = 0;
  for (let i = 0; i < points.length; i++) {
    const v = points[i][1]; peak = Math.max(peak, v); sum += v;
    if (i > 0) e += ((v + points[i - 1][1]) / 2) * (points[i][0] - points[i - 1][0]);
  }
  return { duration: points.at(-1)[0], energy_wh: Math.round(e / 3600), peak_w: peak, mean_w: Math.round(sum / points.length), signature: {} };
}

const SAMPLES = [
  { type: 'washer', brand: 'Bosch', model: 'Serie 6 WAT28660', program: 'Cotton 40', peak: 2100, dur: 6600 },
  { type: 'washer', brand: 'Bosch', model: 'Serie 6 WAT28660', program: 'Eco 40-60', peak: 1400, dur: 10800 },
  { type: 'washer', brand: 'Miele', model: 'WWD020', program: 'Cottons 60', peak: 2200, dur: 7200 },
  { type: 'dishwasher', brand: 'Bosch', model: 'SMS6ZCI00E', program: 'Eco 50', peak: 2000, dur: 12600 },
];

async function run() {
  let n = 0;
  for (const s of SAMPLES) {
    const brandLc = s.brand.toLowerCase();
    const devId = mkDeviceId(s.type, s.brand, s.model);
    const profId = mkProfileId(devId, s.program);
    const points = washerTrace(s.peak, s.dur);
    const stats = statsFrom(points);
    const cid = `seed_${profId}`.slice(0, 480);

    await db.collection('brands').doc(brandLc).set({
      brand: s.brand, brand_lc: brandLc, status: 'approved', createdByUid: 'seed', createdAt: now,
    }, { merge: true });
    await db.collection('devices').doc(devId).set({
      applianceType: s.type, brand: s.brand, brand_lc: brandLc, model: s.model, model_lc: s.model.toLowerCase(),
      status: 'approved', createdByUid: 'seed', createdAt: now, profileCount: 0, favoriteCount: 0,
    }, { merge: true });
    await db.collection('profiles').doc(profId).set({
      deviceId: devId, applianceType: s.type, program: s.program, program_lc: s.program.toLowerCase(),
      description: 'Sample seed data', status: 'approved', createdByUid: 'seed', createdAt: now, cycleCount: 1,
    }, { merge: true });
    await db.collection('cycles').doc(cid).set({
      profileId: profId, deviceId: devId, brand_lc: brandLc, program_lc: s.program.toLowerCase(), applianceType: s.type,
      uploaderUid: 'seed', uploaderName: 'Sample data', status: 'approved', rejectionReason: null,
      trace: { points, sampleIntervalSec: 30 }, stats, cycleSchemaVersion: 1,
      downloads: 0, commentCount: 0, qc: 1, createdAt: now,
    }, { merge: true });
    n++;
  }
  console.log(`Seeded ${n} sample reference cycle(s). Delete the seed_* / sample docs from the console when done.`);
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
