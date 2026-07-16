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

// Downsample to at most `max` points, always keeping the first and last sample so the
// stored trace preserves the true start/end (power drop at cycle end) rather than
// stopping short of the final point.
export function downsampleCycle(points, max = 3000) {
  if (!Array.isArray(points)) return points;
  const count = Math.max(1, Math.floor(max));
  if (points.length <= count) return points;
  if (count === 1) return [points[0]];
  const step = (points.length - 1) / (count - 1);
  const result = [];
  for (let i = 0; i < count; i++) {
    result.push(points[Math.round(i * step)]);
  }
  return result;
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
