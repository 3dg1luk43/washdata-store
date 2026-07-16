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
// Pure power-trace helpers. No Firebase import, so both washstore.js (browser) and
// node tests can use them.

// Firestore forbids directly-nested arrays, so a trace can't be stored as
// [[offset, watts], ...]. On the wire we store an array of {o, w} maps; in memory
// everywhere else we keep [[offset, watts], ...]. pack/unpack convert at the boundary.
export function packPoints(pairs) {
  if (!Array.isArray(pairs)) return [];
  return pairs.map((p) => ({ o: Number(p[0]) || 0, w: Number(p[1]) || 0 }));
}
export function unpackPoints(points) {
  if (!Array.isArray(points)) return [];
  return points.map((p) => (Array.isArray(p) ? p : [Number(p.o) || 0, Number(p.w) || 0]));
}

// Downsample to at most `max` points using LTTB (Largest Triangle Three Buckets).
// Unlike nearest-index selection, LTTB retains the most visually significant sample
// in each bucket -- the one that maximises the triangle area formed by the previously
// selected point and the centroid of the next bucket. This preserves peaks and troughs
// (heater pulses, pump-out spikes, spin transients) that are decisive for power-shape
// matching and that nearest-index can silently skip when step > 1.
// Always keeps first and last samples so the stored trace preserves the true cycle
// start/end (power-drop at cycle end) rather than stopping short.
export function downsampleCycle(points, max = 10000) {
  if (!Array.isArray(points)) return points;
  const count = Math.max(1, Math.floor(max));
  if (points.length <= count) return points;
  if (count === 1) return [points[0]];
  if (count === 2) return [points[0], points[points.length - 1]];

  const sampled = [points[0]];
  // Interior points (index 1 … n-2) are divided into (count-2) equal-size buckets.
  const bucketCount = count - 2;
  const bucketSize = (points.length - 2) / bucketCount;
  let prevIdx = 0;

  for (let i = 0; i < bucketCount; i++) {
    // Current bucket range [a, b)
    const a = Math.floor(i * bucketSize) + 1;
    const b = Math.min(Math.floor((i + 1) * bucketSize) + 1, points.length - 1);
    // Next bucket centroid (the triangle's third vertex)
    const c = b;
    const d = Math.min(Math.floor((i + 2) * bucketSize) + 1, points.length - 1);
    let avgX = 0, avgY = 0;
    const cnt = d - c;
    for (let j = c; j < d; j++) { avgX += points[j][0]; avgY += points[j][1]; }
    if (cnt > 0) { avgX /= cnt; avgY /= cnt; }
    else { avgX = points[points.length - 1][0]; avgY = points[points.length - 1][1]; }
    // Select the point in [a, b) with the largest triangle area
    const prev = points[prevIdx];
    let maxArea = -1, maxIdx = a;
    for (let j = a; j < b; j++) {
      const area = Math.abs(
        (prev[0] - avgX) * (points[j][1] - prev[1]) -
        (prev[0] - points[j][0]) * (avgY - prev[1])
      ) * 0.5;
      if (area > maxArea) { maxArea = area; maxIdx = j; }
    }
    sampled.push(points[maxIdx]);
    prevIdx = maxIdx;
  }

  sampled.push(points[points.length - 1]);
  return sampled;
}

// Parse a raw cycle from JSON (array of [t,v] or objects, or {times,values}) or CSV/TSV
// into [[offset_s, watts], ...]. Throws on unrecognised input.
export function parseCycle(text) {
  if (!text || !text.trim()) throw new Error('Empty input');
  const trimmed = text.trim();

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) throw new Error('Empty array');
      if (Array.isArray(parsed[0])) return parsed;
      return parsed.map((p) => {
        const t = p.t ?? p.time ?? p.x ?? 0;
        const v = p.v ?? p.value ?? p.y ?? p.power ?? 0;
        return [t, v];
      });
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const times = parsed.times ?? parsed.t ?? parsed.x ?? [];
      const values = parsed.values ?? parsed.v ?? parsed.y ?? parsed.power ?? [];
      if (!Array.isArray(times) || !Array.isArray(values)) {
        throw new Error('Unrecognised object structure');
      }
      return times.map((t, i) => [t, values[i] ?? 0]);
    }
    throw new Error('Unrecognised JSON structure');
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length === 0) throw new Error('No data rows');
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const result = [];
  for (const line of lines) {
    const parts = line.split(sep).map((s) => s.trim());
    if (parts.length < 2) continue;
    const t = parseFloat(parts[0]);
    const v = parseFloat(parts[1]);
    if (isNaN(t) || isNaN(v)) continue;
    result.push([t, v]);
  }
  if (result.length === 0) throw new Error('No valid numeric rows found');
  return result;
}

// Compute display/import stats from a raw trace of [offset_s, watts] pairs.
// Energy via trapezoid integration (Wh); duration from first/last offset.
export function cycleStats(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return { duration: 0, energy_wh: 0, peak_w: 0, mean_w: 0 };
  }
  let energyWs = 0;
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const v = Number(points[i][1]) || 0;
    peak = Math.max(peak, v);
    sum += v;
    if (i > 0) {
      const dt = Number(points[i][0]) - Number(points[i - 1][0]);
      const prev = Number(points[i - 1][1]) || 0;
      if (dt > 0) energyWs += ((v + prev) / 2) * dt;
    }
  }
  const duration = Number(points[points.length - 1][0]) - Number(points[0][0]);
  return {
    duration: Math.max(0, Math.round(duration)),
    energy_wh: Math.round((energyWs / 3600) * 1000) / 1000,
    peak_w: Math.round(peak),
    mean_w: Math.round(sum / points.length),
  };
}
