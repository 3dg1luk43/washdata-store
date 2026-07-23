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
import firebaseConfig from './config.js';
import {
  init, onAuth, signIn, signOutUser, isAdmin, ensureUserProfile,
  deleteCycle, qcLabel,
  adminListCycles, adminSetCycleStatus,
  adminListDevices, adminSetDeviceStatus, adminSetProfileStatus, adminSetBrandStatus, adminMergeDevices, adminMergeProfiles,
  adminListBrands, adminListProfiles,
  adminListUsers, adminBanUser, adminUnbanUser, adminGetStats, adminRecount,
  getSiteConfig, setMaintenance, setConfirmThreshold,
  adminSetDeviceOwner, adminSetProfileOwner,
  adminDeleteDevice, adminDeleteBrand, adminDeleteProfile, adminDeleteUser,
  adminDeleteComment,
  getReferenceCycles,
  adminGetAnalytics,
  getRatingSummary, getDeviceQuality,
  getUserDoc,
  adminListReports, getReportsForTarget, adminResolveReports, adminRecordRemoval, adminGetByPath,
  reportReasonLabel,
} from './washstore.js';
import { openSettingsEditor, openPhaseEditor, bindEditorCloseHandlers } from './editors.js';

init(firebaseConfig);

// ============================================================ state
let _isAdmin = false;
let _cyCursor = null;
let _userCursor = null;
let _cyFilters = { status: '', applianceType: '' };
const _cyRatingCache = new Map(); // cycleId -> Promise<{avg,count}> (evict on error)
// creatorUid -> user doc (or null), for the Reports queue. A spam wave has one creator
// across many reported objects; without this each group re-reads the same user doc.
// Cleared on every reports (re)load; a specific uid is invalidated after banning it.
const _reportUserCache = new Map();
let _reviewRecord = null;
let _userItems = [];
let _statsLoaded = false;
let _statsDays = 7;
// Catalog hierarchy state
let _brandItems = [];
let _deviceItems = [];
let _profileItems = [];
let _catLevel = 'brands'; // 'brands' | 'devices' | 'profiles' | 'cycles'
let _catBrand = null;
let _catDevice = null;
let _catProfile = null;
let _catCycles = [];
let _catCycleCursor = null;
let _catalogLoaded = false;
// State for the owner-picker modal (shared by device + profile pickers)
let _ownerPickerCtx = null; // { record, isProfile, card }
// Cached site stats (catalog totals + open reports + banned count); shared by Overview,
// Statistics, and the Users header. Refreshed on demand.
let _statsCache = null;
// Reports review queue state
let _reportCursor = null;
let _reportStatus = 'open';
let _reportsLoaded = false;
// Users tab client-side controls
let _userStatusFilter = 'all'; // all | active | banned
let _userSort = 'joined';       // joined | removed
// Target paths already rendered as a group card this load (dedupe across pages).
const _renderedReportKeys = new Set();

