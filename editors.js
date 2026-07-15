// Shared phase/settings editor logic for both admin.html and index.html.
// Both pages must include the two modal fragments (same IDs).
import {
  updateDeviceSettings, updateProfilePhases, getReferenceCycles,
} from './washstore.js';

function $(id) { return document.getElementById(id); }

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDuration(sec) {
  if (sec == null || isNaN(sec)) return '-';
  const s = Math.round(sec); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const rem = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rem}s`;
  return `${rem}s`;
}

function toast(msg, type = 'success') {
  const container = $('toasts');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ============================================================ settings editor

export const SETTINGS_FIELDS = [
  { key: 'min_power', label: 'Min power (W)' },
  { key: 'off_delay', label: 'Off delay (s)' },
  { key: 'start_threshold_w', label: 'Start threshold (W)' },
  { key: 'stop_threshold_w', label: 'End threshold (W)' },
  { key: 'start_duration_threshold', label: 'Start duration (s)' },
  { key: 'start_energy_threshold', label: 'Start energy (Wh)' },
  { key: 'completion_min_seconds', label: 'Min cycle duration (s)' },
  { key: 'running_dead_zone', label: 'Running dead zone (s)' },
  { key: 'min_off_gap', label: 'Min off gap (s)' },
  { key: 'end_energy_threshold', label: 'End energy threshold (Wh)' },
  { key: 'power_off_threshold_w', label: 'Power off threshold (W)' },
  { key: 'power_off_delay', label: 'Power off delay (s)' },
  { key: 'profile_match_threshold', label: 'Match threshold (0-1)' },
  { key: 'profile_unmatch_threshold', label: 'Unmatch threshold (0-1)' },
  { key: 'profile_match_interval', label: 'Match interval (min)' },
  { key: 'profile_match_min_duration_ratio', label: 'Min duration ratio' },
  { key: 'profile_match_max_duration_ratio', label: 'Max duration ratio' },
  { key: 'profile_duration_tolerance', label: 'Profile duration tolerance' },
  { key: 'duration_tolerance', label: 'Estimate tolerance' },
  { key: 'auto_label_confidence', label: 'Auto-label confidence (0-1)' },
  { key: 'learning_confidence', label: 'Learning confidence (0-1)' },
];

export function openSettingsEditor(d) {
  const modal = $('settings-edit-modal');
  $('se-modal-title').textContent = `${d.brand || ''} ${d.model || ''}`.trim() || d.id;
  $('se-modal-subtitle').textContent = 'Detection & matching settings (21 shared thresholds)';
  const current = d.settings || {};
  $('se-modal-body').innerHTML = `<p class="text-muted" style="font-size:.8125rem;margin-bottom:.875rem">
    Model-intrinsic thresholds. Leave a field empty to keep it unset.
    Save writes the complete map; empty fields are omitted.</p>
    <div class="se-grid">
      ${SETTINGS_FIELDS.map((f) => `
        <div class="form-group" style="margin:0">
          <label for="se-${esc(f.key)}" style="font-size:.75rem">${esc(f.label)}</label>
          <input type="number" id="se-${esc(f.key)}" step="any"
                 value="${current[f.key] != null ? current[f.key] : ''}"
                 placeholder="not set" class="se-input">
        </div>`).join('')}
    </div>`;
  modal.removeAttribute('hidden');
  $('se-save-btn').onclick = async () => {
    const settings = {};
    for (const f of SETTINGS_FIELDS) {
      const v = document.getElementById(`se-${f.key}`).value.trim();
      if (v !== '') settings[f.key] = parseFloat(v);
    }
    $('se-save-btn').disabled = true;
    try {
      await updateDeviceSettings(d.id, settings);
      d.settings = settings;
      toast(`Settings saved (${Object.keys(settings).length} fields)`);
      modal.setAttribute('hidden', '');
    } catch (e) { toast(e.message, 'error'); }
    finally { $('se-save-btn').disabled = false; }
  };
}

// ============================================================ phase editor

const PHASE_COLORS = [
  'rgba(124,156,255,0.30)', 'rgba(70,201,139,0.30)', 'rgba(255,180,90,0.30)',
  'rgba(255,107,107,0.30)', 'rgba(168,100,255,0.30)',
];
const PHASE_SOLID = ['#7c9cff', '#46c98b', '#ffb45a', '#ff6b6b', '#a864ff'];

let _pePhases = [];
let _pePending = null;

function buildPhaseGraph(container, cycle, getPhasesRef) {
  const raw = cycle && cycle.trace && cycle.trace.points;
  if (!Array.isArray(raw) || raw.length < 2) {
    container.innerHTML = '<div class="text-muted" style="padding:1rem">No trace data.</div>';
    return;
  }
  let pts = raw;
  if (pts.length > 600) {
    const step = Math.ceil(pts.length / 600);
    pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  }
  const W = 640, H = 170, pad = 8;
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const x0 = xs[0]; const xN = xs[xs.length - 1] || 1; const yMax = Math.max(...ys, 1);
  const sx = (t) => pad + ((t - x0) / ((xN - x0) || 1)) * (W - 2 * pad);
  const toSecs = (svgX) => x0 + ((svgX - pad) / ((W - 2 * pad) || 1)) * (xN - x0);
  const svgFromClient = (clientX) => {
    const rect = svgEl.getBoundingClientRect();
    return ((clientX - rect.left) / (rect.width || 1)) * W;
  };
  const tracePath = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${(H - pad - (p[1] / yMax) * (H - 2 * pad)).toFixed(1)}`).join(' ');

  function rebuildSVG() {
    const phases = getPhasesRef();
    const bands = phases.map((ph, i) => {
      const x1 = Math.max(sx(ph.start), pad).toFixed(1);
      const x2 = Math.min(sx(ph.end), W - pad).toFixed(1);
      const w = Math.max(0, x2 - x1).toFixed(1);
      return `<rect class="cg-phase-band" x="${x1}" y="${pad}" width="${w}" height="${H - 2 * pad}" fill="${PHASE_COLORS[i % PHASE_COLORS.length]}"/>`;
    }).join('');
    svgEl.innerHTML = `${bands}
      <rect class="cg-drag-preview" id="pe-drag-preview" x="0" y="${pad}" width="0" height="${H - 2 * pad}" fill="rgba(255,255,255,0.12)" hidden/>
      <path d="${tracePath}" class="cg-line"/>
      <line class="cg-cross" id="pe-cross" x1="0" x2="0" y1="${pad}" y2="${H - pad}" hidden/>`;
  }

  container.innerHTML = `<div class="cycle-graph">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="cycle-graph-svg" id="pe-svg" style="touch-action:none;cursor:crosshair"></svg>
    <div class="cycle-graph-readout text-muted" id="pe-readout">Click and drag to define a phase region</div>
  </div>`;
  const svgEl = document.getElementById('pe-svg');
  rebuildSVG();
  container._rebuildSVG = rebuildSVG;

  let dragStartSecs = null;

  svgEl.addEventListener('pointerdown', (e) => {
    svgEl.setPointerCapture(e.pointerId);
    dragStartSecs = toSecs(svgFromClient(e.clientX));
    e.preventDefault();
  });

  svgEl.addEventListener('pointermove', (e) => {
    const cx = svgFromClient(e.clientX);
    const cross = document.getElementById('pe-cross');
    if (cross) { cross.setAttribute('x1', cx.toFixed(1)); cross.setAttribute('x2', cx.toFixed(1)); cross.hidden = false; }
    if (dragStartSecs !== null) {
      const cur = toSecs(cx);
      const s = Math.min(dragStartSecs, cur); const en = Math.max(dragStartSecs, cur);
      const preview = document.getElementById('pe-drag-preview');
      if (preview) {
        const px1 = Math.max(sx(s), pad); const px2 = Math.min(sx(en), W - pad);
        preview.setAttribute('x', px1.toFixed(1));
        preview.setAttribute('width', Math.max(0, px2 - px1).toFixed(1));
        preview.removeAttribute('hidden');
      }
      const readout = document.getElementById('pe-readout');
      if (readout) readout.textContent = `${formatDuration(s)} -- ${formatDuration(en)} (${formatDuration(en - s)})`;
    }
  });

  svgEl.addEventListener('pointerup', (e) => {
    svgEl.releasePointerCapture(e.pointerId);
    if (dragStartSecs === null) return;
    const endSecs = toSecs(svgFromClient(e.clientX));
    const startFinal = Math.min(dragStartSecs, endSecs);
    const endFinal = Math.max(dragStartSecs, endSecs);
    dragStartSecs = null;
    const preview = document.getElementById('pe-drag-preview');
    if (preview) preview.setAttribute('hidden', '');
    if (endFinal - startFinal < (xN - x0) * 0.005) {
      const readout = document.getElementById('pe-readout');
      if (readout) readout.textContent = 'Drag too short -- try again.';
      return;
    }
    _pePending = { start: Math.round(startFinal), end: Math.round(endFinal) };
    const pendingRow = $('pe-pending-row');
    if (pendingRow) { pendingRow.removeAttribute('hidden'); }
    const nameInput = $('pe-pending-name');
    if (nameInput) { nameInput.value = ''; nameInput.focus(); }
    const readout = document.getElementById('pe-readout');
    if (readout) readout.textContent = `New phase: ${formatDuration(startFinal)} -- ${formatDuration(endFinal)}. Name it below.`;
  });

  svgEl.addEventListener('mouseleave', () => {
    const cross = document.getElementById('pe-cross');
    if (cross && dragStartSecs === null) cross.hidden = true;
  });
}