// ============================================================ dom + toast
function $(id) { return document.getElementById(id); }
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ============================================================ helpers
function filterRows(inputId, tbody) {
  const q = $(inputId) ? $(inputId).value.trim().toLowerCase() : '';
  tbody.querySelectorAll('tr').forEach((tr) => { tr.hidden = q ? !((tr.dataset.search || '').includes(q)) : false; });
}
function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function formatDate(ts) {
  if (!ts) return '-';
  const d = ts.toDate ? ts.toDate() : new Date(typeof ts === 'number' ? ts * 1000 : ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function formatDuration(sec) {
  if (sec == null || isNaN(sec)) return '-';
  const s = Math.round(sec); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const rem = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rem}s`;
  return `${rem}s`;
}
function typeLabel(t) {
  return { washer: 'Washer', dryer: 'Dryer', dishwasher: 'Dishwasher', washer_dryer: 'Washer-Dryer' }[t] || t;
}
function truncate(str, max = 8) { if (!str) return ''; return str.length > max ? str.slice(0, max) + '...' : str; }

// Interactive power graph for the cycle preview modal (hover/drag -> time/watts readout).
function interactiveGraph(container, cycle) {
  const raw = cycle && cycle.trace && cycle.trace.points;
  if (!Array.isArray(raw) || raw.length < 2) { container.innerHTML = '<div class="text-muted" style="padding:1rem">No trace data.</div>'; return; }
  let pts = raw;
  if (pts.length > 600) {
    const step = Math.ceil(pts.length / 600);
    // Keep the final sample so the graph/readout ends where the trace actually does.
    pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  }
  const W = 640, H = 170, pad = 8;
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const x0 = xs[0]; const xN = xs[xs.length - 1] || 1; const yMax = Math.max(...ys, 1);
  const sx = (x) => pad + ((x - x0) / ((xN - x0) || 1)) * (W - 2 * pad);
  const sy = (y) => H - pad - (y / yMax) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
  const area = `M${sx(x0).toFixed(1)},${(H - pad).toFixed(1)} ` + pts.map((p) => `L${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ') + ` L${sx(xN).toFixed(1)},${(H - pad).toFixed(1)} Z`;
  container.innerHTML = `<div class="cycle-graph">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="cycle-graph-svg">
      <path d="${area}" class="cg-area"/><path d="${d}" class="cg-line"/>
      <line class="cg-cross" x1="0" x2="0" y1="${pad}" y2="${H - pad}" hidden/>
      <circle class="cg-dot" r="3.5" hidden/>
    </svg>
    <div class="cycle-graph-readout text-muted" data-readout>&#128072; Hover the graph to read power at any point</div>
  </div>`;
  const svg = container.querySelector('svg');
  const cross = svg.querySelector('.cg-cross'); const dot = svg.querySelector('.cg-dot');
  const readout = container.querySelector('[data-readout]');
  const at = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const vx = ((clientX - rect.left) / (rect.width || 1)) * W;
    const tx = x0 + ((vx - pad) / ((W - 2 * pad) || 1)) * (xN - x0);
    let best = 0; let bd = Infinity;
    for (let i = 0; i < pts.length; i++) { const dd = Math.abs(pts[i][0] - tx); if (dd < bd) { bd = dd; best = i; } }
    const p = pts[best]; const X = sx(p[0]); const Y = sy(p[1]);
    cross.setAttribute('x1', X); cross.setAttribute('x2', X); cross.hidden = false;
    dot.setAttribute('cx', X); dot.setAttribute('cy', Y); dot.hidden = false;
    readout.textContent = `${formatDuration(p[0])} into the cycle - ${Math.round(p[1])} W`;
  };
  svg.addEventListener('mousemove', (e) => at(e.clientX));
  svg.addEventListener('mouseleave', () => { cross.hidden = true; dot.hidden = true; readout.innerHTML = '&#128072; Hover the graph to read power at any point'; });
  svg.addEventListener('touchmove', (e) => { if (e.touches[0]) { e.preventDefault(); at(e.touches[0].clientX); } }, { passive: false });
}
function deviceLabel(c) {
  const p = String(c.deviceId || '').split('__');
  return `${p[1] || ''} ${p[2] || ''}`.trim() || c.deviceId || '?';
}
function resolveOwnerLabel(uid) {
  if (!uid) return '-';
  const u = _userItems.find((x) => x.uid === uid);
  return u ? (u.githubLogin || u.displayName || truncate(uid, 10)) : truncate(uid, 10);
}

// ============================================================ auth gate
function renderAuthArea(user) {
  const area = $('auth-status');
  if (user) {
    area.innerHTML = `${user.photoURL ? `<img class="user-avatar" src="${esc(user.photoURL)}" alt="">` : ''}
      <span class="user-name">${esc(user.displayName || 'User')}</span>
      <button class="btn btn-ghost btn-sm" id="signout-btn">Sign out</button>`;
    $('signout-btn').addEventListener('click', async () => {
      try { await signOutUser(); location.href = 'index.html'; }
      catch (e) { toast(e.message, 'error'); }
    });
  } else {
    area.innerHTML = `<button class="btn btn-primary btn-sm" id="signin-btn">Sign in with GitHub</button>`;
    $('signin-btn').addEventListener('click', async () => { try { await signIn(); } catch (e) { toast(e.message, 'error'); } });
  }
}

onAuth(async (user) => {
  renderAuthArea(user);
  $('admin-gate').setAttribute('hidden', '');
  if (!user) {
    $('denied-title').textContent = 'Sign in Required';
    $('denied-text').textContent = 'Please sign in with an admin GitHub account to access this panel.';
    $('admin-signin-btn').removeAttribute('hidden');
    $('admin-signin-btn').addEventListener('click', async () => { try { await signIn(); } catch (e) { toast(e.message, 'error'); } });
    $('admin-denied').removeAttribute('hidden'); $('admin-panel').setAttribute('hidden', '');
    return;
  }
  try { await ensureUserProfile(user); } catch (_) {}
  let admin = false;
  try { admin = await isAdmin(); } catch (_) {}
  _isAdmin = admin;
  if (!admin) {
    $('denied-title').textContent = 'Access Denied';
    $('denied-text').textContent = 'Your account does not have admin permissions for this panel.';
    $('admin-signin-btn').setAttribute('hidden', '');
    $('admin-denied').removeAttribute('hidden'); $('admin-panel').setAttribute('hidden', '');
    return;
  }
  $('admin-denied').setAttribute('hidden', ''); $('admin-panel').removeAttribute('hidden');
  loadOverview();
  loadMaintenance();
  // Pre-load users in background so owner labels resolve in Devices/Profiles tabs.
  loadUsers(true).catch(() => {});
});

// ============================================================ tabs
const TABS = ['overview', 'reports', 'catalog', 'cycles', 'users', 'statistics'];
function switchTab(name) {
  TABS.forEach((t) => {
    $(`${t}-tab`).toggleAttribute('hidden', t !== name);
    $(`${t}-btn`).classList.toggle('active', t === name);
    $(`${t}-btn`).setAttribute('aria-selected', t === name ? 'true' : 'false');
  });
}
TABS.forEach((name) => $(`${name}-btn`).addEventListener('click', () => {
  switchTab(name);
  if (name === 'reports' && !_reportsLoaded) loadReports(true);
  if (name === 'catalog' && !_catalogLoaded) loadCatalogData();
  if (name === 'cycles' && !$('cycles-tbody').hasChildNodes()) loadCycles(true);
  if (name === 'users' && !$('users-tbody').hasChildNodes()) loadUsers(true);
  if (name === 'statistics' && !_statsLoaded) loadStatistics();
}));

// ============================================================ overview
// Shared site stats (catalog totals + moderation counters). Cached so Overview,
// Statistics, and the Users header can reuse one round of aggregation queries.
async function ensureStats(force = false) {
  if (!_statsCache || force) _statsCache = await adminGetStats();
  return _statsCache;
}
// Keep the "Reports" tab button's count badge in sync with the open-report total.
function renderReportsTabCount(n) {
  const badge = $('reports-tab-count');
  if (!badge) return;
  badge.textContent = n;
  badge.toggleAttribute('hidden', !n);
}
// Compact per-object-type breakdown line for a stat card (only non-zero types shown).
function statBreakdown(by) {
  if (!by) return '';
  const defs = [['brands', 'brand'], ['devices', 'device'], ['profiles', 'profile'], ['cycles', 'cycle']];
  const parts = defs.filter(([k]) => (by[k] || 0) > 0).map(([k, sing]) => `${by[k]} ${by[k] === 1 ? sing : sing + 's'}`);
  return parts.length ? `<div class="stat-breakdown">${parts.join(' &middot; ')}</div>` : '';
}
async function loadOverview() {
  $('stats-grid').innerHTML = '<div class="loading-center" style="grid-column:1/-1"><div class="loading-spinner"></div></div>';
  try {
    const s = await ensureStats(true);
    renderReportsTabCount(s.openReports);
    $('stats-grid').innerHTML = `
      <div class="stat-card stat-card-link" id="ov-reports-card"><div class="stat-label">Open Reports</div><div class="stat-value ${s.openReports ? 'c-rejected' : 'c-approved'}">${s.openReports}</div></div>
      <div class="stat-card"><div class="stat-label">Pending Review</div><div class="stat-value c-pending">${s.pending}</div>${statBreakdown(s.pendingByType)}</div>
      <div class="stat-card"><div class="stat-label">Approved</div><div class="stat-value c-approved">${s.approved}</div>${statBreakdown(s.approvedByType)}</div>
      <div class="stat-card"><div class="stat-label">Rejected</div><div class="stat-value c-rejected">${s.rejected}</div></div>
      <div class="stat-card"><div class="stat-label">Removed</div><div class="stat-value c-removed">${s.removed}</div>${statBreakdown(s.removedByType)}</div>
      <div class="stat-card"><div class="stat-label">Banned Users</div><div class="stat-value c-ban">${s.bannedUsers}</div></div>`;
    const rc = $('ov-reports-card');
    if (rc) rc.addEventListener('click', () => { switchTab('reports'); if (!_reportsLoaded) loadReports(true); });
  } catch (e) {
    $('stats-grid').innerHTML = `<div class="text-muted" style="grid-column:1/-1;padding:1rem">${esc(e.message)}</div>`;
    toast(e.message, 'error');
  }
}
$('stats-refresh-btn').addEventListener('click', loadOverview);

// --- maintenance toggle + auto-approve threshold ---
let _maintOn = false;
async function loadMaintenance() {
  const btn = $('maint-toggle-btn');
  btn.disabled = true;
  let cfg = {};
  try { cfg = await getSiteConfig(); } catch (_) { cfg = {}; }
  _maintOn = !!cfg.maintenance;
  renderMaintenance();
  const thr = Number(cfg.confirmThreshold);
  $('threshold-input').value = Number.isFinite(thr) && thr > 0 ? thr : 5;
  $('threshold-input').disabled = false;
  $('threshold-save-btn').disabled = false;
}
$('threshold-save-btn').addEventListener('click', async () => {
  const n = Math.min(1000, Math.max(1, Math.round(Number($('threshold-input').value) || 5)));
  $('threshold-save-btn').disabled = true;
  try {
    const saved = await setConfirmThreshold(n);
    $('threshold-input').value = saved;
    toast(`Auto-approve threshold set to ${saved}`);
  } catch (e) { toast(e.message, 'error'); } finally { $('threshold-save-btn').disabled = false; }
});
function renderMaintenance() {
  const state = $('maint-state');
  const btn = $('maint-toggle-btn');
  state.textContent = _maintOn ? 'On' : 'Off';
  state.className = `badge badge-${_maintOn ? 'pending' : 'approved'}`;
  btn.textContent = _maintOn ? 'Turn off (go public)' : 'Turn on';
  btn.className = `btn btn-sm ${_maintOn ? 'btn-primary' : 'btn-danger'}`;
  btn.disabled = false;
}
$('maint-toggle-btn').addEventListener('click', async () => {
  const next = !_maintOn;
  if (next && !confirm('Turn maintenance ON? The public site will show a coming-soon screen to non-admins.')) return;
  $('maint-toggle-btn').disabled = true;
  try {
    await setMaintenance(next);
    _maintOn = next;
    renderMaintenance();
    toast(next ? 'Maintenance on - site hidden from public' : 'Maintenance off - site is public');
  } catch (e) { $('maint-toggle-btn').disabled = false; toast(e.message, 'error'); }
});

// Cycles are community-voted (auto-approve at the confirm threshold), like devices,
// so there is no admin review queue. Admins can still View / Remove / Delete a cycle
// from the Cycles tab for moderation.

// ============================================================ cycles table
async function loadCycles(reset = false) {
  if (reset) { _cyCursor = null; $('cycles-tbody').innerHTML = `<tr><td colspan="11" class="tbl-msg">Loading...</td></tr>`; $('cycles-load-more').setAttribute('hidden', ''); if ($('cy-filter-device')) $('cy-filter-device').value = ''; }
  try {
    const { items, cursor } = await adminListCycles({ status: _cyFilters.status || null, applianceType: _cyFilters.applianceType || null, pageSize: 25, cursor: _cyCursor });
    if (reset) $('cycles-tbody').innerHTML = '';
    if (items.length === 0 && !_cyCursor) { $('cycles-tbody').innerHTML = `<tr><td colspan="11" class="tbl-msg">No cycles found.</td></tr>`; }
    else { items.forEach((c) => $('cycles-tbody').appendChild(buildCycleRow(c))); applyCycleRowFilters(); }
    _cyCursor = cursor; $('cycles-load-more').toggleAttribute('hidden', !cursor);
  } catch (e) {
    if (reset) $('cycles-tbody').innerHTML = `<tr><td colspan="11" class="tbl-msg" style="color:var(--danger)">${esc(e.message)}</td></tr>`;
    toast(e.message, 'error');
  }
}

// Cached per-cycle rating summary (admin). Evict on error like the public side.
function cyRating(id) {
  if (!_cyRatingCache.has(id)) {
    _cyRatingCache.set(id, getRatingSummary(id).catch((e) => { _cyRatingCache.delete(id); throw e; }));
  }
  return _cyRatingCache.get(id);
}

// Combined client-side filter over loaded rows: device/brand text + Min-rating.
// (Ratings live in subcollections, so server-side rating filtering isn't possible
// without a backend; this filters the rows already fetched.)
function applyCycleRowFilters() {
  const q = ($('cy-filter-device') ? $('cy-filter-device').value : '').trim().toLowerCase();
  const min = Number($('cy-filter-rating') ? $('cy-filter-rating').value : 0) || 0;
  $('cycles-tbody').querySelectorAll('tr').forEach((tr) => {
    if (!tr.dataset.search) return; // skip message rows
    const textOk = !q || (tr.dataset.search || '').includes(q);
    const avg = tr.dataset.ratingAvg ? Number(tr.dataset.ratingAvg) : null;
    const ratingOk = min <= 0 || (avg != null && avg >= min);
    tr.hidden = !(textOk && ratingOk);
  });
}

function buildCycleRow(c) {
  const tr = document.createElement('tr');
  tr.dataset.search = `${deviceLabel(c)} ${c.program_lc || ''} ${c.applianceType || ''} ${c.uploaderName || ''}`.toLowerCase();
  tr.innerHTML = `
    <td><code class="mono" style="font-size:.72rem">${esc(truncate(c.id, 8))}</code></td>
    <td>${esc(deviceLabel(c))}</td>
    <td class="truncate" style="max-width:100px" title="${esc(c.program_lc || '')}">${esc(c.program_lc || '')}</td>
    <td><span class="badge badge-type">${esc(typeLabel(c.applianceType))}</span></td>
    <td><span class="badge badge-${esc(c.status)} status-badge">${esc(c.status)}</span></td>
    <td class="text-muted" style="font-size:.72rem">${esc(qcLabel(c.qc))}</td>
    <td class="text-muted truncate" title="${esc(c.uploaderName || '')}">${esc(truncate(c.uploaderName || 'Anon', 14))}</td>
    <td class="text-muted" style="white-space:nowrap;font-size:.72rem">${formatDate(c.createdAt)}</td>
    <td class="text-muted">${c.downloads || 0}</td>
    <td class="text-muted" data-rating style="white-space:nowrap;font-size:.72rem">&hellip;</td>
    <td><div class="action-cell"></div></td>`;
  buildCycleActions(tr.querySelector('.action-cell'), c, tr);
  // Rating summary (async, per row) + feed the client-side Min-rating filter.
  cyRating(c.id).then((s) => {
    const cell = tr.querySelector('[data-rating]');
    tr.dataset.ratingAvg = (s && s.count > 0 && s.avg != null) ? String(s.avg) : '';
    if (cell) cell.textContent = (s && s.count > 0) ? `★ ${s.avg.toFixed(1)} (${s.count})` : '-';
    applyCycleRowFilters();
  }).catch(() => {
    const cell = tr.querySelector('[data-rating]');
    if (cell) cell.textContent = '-';
  });
  return tr;
}

function buildCycleActions(container, c, tr) {
  container.innerHTML = '';
  // Cycles auto-approve by community vote; admins only moderate (remove / delete).
  const setStatus = (status) => async () => {
    try {
      await adminSetCycleStatus(c.id, status);
      c.status = status;
      const badge = tr.querySelector('.status-badge');
      if (badge) { badge.className = `badge badge-${status} status-badge`; badge.textContent = status; }
      buildCycleActions(container, c, tr);
      toast(`Set ${status}`);
    } catch (e) { toast(e.message, 'error'); }
  };
  const mk = (label, cls, handler) => { const b = document.createElement('button'); b.className = `btn ${cls} btn-sm`; b.textContent = label; b.addEventListener('click', handler); container.appendChild(b); };
  if (c.status === 'pending') mk('Approve', 'btn-ghost', setStatus('approved'));
  if (c.status !== 'removed') mk('Remove', 'btn-ghost', setStatus('removed'));
  else mk('Restore', 'btn-ghost', setStatus('approved'));
  mk('View', 'btn-ghost', () => openReviewModal(c));
  mk('Delete', 'btn-danger', async () => {
    if (!confirm(`Permanently delete this cycle (${deviceLabel(c)} - ${c.program_lc})?`)) return;
    try { await deleteCycle(c.id); tr.remove(); toast('Deleted permanently'); } catch (e) { toast(e.message, 'error'); }
  });
}

$('cy-filter-apply').addEventListener('click', () => { _cyFilters = { status: $('cy-filter-status').value, applianceType: $('cy-filter-type').value }; loadCycles(true); });
$('cy-filter-clear').addEventListener('click', () => {
  $('cy-filter-status').value = ''; $('cy-filter-type').value = '';
  if ($('cy-filter-device')) $('cy-filter-device').value = '';
  if ($('cy-filter-rating')) $('cy-filter-rating').value = '0';
  _cyFilters = { status: '', applianceType: '' }; loadCycles(true);
});
$('cy-filter-device').addEventListener('input', applyCycleRowFilters);
if ($('cy-filter-rating')) $('cy-filter-rating').addEventListener('change', applyCycleRowFilters);
$('cycles-load-more').addEventListener('click', () => loadCycles(false));

// ============================================================ owner picker modal
function populateOwnerPicker(currentOwnerId) {
  const sel = $('owner-picker-select');
  if (!sel) return;
  const opts = _userItems.map((u) => `<option value="${esc(u.uid)}">${esc(u.githubLogin || u.displayName || u.uid.slice(0, 12))} (${esc(u.uid.slice(0, 8))})</option>`).join('');
  sel.innerHTML = '<option value="">-- None (remove owner) --</option>' + opts;
  if (currentOwnerId) sel.value = currentOwnerId;
}

function openOwnerPicker(record, card, isProfile = false) {
  _ownerPickerCtx = { record, isProfile, card };
  $('owner-picker-modal-title').textContent = isProfile ? 'Set Profile Owner' : 'Set Device Owner';
  populateOwnerPicker(record.ownerId);
  $('owner-picker-modal').removeAttribute('hidden');
  $('owner-picker-save').onclick = async () => {
    const uid = $('owner-picker-select').value || null;
    const ownerName = uid ? (() => { const u = _userItems.find((x) => x.uid === uid); return u ? (u.githubLogin || u.displayName || null) : null; })() : null;
    try {
      if (isProfile) await adminSetProfileOwner(record.id, uid, ownerName);
      else await adminSetDeviceOwner(record.id, uid, ownerName);
      record.ownerId = uid;
      const ownerEl = _ownerPickerCtx.card && _ownerPickerCtx.card.querySelector('.cat-owner-label');
      if (ownerEl) ownerEl.textContent = uid ? resolveOwnerLabel(uid) : '(none)';
      $('owner-picker-modal').setAttribute('hidden', '');
      toast(uid ? 'Owner set' : 'Owner cleared');
    } catch (e) { toast(e.message, 'error'); }
  };
}
$('owner-picker-close').addEventListener('click', () => $('owner-picker-modal').setAttribute('hidden', ''));
$('owner-picker-cancel').addEventListener('click', () => $('owner-picker-modal').setAttribute('hidden', ''));
$('owner-picker-modal').addEventListener('click', (e) => { if (e.target === $('owner-picker-modal')) $('owner-picker-modal').setAttribute('hidden', ''); });

// Optimistically adjust the Overview "Pending Review" count.
function bumpPending(delta) {
  if (!delta) return;
  const el = document.querySelector('#stats-grid .c-pending');
  if (!el) return;
  const n = parseInt(el.textContent, 10);
  if (!isNaN(n)) el.textContent = String(Math.max(0, n + delta));
}

// Shared status action builder. Works on any container that has a child .action-cell.
// Rebuilds itself after status change; updates .status-badge; adjusts pending count.
function buildStatusActions(container, rec, setter, label, extra, deleter) {
  const cell = container.querySelector('.action-cell');
  cell.innerHTML = '';
  let saving = false;
  const mk = (text, status) => {
    const btn = document.createElement('button'); btn.className = 'btn btn-ghost btn-sm'; btn.textContent = text;
    btn.addEventListener('click', async () => {
      if (saving) return;
      saving = true;
      cell.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      const wasPending = rec.status === 'pending';
      try {
        await setter(rec.id, status); rec.status = status;
        const badge = container.querySelector('.status-badge');
        if (badge) { badge.className = `badge badge-${status} status-badge`; badge.textContent = status; }
        container.classList.toggle('cat-pending', status === 'pending');
        bumpPending((wasPending ? -1 : 0) + (status === 'pending' ? 1 : 0));
        buildStatusActions(container, rec, setter, label, extra, deleter);
        toast(`${label} ${status}`);
      } catch (e) {
        saving = false;
        cell.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        toast(e.message, 'error');
      }
    });
    cell.appendChild(btn);
  };
  if (rec.status !== 'approved') mk('Approve', 'approved');
  if (deleter) {
    const delBtn = document.createElement('button'); delBtn.className = 'btn btn-danger btn-sm'; delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Permanently delete this ${label.toLowerCase()} and all its data? This cannot be undone.`)) return;
      delBtn.disabled = true;
      try {
        await deleter(rec.id);
        bumpPending(rec.status === 'pending' ? -1 : 0);
        container.remove();
        toast(`${label} deleted`);
      } catch (e) { delBtn.disabled = false; toast(e.message, 'error'); }
    });
    cell.appendChild(delBtn);
  }
  if (extra) extra(cell);
}

// ============================================================ catalog
async function loadCatalogData() {
  $('cat-content').innerHTML = '<div class="loading-center" style="padding:3rem"><div class="loading-spinner"></div></div>';
  $('cat-merge-bar').style.display = 'none';
  try {
    const [brandRes, devRes, profRes] = await Promise.all([
      adminListBrands({ pageSize: 500 }),
      adminListDevices({ pageSize: 500 }),
      adminListProfiles({ pageSize: 500 }),
    ]);
    _brandItems = brandRes.items || [];
    _deviceItems = devRes.items || [];
    _profileItems = profRes.items || [];
    _catalogLoaded = true;
    _catLevel = 'brands'; _catBrand = null; _catDevice = null; _catProfile = null;
    renderCatalog();
  } catch (e) {
    $('cat-content').innerHTML = `<div class="tbl-msg" style="color:var(--danger)">${esc(e.message)}</div>`;
    toast(e.message, 'error');
  }
}

function catNavigate(level, brand, device, profile) {
  _catLevel = level;
  _catBrand = brand || null;
  _catDevice = device || null;
  _catProfile = profile || null;
  if ($('cat-search')) $('cat-search').value = '';
  renderCatalog();
}

function renderCatBreadcrumb() {
  const crumbs = [{ label: 'All Brands', level: 'brands' }];
  if (_catBrand) crumbs.push({ label: _catBrand.brand, level: 'devices' });
  if (_catDevice) crumbs.push({ label: _catDevice.model || truncate(_catDevice.id, 20), level: 'profiles' });
  if (_catProfile) crumbs.push({ label: _catProfile.program, level: 'cycles' });
  $('cat-breadcrumb').innerHTML = crumbs.map((c, i) => {
    if (i === crumbs.length - 1) return `<span class="cat-bc-current">${esc(c.label)}</span>`;
    return `<button class="cat-bc-btn" data-cat-lvl="${esc(c.level)}">${esc(c.label)}</button><span class="cat-bc-sep"> / </span>`;
  }).join('');
  $('cat-breadcrumb').querySelectorAll('[data-cat-lvl]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lvl = btn.dataset.catLvl;
      if (lvl === 'brands') catNavigate('brands');
      else if (lvl === 'devices') catNavigate('devices', _catBrand);
      else if (lvl === 'profiles') catNavigate('profiles', _catBrand, _catDevice);
    });
  });
}

function renderCatalog() {
  renderCatBreadcrumb();
  switch (_catLevel) {
    case 'brands': renderCatBrands(); break;
    case 'devices': renderCatDevices(); break;
    case 'profiles': renderCatProfiles(); break;
    case 'cycles': renderCatCyclesLevel(); break;
  }
}

// Render a contextual merge bar scoped to the current level's items.
function catMergebar(items, noun, getLabel, mergeAction, afterMerge) {
  const bar = $('cat-merge-bar');
  if (items.length < 2) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  bar.innerHTML = '';
  const labelEl = document.createElement('span'); labelEl.className = 'merge-bar-label'; labelEl.textContent = 'Merge';
  const mkSel = (placeholder) => {
    const sel = document.createElement('select');
    sel.style.cssText = 'flex:1;min-width:9rem;max-width:22rem';
    sel.innerHTML = `<option value="">-- ${placeholder} --</option>` + items.map((i) => `<option value="${esc(i.id)}">${esc(getLabel(i))}</option>`).join('');
    return sel;
  };
  const fromSel = mkSel(`source ${noun}`);
  const arrow = document.createElement('span'); arrow.className = 'text-muted'; arrow.style.flexShrink = '0'; arrow.textContent = '→';
  const toSel = mkSel(`target ${noun}`);
  const mergeBtn = document.createElement('button'); mergeBtn.className = 'btn btn-danger btn-sm'; mergeBtn.textContent = 'Merge';
  mergeBtn.addEventListener('click', async () => {
    const from = fromSel.value; const to = toSel.value;
    if (!from || !to) { toast(`Select both source and target ${noun}`, 'error'); return; }
    if (from === to) { toast('Source and target must be different', 'error'); return; }
    const fromItem = items.find((i) => i.id === from);
    const toItem = items.find((i) => i.id === to);
    if (!confirm(`Merge "${fromItem ? getLabel(fromItem) : from}" into "${toItem ? getLabel(toItem) : to}"? This cannot be undone.`)) return;
    mergeBtn.disabled = true;
    try {
      await mergeAction(from, to); toast('Merged');
      _catalogLoaded = false;
      await loadCatalogData();
      afterMerge();
    } catch (e) { mergeBtn.disabled = false; toast(e.message, 'error'); }
  });
  const hint = document.createElement('span'); hint.className = 'merge-bar-hint';
  hint.textContent = `Reassigns all data from source to target ${noun}, then deletes source.`;
  bar.append(labelEl, fromSel, arrow, toSel, mergeBtn, hint);
}

// Build a catalog card element. metaHTML is trusted pre-escaped HTML.
function catMakeCard(rec, name, metaHTML) {
  const card = document.createElement('div');
  card.className = `cat-card${rec.status === 'pending' ? ' cat-pending' : ''}`;
  const info = document.createElement('div'); info.className = 'cat-card-info';
  info.innerHTML = `
    <div class="cat-card-name">${esc(name)} <span class="badge badge-${esc(rec.status)} status-badge">${esc(rec.status)}</span></div>
    <div class="cat-card-meta">${metaHTML}</div>`;
  const actions = document.createElement('div'); actions.className = 'cat-card-actions action-cell';
  card.append(info, actions);
  return card;
}

function catSearchFilter(items, getSearchStr) {
  const q = $('cat-search') ? $('cat-search').value.trim().toLowerCase() : '';
  return q ? items.filter((i) => getSearchStr(i).toLowerCase().includes(q)) : items;
}

// Level 1 — Brands
function renderCatBrands() {
  $('cat-merge-bar').style.display = 'none';
  const sorted = [..._brandItems].sort((a, b) =>
    (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || (a.brand || '').localeCompare(b.brand || ''));
  const items = catSearchFilter(sorted, (b) => `${b.brand || ''} ${b.status || ''} ${b.createdByName || ''}`);
  const content = $('cat-content'); content.innerHTML = '';
  if (!items.length) { content.innerHTML = '<div class="tbl-msg">No brands found.</div>'; return; }
  const list = document.createElement('div'); list.className = 'cat-list';
  items.forEach((brand) => {
    const devCount = _deviceItems.filter((d) => d.brand_lc === brand.id).length;
    const meta = `${devCount} device${devCount !== 1 ? 's' : ''}${brand.createdByName ? ` · by ${esc(brand.createdByName)}` : ''}`;
    const card = catMakeCard(brand, brand.brand, meta);
    buildStatusActions(card, brand, adminSetBrandStatus, 'Brand', (cell) => {
      const drill = document.createElement('button'); drill.className = 'btn-drill'; drill.textContent = 'Devices →';
      drill.addEventListener('click', () => catNavigate('devices', brand));
      cell.appendChild(drill);
    }, adminDeleteBrand);
    list.appendChild(card);
  });
  content.appendChild(list);
}

// Level 2 — Devices for selected brand
function renderCatDevices() {
  const all = _deviceItems.filter((d) => d.brand_lc === _catBrand.id);
  catMergebar(all, 'device', (d) => `${d.model || d.id} (${d.status})`, adminMergeDevices,
    () => catNavigate('devices', _catBrand));
  const sorted = [...all].sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0));
  const items = catSearchFilter(sorted, (d) => `${d.model || ''} ${d.applianceType || ''} ${d.status || ''}`);
  const content = $('cat-content'); content.innerHTML = '';
  if (!items.length) { content.innerHTML = '<div class="tbl-msg">No devices for this brand.</div>'; return; }
  const list = document.createElement('div'); list.className = 'cat-list';
  items.forEach((device) => {
    const profCount = _profileItems.filter((p) => p.deviceId === device.id).length;
    const metaParts = [
      esc(typeLabel(device.applianceType)),
      `${profCount} profile${profCount !== 1 ? 's' : ''}`,
      device.favoriteCount ? `⭐ ${device.favoriteCount}` : null,
      device.ownerId ? `owner: <span class="cat-owner-label">${esc(resolveOwnerLabel(device.ownerId))}</span>` : null,
    ].filter(Boolean).join(' · ');
    const card = catMakeCard(device, device.model || device.id, metaParts);
    buildStatusActions(card, device, adminSetDeviceStatus, 'Device', (cell) => {
      const settBtn = document.createElement('button'); settBtn.className = 'btn btn-ghost btn-sm'; settBtn.textContent = 'Settings';
      settBtn.addEventListener('click', () => openSettingsEditor(device));
      cell.appendChild(settBtn);
      const ownerBtn = document.createElement('button'); ownerBtn.className = 'btn btn-ghost btn-sm'; ownerBtn.textContent = 'Set owner';
      ownerBtn.addEventListener('click', () => openOwnerPicker(device, card));
      cell.appendChild(ownerBtn);
      const drill = document.createElement('button'); drill.className = 'btn-drill'; drill.textContent = 'Profiles →';
      drill.addEventListener('click', () => catNavigate('profiles', _catBrand, device));
      cell.appendChild(drill);
    }, async (id) => { await adminDeleteDevice(id); _deviceItems = _deviceItems.filter((d) => d.id !== id); });
    // Quality rating in the meta line (bounded fan-out: only this brand's devices).
    getDeviceQuality(device.id).then((s) => {
      if (s && s.count > 0) {
        const meta = card.querySelector('.cat-card-meta');
        if (meta) meta.insertAdjacentHTML('beforeend', ` · <span style="color:var(--warning)">★ ${s.avg.toFixed(1)} (${s.count})</span>`);
      }
    }).catch(() => {});
    list.appendChild(card);
  });
  content.appendChild(list);
}

// Level 3 — Profiles for selected device
function renderCatProfiles() {
  const all = _profileItems.filter((p) => p.deviceId === _catDevice.id);
  catMergebar(all, 'profile', (p) => `${p.program || p.id} (${p.status})`, adminMergeProfiles,
    () => catNavigate('profiles', _catBrand, _catDevice));
  const sorted = [...all].sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0));
  const items = catSearchFilter(sorted, (p) => `${p.program || ''} ${p.status || ''} ${p.createdByName || ''}`);
  const content = $('cat-content'); content.innerHTML = '';
  if (!items.length) { content.innerHTML = '<div class="tbl-msg">No profiles for this device.</div>'; return; }
  const list = document.createElement('div'); list.className = 'cat-list';
  items.forEach((profile) => {
    const metaParts = [
      profile.createdByName ? `by ${esc(profile.createdByName)}` : null,
      profile.ownerId ? `owner: <span class="cat-owner-label">${esc(resolveOwnerLabel(profile.ownerId))}</span>` : null,
    ].filter(Boolean).join(' · ');
    const card = catMakeCard(profile, profile.program || profile.id, metaParts);
    buildStatusActions(card, profile, adminSetProfileStatus, 'Profile', (cell) => {
      const phaseBtn = document.createElement('button'); phaseBtn.className = 'btn btn-ghost btn-sm'; phaseBtn.textContent = 'Edit phases';
      phaseBtn.addEventListener('click', () => openPhaseEditor(profile));
      cell.appendChild(phaseBtn);
      const ownerBtn = document.createElement('button'); ownerBtn.className = 'btn btn-ghost btn-sm'; ownerBtn.textContent = 'Set owner';
      ownerBtn.addEventListener('click', () => openOwnerPicker(profile, card, true));
      cell.appendChild(ownerBtn);
      const drill = document.createElement('button'); drill.className = 'btn-drill'; drill.textContent = 'Cycles →';
      drill.addEventListener('click', () => catNavigate('cycles', _catBrand, _catDevice, profile));
      cell.appendChild(drill);
    }, async (id) => { await adminDeleteProfile(id); _profileItems = _profileItems.filter((p) => p.id !== id); });
    list.appendChild(card);
  });
  content.appendChild(list);
}

// Level 4 — Cycles for selected profile
async function renderCatCyclesLevel() {
  $('cat-merge-bar').style.display = 'none';
  const content = $('cat-content');
  content.innerHTML = '<div class="loading-center" style="padding:2rem"><div class="loading-spinner"></div></div>';
  try {
    const { items } = await getReferenceCycles(_catProfile.id, { includePending: true });
    content.innerHTML = '';
    if (!items.length) { content.innerHTML = '<div class="tbl-msg">No cycles for this profile.</div>'; return; }
    const wrap = document.createElement('div'); wrap.className = 'admin-table-wrap';
    const tbl = document.createElement('table'); tbl.className = 'admin-table';
    tbl.innerHTML = '<thead><tr><th>ID</th><th>Status</th><th>Src</th><th>Uploader</th><th>Date</th><th>DL</th><th>Rating</th><th>Actions</th></tr></thead>';
    const tbody = document.createElement('tbody');
    items.forEach((c) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code class="mono" style="font-size:.72rem">${esc(truncate(c.id, 8))}</code></td>
        <td><span class="badge badge-${esc(c.status)} status-badge">${esc(c.status)}</span></td>
        <td class="text-muted" style="font-size:.72rem">${esc(qcLabel(c.qc))}</td>
        <td class="text-muted truncate" title="${esc(c.uploaderName || '')}">${esc(truncate(c.uploaderName || 'Anon', 14))}</td>
        <td class="text-muted" style="white-space:nowrap;font-size:.72rem">${formatDate(c.createdAt)}</td>
        <td class="text-muted">${c.downloads || 0}</td>
        <td class="text-muted" data-rating style="white-space:nowrap;font-size:.72rem">&hellip;</td>
        <td><div class="action-cell"></div></td>`;
      buildCycleActions(tr.querySelector('.action-cell'), c, tr);
      cyRating(c.id).then((s) => {
        const cell = tr.querySelector('[data-rating]');
        if (cell) cell.textContent = (s && s.count > 0) ? `★ ${s.avg.toFixed(1)} (${s.count})` : '-';
      }).catch(() => { const cell = tr.querySelector('[data-rating]'); if (cell) cell.textContent = '-'; });
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody); wrap.appendChild(tbl); content.appendChild(wrap);
  } catch (e) {
    content.innerHTML = `<div class="tbl-msg" style="color:var(--danger)">${esc(e.message)}</div>`;
    toast(e.message, 'error');
  }
}

$('cat-search').addEventListener('input', () => {
  if (_catLevel === 'brands') renderCatBrands();
  else if (_catLevel === 'devices') renderCatDevices();
  else if (_catLevel === 'profiles') renderCatProfiles();
});

// ============================================================ users table
async function loadUsers(reset = false) {
  const banned = _userStatusFilter === 'banned';
  if (reset) { _userCursor = null; _userItems = []; $('users-tbody').innerHTML = `<tr><td colspan="7" class="tbl-msg">Loading...</td></tr>`; $('users-load-more').setAttribute('hidden', ''); }
  try {
    const { items, cursor } = await adminListUsers({ pageSize: banned ? 200 : 40, cursor: _userCursor, status: banned ? 'banned' : null });
    _userItems = [..._userItems, ...items];
    _userCursor = cursor;
    renderUserRows();
    $('users-load-more').toggleAttribute('hidden', !cursor);
    updateUsersCount();
  } catch (e) {
    if (reset) $('users-tbody').innerHTML = `<tr><td colspan="7" class="tbl-msg" style="color:var(--danger)">${esc(e.message)}</td></tr>`;
    toast(e.message, 'error');
  }
}

// Re-render the whole tbody from the loaded set, applying the client-side status filter
// (active hides banned), the sort, and the live text-search filter.
function renderUserRows() {
  const tbody = $('users-tbody');
  tbody.innerHTML = '';
  let rows = _userItems.slice();
  if (_userStatusFilter === 'active') rows = rows.filter((u) => (u.status || 'active') !== 'banned');
  if (_userSort === 'removed') rows.sort((a, b) => (b.removedContentCount || 0) - (a.removedContentCount || 0));
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="7" class="tbl-msg">No users found.</td></tr>`; return; }
  rows.forEach((u) => tbody.appendChild(buildUserRow(u)));
  filterRows('user-search', tbody);
}

async function updateUsersCount() {
  const el = $('users-count'); if (!el) return;
  try { const s = await ensureStats(); el.textContent = `· ${s.totalUsers} total · ${s.bannedUsers} banned`; } catch (_) {}
}

// Repeat-offender strike cell: number of this user's contributions an admin has removed.
function strikeCellHTML(u) {
  const n = u.removedContentCount || 0;
  if (!n) return '<span class="text-muted">0</span>';
  return `<span class="strike-badge${n >= 3 ? ' strike-high' : ''}" title="Contributions removed by moderators">&#9873; ${n}</span>`;
}