function renderPhaseList(phases) {
  const list = $('pe-phase-list');
  if (!list) return;
  if (phases.length === 0) {
    list.innerHTML = '<div class="text-muted" style="font-size:.8125rem;padding:.25rem 0">No phases defined yet. Drag on the graph to add one.</div>';
    return;
  }
  list.innerHTML = phases.map((ph, i) => `
    <div class="pe-phase-row">
      <span class="pe-phase-swatch" style="background:${PHASE_SOLID[i % PHASE_SOLID.length]}"></span>
      <span class="pe-phase-name">${esc(ph.name)}</span>
      <span class="pe-phase-range">${formatDuration(ph.start)} -- ${formatDuration(ph.end)}</span>
      <button class="pe-phase-del" data-pi="${i}" aria-label="Delete ${esc(ph.name)}">&#215;</button>
    </div>`).join('');
  list.querySelectorAll('[data-pi]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _pePhases.splice(parseInt(btn.dataset.pi, 10), 1);
      renderPhaseList(_pePhases);
      const graph = $('pe-modal-graph');
      if (graph && graph._rebuildSVG) graph._rebuildSVG();
    });
  });
}

export async function openPhaseEditor(profile) {
  const modal = $('phase-edit-modal');
  $('pe-modal-title').textContent = profile.program || profile.id;
  const dev = String(profile.deviceId || '').split('__').slice(1).join(' ').trim() || '';
  $('pe-modal-subtitle').textContent = dev;
  $('pe-phase-list').innerHTML = '';
  $('pe-pending-row').setAttribute('hidden', '');
  $('pe-no-cycle').setAttribute('hidden', '');
  $('pe-modal-graph').innerHTML = '<div class="loading-center" style="min-height:60px"><div class="loading-spinner"></div></div>';
  modal.removeAttribute('hidden');

  _pePending = null;
  _pePhases = Array.isArray(profile.phases) ? profile.phases.map((ph) => ({ ...ph })) : [];

  try {
    const { items } = await getReferenceCycles(profile.id, { includePending: true });
    if (items.length === 0) {
      $('pe-modal-graph').innerHTML = '';
      $('pe-no-cycle').removeAttribute('hidden');
    } else {
      buildPhaseGraph($('pe-modal-graph'), items[0], () => _pePhases);
    }
  } catch (e) {
    $('pe-modal-graph').innerHTML = `<div class="text-muted" style="padding:1rem">${esc(e.message)}</div>`;
  }
  renderPhaseList(_pePhases);

  $('pe-add-btn').onclick = () => {
    const name = $('pe-pending-name').value.trim();
    if (!name) { $('pe-pending-name').focus(); return; }
    if (_pePending) {
      _pePhases.push({ name, start: _pePending.start, end: _pePending.end });
      _pePending = null;
    }
    $('pe-pending-row').setAttribute('hidden', '');
    renderPhaseList(_pePhases);
    const graph = $('pe-modal-graph');
    if (graph && graph._rebuildSVG) graph._rebuildSVG();
  };
  $('pe-pending-name').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('pe-add-btn').click(); } };
  $('pe-cancel-btn').onclick = () => {
    _pePending = null;
    $('pe-pending-row').setAttribute('hidden', '');
    const graph = $('pe-modal-graph');
    if (graph && graph._rebuildSVG) graph._rebuildSVG();
  };

  $('pe-save-btn').onclick = async () => {
    $('pe-save-btn').disabled = true;
    try {
      await updateProfilePhases(profile.id, _pePhases);
      profile.phases = [..._pePhases];
      toast(`Phase map saved (${_pePhases.length} phases)`);
      modal.setAttribute('hidden', '');
    } catch (e) { toast(e.message, 'error'); }
    finally { $('pe-save-btn').disabled = false; }
  };
}