function buildUserRow(u) {
  const tr = document.createElement('tr');
  const name = u.displayName || u.githubLogin || u.email || u.uid.slice(0, 12);
  tr.dataset.search = `${name} ${u.githubLogin || ''} ${u.email || ''} ${u.uid} ${u.status || ''}`.toLowerCase();
  const initial = name.charAt(0).toUpperCase();
  const avatar = u.photoURL ? `<img src="${esc(u.photoURL)}" alt="">` : initial;
  tr.innerHTML = `
    <td><div class="user-cell"><div class="user-cell-avatar">${avatar}</div><span style="font-size:.8125rem;font-weight:500">${esc(name)}</span></div></td>
    <td><code class="mono" style="font-size:.7rem">${esc(truncate(u.uid, 12))}</code></td>
    <td>${statusBadge(u)}</td>
    <td>${strikeCellHTML(u)}</td>
    <td class="text-muted" style="font-size:.75rem;max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(u.banReason || '-')}</td>
    <td class="text-muted" style="white-space:nowrap;font-size:.72rem">${formatDate(u.createdAt)}</td>
    <td><div class="action-cell"></div></td>`;
  buildUserActions(tr.querySelector('.action-cell'), u, tr);
  return tr;
}
function statusBadge(u) {
  return u.status === 'banned' ? `<span class="badge badge-rejected">Banned</span>` : `<span class="badge badge-approved">Active</span>`;
}
function buildUserActions(cell, u, tr) {
  cell.innerHTML = '';
  const name = u.displayName || u.githubLogin || u.email || u.uid.slice(0, 12);
  const b = document.createElement('button');
  if (u.status === 'banned') {
    b.className = 'btn btn-ghost btn-sm'; b.textContent = 'Unban';
    b.addEventListener('click', async () => {
      if (!confirm(`Unban ${name}?`)) return;
      try { await adminUnbanUser(u.uid); u.status = 'active'; u.banReason = null; refreshUserRow(tr, u); toast('User unbanned'); } catch (e) { toast(e.message, 'error'); }
    });
  } else {
    b.className = 'btn btn-danger btn-sm'; b.textContent = 'Ban';
    b.addEventListener('click', async () => {
      const reason = prompt(`Ban reason for ${name}:`); if (reason === null) return;
      try { await adminBanUser(u.uid, reason || ''); u.status = 'banned'; u.banReason = reason || ''; refreshUserRow(tr, u); toast('User banned'); } catch (e) { toast(e.message, 'error'); }
    });
  }
  cell.appendChild(b);
  // Remove user: reassign their contributions to anonymous, then delete their account.
  const delBtn = document.createElement('button');
  delBtn.className = 'btn btn-danger btn-sm'; delBtn.textContent = 'Remove user';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`Remove ${name}?\n\nThis will:\n- Reassign all their devices, profiles, and cycles to "Deleted User"\n- Delete their account\n\nThis cannot be undone.`)) return;
    delBtn.disabled = true;
    try {
      await adminDeleteUser(u.uid);
      tr.remove();
      _userItems = _userItems.filter((x) => x.uid !== u.uid);
      toast('User removed');
    } catch (e) { delBtn.disabled = false; toast(e.message, 'error'); }
  });
  cell.appendChild(delBtn);
}
function refreshUserRow(tr, u) {
  const cells = tr.querySelectorAll('td');
  cells[2].innerHTML = statusBadge(u);
  cells[3].innerHTML = strikeCellHTML(u);
  cells[4].textContent = u.banReason || '-';
  buildUserActions(cells[6].querySelector('.action-cell'), u, tr);
}
$('user-search').addEventListener('input', () => filterRows('user-search', $('users-tbody')));
$('user-status-filter').addEventListener('change', (e) => { _userStatusFilter = e.target.value; loadUsers(true); });
$('user-sort').addEventListener('change', (e) => { _userSort = e.target.value; renderUserRows(); });
$('users-load-more').addEventListener('click', () => loadUsers(false));

// ============================================================ review modal
function openReviewModal(c) {
  _reviewRecord = c;
  $('review-modal-title').textContent = deviceLabel(c);
  $('review-modal-subtitle').textContent = c.program_lc || '';
  interactiveGraph($('review-modal-sparkline'), c);
  const st = c.stats || {};
  $('review-modal-body').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem">
      <div class="detail-item"><span class="detail-label">Type</span><span class="detail-value">${esc(typeLabel(c.applianceType))}</span></div>
      <div class="detail-item"><span class="detail-label">Uploader</span><span class="detail-value">${esc(c.uploaderName || 'Anonymous')}</span></div>
      <div class="detail-item"><span class="detail-label">Provenance</span><span class="detail-value">${esc(qcLabel(c.qc))}</span></div>
      <div class="detail-item"><span class="detail-label">Duration</span><span class="detail-value">${formatDuration(st.duration)}</span></div>
      <div class="detail-item"><span class="detail-label">Energy</span><span class="detail-value">${st.energy_wh != null ? (st.energy_wh / 1000).toFixed(3) + ' kWh' : '-'}</span></div>
      <div class="detail-item"><span class="detail-label">Peak</span><span class="detail-value">${st.peak_w != null ? st.peak_w + ' W' : '-'}</span></div>
      <div class="detail-item"><span class="detail-label">Points</span><span class="detail-value">${c.trace && c.trace.points ? c.trace.points.length : 0}</span></div>
      <div class="detail-item"><span class="detail-label">Schema v</span><span class="detail-value">${c.cycleSchemaVersion ?? '-'}</span></div>
    </div>
    <div style="margin-top:.875rem"><div class="detail-label" style="margin-bottom:.35rem">Trace preview</div>
      <pre class="envelope-json" style="max-height:180px">${esc(JSON.stringify({ deviceId: c.deviceId, profileId: c.profileId, stats: c.stats }, null, 2))}</pre></div>`;
  $('review-modal').removeAttribute('hidden');
}
function closeReviewModal() { $('review-modal').setAttribute('hidden', ''); _reviewRecord = null; }
$('review-modal-close').addEventListener('click', closeReviewModal);
$('review-modal-close-footer').addEventListener('click', closeReviewModal);
$('review-modal').addEventListener('click', (e) => { if (e.target === $('review-modal')) closeReviewModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('review-modal').hasAttribute('hidden')) closeReviewModal(); });

// ============================================================ reports (moderation queue)
const _REPORT_TYPE_LABEL = { brand: 'Brand', device: 'Device', profile: 'Profile', cycle: 'Cycle', comment: 'Comment' };

function creatorUidOf(obj, targetType) {
  if (!obj) return null;
  if (targetType === 'cycle') return obj.uploaderUid || null;
  if (targetType === 'comment') return obj.authorUid || null;
  return obj.createdByUid || null;
}

// Derive a report's TRUE target from the report doc's real Firestore location (_path),
// not the client-written target* fields. This is the integrity guarantee: a spoofed
// targetPath/targetType/targetId field can only mislead the label, never the object an
// admin action actually hits. Falls back to the fields only if _path is unavailable.
function deriveReportTarget(r) {
  const p = r._path;
  if (p && p.includes('/reports/')) {
    const objPath = p.slice(0, p.lastIndexOf('/reports/'));
    const s = objPath.split('/');
    if (s[0] === 'brands' && s.length === 2) return { targetPath: objPath, targetType: 'brand', targetId: s[1], parentCycleId: null };
    if (s[0] === 'devices' && s.length === 2) return { targetPath: objPath, targetType: 'device', targetId: s[1], parentCycleId: null };
    if (s[0] === 'profiles' && s.length === 2) return { targetPath: objPath, targetType: 'profile', targetId: s[1], parentCycleId: null };
    if (s[0] === 'cycles' && s[2] === 'comments' && s.length === 4) return { targetPath: objPath, targetType: 'comment', targetId: s[3], parentCycleId: s[1] };
    if (s[0] === 'cycles' && s.length === 2) return { targetPath: objPath, targetType: 'cycle', targetId: s[1], parentCycleId: null };
  }
  return { targetPath: r.targetPath, targetType: r.targetType, targetId: r.targetId, parentCycleId: r.parentCycleId || null };
}

// Group a page of report docs by their target object (all reporters on one object collapse
// into one card). Grouping key + action target both come from the derived (trusted) path.
function groupReports(items) {
  const map = new Map();
  for (const r of items) {
    const t = deriveReportTarget(r);
    const key = t.targetPath || `${t.targetType}:${t.targetId}`;
    if (!map.has(key)) map.set(key, { key, ...t, targetLabel: r.targetLabel || '', reports: [] });
    map.get(key).reports.push(r);
  }
  return [...map.values()];
}

async function loadReports(reset = false) {
  _reportsLoaded = true;
  if (reset) {
    _reportCursor = null;
    _renderedReportKeys.clear();
    _reportUserCache.clear();
    $('reports-list').innerHTML = '<div class="loading-center" style="padding:2rem"><div class="loading-spinner"></div></div>';
    $('reports-load-more').setAttribute('hidden', '');
  }
  try {
    const { items, cursor } = await adminListReports({ status: _reportStatus, pageSize: 80, cursor: _reportCursor });
    if (reset) $('reports-list').innerHTML = '';
    const groups = groupReports(items).filter((g) => !_renderedReportKeys.has(g.key));
    groups.forEach((g) => _renderedReportKeys.add(g.key));
    if (!_renderedReportKeys.size) {
      $('reports-list').innerHTML = `<div class="empty-state" style="padding:2.5rem"><div class="empty-icon">&#9873;</div>
        <div class="empty-title">${_reportStatus === 'open' ? 'No open reports' : 'No resolved reports'}</div>
        <div class="empty-text">${_reportStatus === 'open' ? 'Nothing to review right now.' : 'Resolved reports will appear here.'}</div></div>`;
    } else {
      groups.forEach((g) => $('reports-list').appendChild(buildReportGroupCard(g)));
    }
    _reportCursor = cursor;
    $('reports-load-more').toggleAttribute('hidden', !cursor);
  } catch (e) {
    if (reset) $('reports-list').innerHTML = `<div class="text-muted" style="padding:1rem;color:var(--danger)">${esc(e.message)}</div>`;
    toast(e.message, 'error');
  }
}

// Build a consolidated card for one reported object. The shell renders immediately; the
// live object status, creator (+ strike count), full report list, and actions fill in
// asynchronously.
function buildReportGroupCard(g) {
  const card = document.createElement('div');
  card.className = 'report-group';
  const title = g.targetLabel || g.targetId || '(unknown)';
  card.innerHTML = `
    <div class="report-group-head">
      <div class="report-target">
        <span class="badge report-type-badge">${esc(_REPORT_TYPE_LABEL[g.targetType] || g.targetType)}</span>
        <span class="report-target-title">${esc(title)}</span>
        <span class="badge report-live-status" data-livestatus>&hellip;</span>
      </div>
      <div class="report-creator" data-creator></div>
    </div>
    <div class="report-path mono">${esc(g.targetPath || '')}</div>
    <div class="report-items" data-items>
      <div class="loading-center" style="padding:.75rem"><div class="loading-spinner"></div></div>
    </div>
    <div class="report-actions" data-actions></div>`;
  hydrateReportGroupCard(card, g).catch(() => {});
  return card;
}

async function hydrateReportGroupCard(card, g) {
  // Full consolidation: every report on this object of the current status (independent of
  // which queue page each landed on).
  let allReports = g.reports;
  try {
    const fetched = await getReportsForTarget(g.targetPath);
    const filtered = fetched.filter((r) => (r.status || 'open') === _reportStatus);
    if (filtered.length) allReports = filtered;
  } catch (_) { /* fall back to the page's reports */ }
  renderReportItems(card.querySelector('[data-items]'), allReports);

  // Live object + creator.
  let live = null;
  try { live = await adminGetByPath(g.targetPath); } catch (_) {}
  const statusEl = card.querySelector('[data-livestatus]');
  if (!live) {
    statusEl.textContent = 'gone';
    statusEl.className = 'badge report-live-status badge-removed';
  } else {
    const st = live.status || (g.targetType === 'comment' ? 'present' : 'unknown');
    // Only approved/pending/removed/rejected have coloured badge classes; anything else
    // (a live comment, unknown) falls back to the neutral grey badge.
    const known = ['approved', 'pending', 'removed', 'rejected'].includes(st);
    statusEl.textContent = st;
    statusEl.className = `badge report-live-status ${known ? 'badge-' + st : 'badge-removed'}`;
  }
  // Creator identity comes ONLY from the trusted live object -- never the reporter-supplied
  // targetCreatedByUid field (which could name a victim). If the object is gone, creatorUid
  // stays null so neither a ban nor a strike can be aimed at an unverified uid.
  const creatorUid = creatorUidOf(live, g.targetType) || null;
  await renderReportCreator(card.querySelector('[data-creator]'), creatorUid, card, g);
  renderReportGroupActions(card.querySelector('[data-actions]'), g, live, creatorUid);
}

function renderReportItems(container, reports) {
  container.innerHTML = '';
  reports.forEach((r) => {
    const item = document.createElement('div');
    item.className = 'report-item';
    const who = r.reporterName || (r.reporterUid ? truncate(r.reporterUid, 10) : 'Anonymous');
    item.innerHTML = `
      <div class="report-item-head">
        <span class="report-reason-chip">${esc(reportReasonLabel(r.reason))}</span>
        <span class="report-item-who">${esc(who)}</span>
        <span class="report-item-date text-muted">${formatDate(r.createdAt)}</span>
      </div>
      <div class="report-item-comment">${esc(r.comment || '')}</div>`;
    container.appendChild(item);
  });
}

async function renderReportCreator(container, creatorUid, card, g) {
  if (!creatorUid) { container.innerHTML = `<span class="text-muted" style="font-size:.75rem">Contributor: anonymous / unknown</span>`; return; }
  container.innerHTML = `<span class="text-muted" style="font-size:.75rem">Contributor&hellip;</span>`;
  let u = _reportUserCache.get(creatorUid);
  if (u === undefined) {
    try { u = await getUserDoc(creatorUid); } catch (_) { u = null; }
    _reportUserCache.set(creatorUid, u);  // dedupe repeat creators across report groups
  }
  const name = (u && (u.displayName || u.githubLogin)) || truncate(creatorUid, 12);
  const strikes = (u && u.removedContentCount) || 0;
  const banned = u && u.status === 'banned';
  const strikeBadge = strikes > 0 ? `<span class="strike-badge${strikes >= 3 ? ' strike-high' : ''}" title="Contributions removed">&#9873; ${strikes} removed</span>` : '';
  container.innerHTML = `
    <span class="report-creator-name">${esc(name)}</span>
    ${banned ? '<span class="badge badge-rejected">Banned</span>' : ''}
    ${strikeBadge}
    ${banned ? '' : '<button class="btn btn-danger btn-sm" data-ban>Ban contributor</button>'}`;
  const banBtn = container.querySelector('[data-ban]');
  if (banBtn) banBtn.addEventListener('click', async () => {
    const reason = prompt(`Ban ${name}?\nReason (shown to the user):`);
    if (reason === null) return;
    banBtn.disabled = true;
    try {
      await adminBanUser(creatorUid, reason || '');
      toast('Contributor banned');
      _reportUserCache.delete(creatorUid);  // re-read so the refreshed row shows "Banned"
      await renderReportCreator(container, creatorUid, card, g);
    } catch (e) { banBtn.disabled = false; toast(e.message, 'error'); }
  });
}