// ============================================================ modal close wiring
// Call once at startup in each page that includes the editor modals.
export function bindEditorCloseHandlers() {
  function closeSettings() { const m = $('settings-edit-modal'); if (m) m.setAttribute('hidden', ''); }
  function closePhase() { const m = $('phase-edit-modal'); if (m) m.setAttribute('hidden', ''); }
  const seClose = $('se-modal-close'); if (seClose) seClose.addEventListener('click', closeSettings);
  const seCloseF = $('se-modal-close-footer'); if (seCloseF) seCloseF.addEventListener('click', closeSettings);
  const seModal = $('settings-edit-modal');
  if (seModal) seModal.addEventListener('click', (e) => { if (e.target === seModal) closeSettings(); });
  const peClose = $('pe-modal-close'); if (peClose) peClose.addEventListener('click', closePhase);
  const peCloseF = $('pe-modal-close-footer'); if (peCloseF) peCloseF.addEventListener('click', closePhase);
  const peModal = $('phase-edit-modal');
  if (peModal) peModal.addEventListener('click', (e) => { if (e.target === peModal) closePhase(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (seModal && !seModal.hasAttribute('hidden')) { closeSettings(); return; }
    if (peModal && !peModal.hasAttribute('hidden')) { closePhase(); return; }
  });
}