function renderReportGroupActions(container, g, live, creatorUid) {
  container.innerHTML = '';
  if (_reportStatus !== 'open') {
    const r0 = g.reports[0] || {};
    container.innerHTML = `<span class="text-muted" style="font-size:.75rem">Resolved${r0.resolution ? ` (${esc(r0.resolution)})` : ''} ${r0.resolvedAt ? '&middot; ' + formatDate(r0.resolvedAt) : ''}</span>`;
    return;
  }
  const finish = (verb, resolution) => async () => {
    // Resolve reports first (the only step that can throw). The strike bump is best-effort
    // and never throws, and runs after, so a failed-then-retried action can't double-count.
    await adminResolveReports(g.targetPath, resolution);
    if (creatorUid && resolution !== 'dismissed') await adminRecordRemoval(creatorUid);
    container.closest('.report-group').remove();
    toast(`Reports ${verb}`);
    ensureStats(true).then((s) => renderReportsTabCount(s.openReports)).catch(() => {});
  };
  const mk = (label, cls, handler) => {
    const b = document.createElement('button');
    b.className = `btn ${cls} btn-sm`; b.textContent = label;
    b.addEventListener('click', async () => {
      container.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      try { await handler(); }
      catch (e) { toast(e.message, 'error'); }
      // Re-enable if the card survived (e.g. a cancelled confirm); on success it's removed.
      if (container.isConnected) container.querySelectorAll('button').forEach((x) => { x.disabled = false; });
    });
    container.appendChild(b);
  };
  const objGone = !live;
  const softRemove = {
    brand: () => adminSetBrandStatus(g.targetId, 'removed'),
    device: () => adminSetDeviceStatus(g.targetId, 'removed'),
    profile: () => adminSetProfileStatus(g.targetId, 'removed'),
    cycle: () => adminSetCycleStatus(g.targetId, 'removed'),
  }[g.targetType];
  const hardDelete = {
    brand: () => adminDeleteBrand(g.targetId),
    device: () => adminDeleteDevice(g.targetId),
    profile: () => adminDeleteProfile(g.targetId),
    cycle: () => deleteCycle(g.targetId),
    comment: () => adminDeleteComment(g.parentCycleId, g.targetId),
  }[g.targetType];

  if (!objGone && softRemove) {
    mk('Remove (hide)', 'btn-ghost', async () => { await softRemove(); await finish('cleared - object removed', 'removed')(); });
  }
  if (!objGone && hardDelete) {
    mk('Delete permanently', 'btn-danger', async () => {
      if (!confirm(`Permanently delete this ${(_REPORT_TYPE_LABEL[g.targetType] || 'object').toLowerCase()}${g.targetType === 'device' || g.targetType === 'profile' ? ' and all its data' : ''}? This cannot be undone.`)) return;
      await hardDelete(); await finish('cleared - object deleted', 'deleted')();
    });
  }
  mk('Dismiss reports', 'btn-ghost', finish('dismissed', 'dismissed'));
}

$('reports-refresh-btn').addEventListener('click', () => loadReports(true));
$('reports-status-filter').addEventListener('change', (e) => { _reportStatus = e.target.value; loadReports(true); });
$('reports-load-more').addEventListener('click', () => loadReports(false));

// ============================================================ statistics
// 'downloads' = integration adoptions (someone pulled a device/cycle into ha_washdata) —
// the real usage metric. The website has no download action; the integration writes this
// counter server-side. Distinct from the per-cycle DL column (that's per-cycle popularity).
const _STAT_META = [
  { field: 'downloads',      label: 'Downloads (integration)', color: 'c-approved' },
  { field: 'cycle_details',  label: 'Cycle detail views', color: '' },
  { field: 'device_views',   label: 'Device views',    color: '' },
  { field: 'profile_views',  label: 'Profile views',   color: '' },
  { field: 'brand_views',    label: 'Brand views',     color: '' },
  { field: 'searches',       label: 'Searches',        color: '' },
  { field: 'favorites',      label: 'Favorites',       color: '' },
  { field: 'device_confirms',label: 'Device confirms', color: '' },
  { field: 'device_ratings', label: 'Device ratings',  color: '' },
  { field: 'cycle_ratings',  label: 'Cycle ratings',   color: '' },
];

function _statCard(label, value, colorClass) {
  const div = document.createElement('div');
  div.className = 'stat-card';
  div.innerHTML = `<div class="stat-label">${esc(label)}</div>
    <div class="stat-value${colorClass ? ' ' + esc(colorClass) : ''}">${value == null ? '–' : Number(value).toLocaleString()}</div>`;
  return div;
}

function _buildActivityChart(daily, field) {
  if (!daily.length) return '<div class="text-muted" style="font-size:.875rem;padding:.5rem 0">No data yet.</div>';
  const vals = daily.map((d) => d[field] || 0);
  const maxVal = Math.max(...vals, 1);
  const n = daily.length;
  // Viewbox: 700 wide, 96 tall (80 chart + 16 label row).
  const W = 700, CH = 80, LH = 16, padX = 2, gap = 2;
  const barW = Math.max(3, Math.floor((W - 2 * padX - gap * (n - 1)) / n));
  const bars = vals.map((v, i) => {
    const h = Math.max(1, Math.round((v / maxVal) * CH));
    const x = padX + i * (barW + gap);
    const y = CH - h;
    const op = v > 0 ? '1' : '0.2';
    return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="1" opacity="${op}"><title>${daily[i].date}: ${v}</title></rect>`;
  }).join('');
  // Date axis: first / middle / last
  const axisIdx = [0, Math.floor((n - 1) / 2), n - 1];
  const axis = axisIdx.map((i) => {
    const cx = padX + i * (barW + gap) + barW / 2;
    return `<text x="${cx}" y="${CH + LH - 1}" text-anchor="middle" font-size="9" fill="currentColor" opacity=".55">${daily[i].date.slice(5)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${CH + LH}" width="100%" class="analytics-chart" role="img" aria-label="Integration downloads per day">
    <g fill="var(--accent,#6c8ebf)">${bars}</g>${axis}</svg>`;
}

async function loadStatistics() {
  _statsLoaded = true;
  const totalsEl = $('analytics-totals-grid');
  const chartEl = $('analytics-chart-wrap');
  const periodEl = $('analytics-period-grid');
  const labelEl = $('analytics-period-label');
  const label2El = $('analytics-period-label2');

  totalsEl.innerHTML = '<div class="loading-center" style="grid-column:1/-1"><div class="loading-spinner"></div></div>';
  chartEl.innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  periodEl.innerHTML = '';
  if (labelEl) labelEl.textContent = `(last ${_statsDays} days)`;
  if (label2El) label2El.textContent = `(last ${_statsDays} days)`;

  // Catalog totals (users / brands / devices / profiles / cycles). Independent of the
  // analytics fetch so an analytics error never blanks these.
  const catEl = $('catalog-totals-grid');
  if (catEl) {
    catEl.innerHTML = '<div class="loading-center" style="grid-column:1/-1"><div class="loading-spinner"></div></div>';
    ensureStats().then((s) => {
      catEl.innerHTML = '';
      catEl.appendChild(_statCard('Users', s.totalUsers, ''));
      catEl.appendChild(_statCard('Brands', s.totalBrands, ''));
      catEl.appendChild(_statCard('Devices', s.totalDevices, ''));
      catEl.appendChild(_statCard('Profiles', s.totalProfiles, ''));
      catEl.appendChild(_statCard('Cycles', s.totalCycles, 'c-approved'));
    }).catch((e) => { catEl.innerHTML = `<div class="text-muted" style="grid-column:1/-1;padding:1rem">${esc(e.message)}</div>`; });
  }

  try {
    const { totals, daily } = await adminGetAnalytics({ days: _statsDays });
    const slice = daily.slice(-_statsDays);

    // Totals row
    totalsEl.innerHTML = '';
    _STAT_META.forEach(({ field, label, color }) => {
      totalsEl.appendChild(_statCard(label, totals[field], color));
    });

    // Downloads chart
    chartEl.innerHTML = _buildActivityChart(slice, 'downloads');

    // Period breakdown
    periodEl.innerHTML = '';
    _STAT_META.forEach(({ field, label }) => {
      const sum = slice.reduce((acc, d) => acc + (d[field] || 0), 0);
      periodEl.appendChild(_statCard(label, sum, ''));
    });
  } catch (e) {
    totalsEl.innerHTML = `<div class="text-muted" style="grid-column:1/-1;padding:1rem">${esc(e.message)}</div>`;
    chartEl.innerHTML = '';
    periodEl.innerHTML = '';
    toast(e.message, 'error');
  }
}

// Period toggle buttons
['7', '30'].forEach((d) => {
  const btn = $(`period-${d}-btn`);
  if (!btn) return;
  btn.addEventListener('click', () => {
    _statsDays = Number(d);
    $('period-7-btn').className = `btn btn-sm ${_statsDays === 7 ? 'btn-primary' : 'btn-ghost'}`;
    $('period-30-btn').className = `btn btn-sm ${_statsDays === 30 ? 'btn-primary' : 'btn-ghost'}`;
    _statsLoaded = false;
    loadStatistics();
  });
});
$('analytics-refresh-btn').addEventListener('click', () => { _statsLoaded = false; _statsCache = null; loadStatistics(); });

// Backfill / recompute all denormalized count fields (deviceCount, profileCount, cycleCount)
// on existing brand/device/profile docs. Safe to run multiple times.
const recountBtn = $('recount-btn');
if (recountBtn) {
  recountBtn.addEventListener('click', async () => {
    // adminRecount() reads EVERY brand, device, profile, and cycle document (up to 5000
    // each) in one pass -- easily thousands of Firestore reads against the daily free-tier
    // budget. The denormalized counters are maintained incrementally at every mutation, so
    // this is a rare repair, not a routine action. Gate it so it is never clicked casually.
    if (!window.confirm(
      'Recalculate counts?\n\nThis reads every brand, device, profile, and cycle in the '
      + 'store in one pass and can use thousands of daily Firestore reads. The counters are '
      + 'normally kept correct automatically -- only run this to repair drift. Continue?'
    )) return;
    recountBtn.disabled = true;
    recountBtn.textContent = 'Recounting…';
    try {
      const r = await adminRecount();
      toast(`Recounted: ${r.updated} docs updated (${r.brands} brands, ${r.devices} devices, ${r.profiles} profiles, ${r.cycles} cycles)`);
      _statsLoaded = false; _statsCache = null;
      loadStatistics();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      recountBtn.disabled = false;
      recountBtn.textContent = 'Recalculate counts';
    }
  });
}

bindEditorCloseHandlers();
