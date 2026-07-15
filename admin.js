import firebaseConfig from './config.js';
import {
  init, onAuth, signIn, signOutUser, isAdmin, ensureUserProfile,
  deleteCycle, qcLabel,
  adminListCycles, adminSetCycleStatus,
  adminListDevices, adminSetDeviceStatus, adminSetProfileStatus, adminSetBrandStatus, adminMergeDevices, adminMergeProfiles,
  adminListBrands, adminListProfiles,
  adminListUsers, adminBanUser, adminUnbanUser, adminGetStats,
  getSiteConfig, setMaintenance, setConfirmThreshold,
  adminSetDeviceOwner,
} from './washstore.js';
import { openSettingsEditor, openPhaseEditor, bindEditorCloseHandlers } from './editors.js';

init(firebaseConfig);

// ============================================================ state
let _isAdmin = false;
let _cyCursor = null;
let _devCursor = null;
let _userCursor = null;
let _cyFilters = { status: '', applianceType: '' };
let _reviewRecord = null;

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
});

// ============================================================ tabs
const TABS = ['overview', 'cycles', 'brands', 'devices', 'profiles', 'users'];
function switchTab(name) {
  TABS.forEach((t) => {
    $(`${t}-tab`).toggleAttribute('hidden', t !== name);
    $(`${t}-btn`).classList.toggle('active', t === name);
    $(`${t}-btn`).setAttribute('aria-selected', t === name ? 'true' : 'false');
  });
}
TABS.forEach((name) => $(`${name}-btn`).addEventListener('click', () => {
  switchTab(name);
  if (name === 'cycles' && !$('cycles-tbody').hasChildNodes()) loadCycles(true);
  if (name === 'brands' && !$('brands-tbody').hasChildNodes()) loadBrands();
  if (name === 'devices' && !$('devices-tbody').hasChildNodes()) loadDevices(true);
  if (name === 'profiles' && !$('profiles-tbody').hasChildNodes()) loadProfiles();
  if (name === 'users' && !$('users-tbody').hasChildNodes()) loadUsers(true);
}));

// ============================================================ overview
async function loadOverview() {
  $('stats-grid').innerHTML = '<div class="loading-center" style="grid-column:1/-1"><div class="loading-spinner"></div></div>';
  try {
    const s = await adminGetStats();
    $('stats-grid').innerHTML = `
      <div class="stat-card"><div class="stat-label">Pending Review</div><div class="stat-value c-pending">${s.pending}</div></div>
      <div class="stat-card"><div class="stat-label">Approved</div><div class="stat-value c-approved">${s.approved}</div></div>
      <div class="stat-card"><div class="stat-label">Rejected</div><div class="stat-value c-rejected">${s.rejected}</div></div>
      <div class="stat-card"><div class="stat-label">Removed</div><div class="stat-value c-removed">${s.removed}</div></div>
      <div class="stat-card"><div class="stat-label">Banned Users</div><div class="stat-value c-ban">${s.bannedUsers}</div></div>`;
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
  const n = Math.max(1, Math.round(Number($('threshold-input').value) || 5));
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
  if (reset) { _cyCursor = null; $('cycles-tbody').innerHTML = `<tr><td colspan="10" class="tbl-msg">Loading...</td></tr>`; $('cycles-load-more').setAttribute('hidden', ''); }
  try {
    const { items, cursor } = await adminListCycles({ status: _cyFilters.status || null, applianceType: _cyFilters.applianceType || null, pageSize: 25, cursor: _cyCursor });
    if (reset) $('cycles-tbody').innerHTML = '';
    if (items.length === 0 && !_cyCursor) { $('cycles-tbody').innerHTML = `<tr><td colspan="10" class="tbl-msg">No cycles found.</td></tr>`; }
    else { items.forEach((c) => $('cycles-tbody').appendChild(buildCycleRow(c))); }
    _cyCursor = cursor; $('cycles-load-more').toggleAttribute('hidden', !cursor);
  } catch (e) {
    if (reset) $('cycles-tbody').innerHTML = `<tr><td colspan="10" class="tbl-msg" style="color:var(--danger)">${esc(e.message)}</td></tr>`;
    toast(e.message, 'error');
  }
}

function buildCycleRow(c) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><code class="mono" style="font-size:.72rem">${esc(truncate(c.id, 8))}</code></td>
    <td>${esc(deviceLabel(c))}</td>
    <td class="truncate" style="max-width:100px" title="${esc(c.program_lc || '')}">${esc(c.program_lc || '')}</td>
    <td><span class="badge badge-type">${esc(typeLabel(c.applianceType))}</span></td>
    <td><span class="badge badge-${esc(c.status)}">${esc(c.status)}</span></td>
    <td class="text-muted" style="font-size:.72rem">${esc(qcLabel(c.qc))}</td>
    <td class="text-muted truncate" title="${esc(c.uploaderName || '')}">${esc(truncate(c.uploaderName || 'Anon', 14))}</td>
    <td class="text-muted" style="white-space:nowrap;font-size:.72rem">${formatDate(c.createdAt)}</td>
    <td class="text-muted">${c.downloads || 0}</td>
    <td><div class="action-cell"></div></td>`;
  buildCycleActions(tr.querySelector('.action-cell'), c, tr);
  return tr;
}

function buildCycleActions(container, c, tr) {
  container.innerHTML = '';
  // Cycles auto-approve by community vote; admins only moderate (remove / delete).
  const setStatus = (status) => async () => {
    try {
      await adminSetCycleStatus(c.id, status);
      c.status = status;
      const badge = tr.children[4].querySelector('.badge');
      badge.className = `badge badge-${status}`; badge.textContent = status;
      buildCycleActions(container, c, tr);
      toast(`Set ${status}`);
    } catch (e) { toast(e.message, 'error'); }
  };
  const mk = (label, cls, handler) => { const b = document.createElement('button'); b.className = `btn ${cls} btn-sm`; b.textContent = label; b.addEventListener('click', handler); container.appendChild(b); };
  if (c.status !== 'removed') mk('Remove', 'btn-ghost', setStatus('removed'));
  else mk('Restore', 'btn-ghost', setStatus('approved'));
  mk('View', 'btn-ghost', () => openReviewModal(c));
  mk('Delete', 'btn-danger', async () => {
    if (!confirm(`Permanently delete this cycle (${deviceLabel(c)} - ${c.program_lc})?`)) return;
    try { await deleteCycle(c.id); tr.remove(); toast('Deleted permanently'); } catch (e) { toast(e.message, 'error'); }
  });
}

$('cy-filter-apply').addEventListener('click', () => { _cyFilters = { status: $('cy-filter-status').value, applianceType: $('cy-filter-type').value }; loadCycles(true); });
$('cy-filter-clear').addEventListener('click', () => { $('cy-filter-status').value = ''; $('cy-filter-type').value = ''; _cyFilters = { status: '', applianceType: '' }; loadCycles(true); });
$('cycles-load-more').addEventListener('click', () => loadCycles(false));

// ============================================================ devices table
async function loadDevices(reset = false) {
  if (reset) { _devCursor = null; $('devices-tbody').innerHTML = `<tr><td colspan="8" class="tbl-msg">Loading...</td></tr>`; $('devices-load-more').setAttribute('hidden', ''); }
  try {
    const { items, cursor } = await adminListDevices({ pageSize: 40, cursor: _devCursor });
    if (reset) $('devices-tbody').innerHTML = '';
    // Pending first so items needing review are easy to find.
    items.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1));
    if (items.length === 0 && !_devCursor) { $('devices-tbody').innerHTML = `<tr><td colspan="8" class="tbl-msg">No devices found.</td></tr>`; }
    else { items.forEach((d) => $('devices-tbody').appendChild(buildDeviceRow(d))); }
    _devCursor = cursor; $('devices-load-more').toggleAttribute('hidden', !cursor);
  } catch (e) {
    if (reset) $('devices-tbody').innerHTML = `<tr><td colspan="8" class="tbl-msg" style="color:var(--danger)">${esc(e.message)}</td></tr>`;
    toast(e.message, 'error');
  }
}

function buildDeviceRow(d) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><code class="mono" style="font-size:.7rem">${esc(truncate(d.id, 26))}</code></td>
    <td>${esc(d.brand || '')}</td>
    <td>${esc(d.model || '')}</td>
    <td><span class="badge badge-type">${esc(typeLabel(d.applianceType))}</span></td>
    <td><span class="badge badge-${esc(d.status)}">${esc(d.status)}</span></td>
    <td class="text-muted">${d.favoriteCount || 0}</td>
    <td class="text-muted">${d.confirmCount || 0}</td>
    <td><div class="action-cell"></div></td>`;
  const cell = tr.querySelector('.action-cell');
  const mkBtn = (label, status) => {
    const b = document.createElement('button'); b.className = 'btn btn-ghost btn-sm'; b.textContent = label;
    b.addEventListener('click', async () => {
      try {
        await adminSetDeviceStatus(d.id, status); d.status = status;
        const badge = tr.children[4].querySelector('.badge'); badge.className = `badge badge-${status}`; badge.textContent = status;
        toast(`Device ${status}`);
      } catch (e) { toast(e.message, 'error'); }
    });
    cell.appendChild(b);
  };
  if (d.status !== 'approved') mkBtn('Approve', 'approved');
  if (d.status !== 'removed') mkBtn('Remove', 'removed');
  const useAsTarget = document.createElement('button');
  useAsTarget.className = 'btn btn-ghost btn-sm'; useAsTarget.textContent = 'Merge target';
  useAsTarget.addEventListener('click', () => { $('merge-to').value = d.id; switchTab('devices'); });
  cell.appendChild(useAsTarget);
  const editSettings = document.createElement('button');
  editSettings.className = 'btn btn-ghost btn-sm'; editSettings.textContent = 'Edit settings';
  editSettings.addEventListener('click', () => openSettingsEditor(d));
  cell.appendChild(editSettings);
  const setOwner = document.createElement('button');
  setOwner.className = 'btn btn-ghost btn-sm'; setOwner.textContent = 'Set owner';
  setOwner.addEventListener('click', async () => {
    const uid = prompt(`Owner UID for ${d.id}\n(current: ${d.ownerId || 'none'})\nLeave blank to remove owner:`);
    if (uid === null) return;
    try {
      await adminSetDeviceOwner(d.id, uid.trim() || null);
      d.ownerId = uid.trim() || null;
      toast(uid.trim() ? `Owner set to ${uid.trim()}` : 'Owner cleared');
    } catch (e) { toast(e.message, 'error'); }
  });
  cell.appendChild(setOwner);
  return tr;
}

$('merge-btn').addEventListener('click', async () => {
  const from = $('merge-from').value.trim();
  const to = $('merge-to').value.trim();
  if (!from || !to) { toast('Enter both source and target deviceId', 'error'); return; }
  if (!confirm(`Merge ${from} into ${to}? All its profiles/cycles are reassigned and the source device is deleted.`)) return;
  try { await adminMergeDevices(from, to); toast('Merged'); $('merge-from').value = ''; $('merge-to').value = ''; loadDevices(true); }
  catch (e) { toast(e.message, 'error'); }
});
$('devices-load-more').addEventListener('click', () => loadDevices(false));

// ============================================================ brands review
async function loadBrands() {
  $('brands-tbody').innerHTML = `<tr><td colspan="5" class="tbl-msg">Loading...</td></tr>`;
  try {
    const { items } = await adminListBrands();
    $('brands-tbody').innerHTML = '';
    if (items.length === 0) { $('brands-tbody').innerHTML = `<tr><td colspan="5" class="tbl-msg">No brands found.</td></tr>`; return; }
    // Pending first so they are easy to review.
    items.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1));
    items.forEach((b) => $('brands-tbody').appendChild(buildBrandRow(b)));
  } catch (e) {
    $('brands-tbody').innerHTML = `<tr><td colspan="5" class="tbl-msg" style="color:var(--danger)">${esc(e.message)}</td></tr>`;
    toast(e.message, 'error');
  }
}

// Optimistically adjust the Overview "Pending Review" count so the UI matches what a
// refresh would show, without re-querying.
function bumpPending(delta) {
  if (!delta) return;
  const el = document.querySelector('#stats-grid .c-pending');
  if (!el) return;
  const n = parseInt(el.textContent, 10);
  if (!isNaN(n)) el.textContent = String(Math.max(0, n + delta));
}

// Shared Approve/Remove action cell for brands & profiles: rebuilds itself after a
// status change (so Approve disappears once approved), updates the row badge, and
// adjusts the pending count. `extra` appends type-specific buttons (e.g. Merge target).
function buildStatusActions(tr, rec, setter, label, extra) {
  const cell = tr.querySelector('.action-cell');
  cell.innerHTML = '';
  // Guard against a second click while a write is in flight: two rapid clicks
  // (e.g. Approve then Remove) would both capture wasPending and decrement the
  // pending counter twice with competing writes.
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
        const badge = tr.querySelector('.badge'); if (badge) { badge.className = `badge badge-${status}`; badge.textContent = status; }
        bumpPending((wasPending ? -1 : 0) + (status === 'pending' ? 1 : 0));
        buildStatusActions(tr, rec, setter, label, extra);
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
  if (rec.status !== 'removed') mk('Remove', 'removed');
  if (extra) extra(cell);
}

function buildBrandRow(b) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${esc(b.brand || '')}</td>
    <td><code class="mono" style="font-size:.7rem">${esc(b.id || '')}</code></td>
    <td><span class="badge badge-${esc(b.status)}">${esc(b.status)}</span></td>
    <td class="text-muted" style="font-size:.75rem">${esc(b.createdByName || '-')}</td>
    <td><div class="action-cell"></div></td>`;
  buildStatusActions(tr, b, adminSetBrandStatus, 'Brand');
  return tr;
}

// ============================================================ profiles review
async function loadProfiles() {
  $('profiles-tbody').innerHTML = `<tr><td colspan="5" class="tbl-msg">Loading...</td></tr>`;
  try {
    const { items } = await adminListProfiles();
    $('profiles-tbody').innerHTML = '';
    if (items.length === 0) { $('profiles-tbody').innerHTML = `<tr><td colspan="5" class="tbl-msg">No profiles found.</td></tr>`; return; }
    items.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1));
    items.forEach((p) => $('profiles-tbody').appendChild(buildProfileRow(p)));
  } catch (e) {
    $('profiles-tbody').innerHTML = `<tr><td colspan="5" class="tbl-msg" style="color:var(--danger)">${esc(e.message)}</td></tr>`;
    toast(e.message, 'error');
  }
}

function buildProfileRow(p) {
  const tr = document.createElement('tr');
  const dev = String(p.deviceId || '').split('__').slice(1).join(' ').trim() || p.deviceId || '-';
  tr.innerHTML = `
    <td>${esc(p.program || '')}</td>
    <td class="text-muted">${esc(dev)}</td>
    <td><code class="mono" style="font-size:.68rem">${esc(truncate(p.id, 30))}</code></td>
    <td><span class="badge badge-${esc(p.status)}">${esc(p.status)}</span></td>
    <td class="text-muted" style="font-size:.75rem">${esc(p.createdByName || '-')}</td>
    <td><div class="action-cell"></div></td>`;
  buildStatusActions(tr, p, adminSetProfileStatus, 'Profile', (cell) => {
    const target = document.createElement('button');
    target.className = 'btn btn-ghost btn-sm'; target.textContent = 'Merge target';
    target.addEventListener('click', () => { $('pmerge-to').value = p.id; });
    cell.appendChild(target);
    const editPhases = document.createElement('button');
    editPhases.className = 'btn btn-ghost btn-sm'; editPhases.textContent = 'Edit phases';
    editPhases.addEventListener('click', () => openPhaseEditor(p));
    cell.appendChild(editPhases);
  });
  return tr;
}

$('pmerge-btn').addEventListener('click', async () => {
  const from = $('pmerge-from').value.trim();
  const to = $('pmerge-to').value.trim();
  if (!from || !to) { toast('Enter both source and target profileId', 'error'); return; }
  if (!confirm(`Merge ${from} into ${to}? All its cycles are reassigned and the source profile is deleted.`)) return;
  try { await adminMergeProfiles(from, to); toast('Merged'); $('pmerge-from').value = ''; $('pmerge-to').value = ''; loadProfiles(); }
  catch (e) { toast(e.message, 'error'); }
});

// ============================================================ users table
async function loadUsers(reset = false) {
  if (reset) { _userCursor = null; $('users-tbody').innerHTML = `<tr><td colspan="6" class="tbl-msg">Loading...</td></tr>`; $('users-load-more').setAttribute('hidden', ''); }
  try {
    const { items, cursor } = await adminListUsers({ pageSize: 40, cursor: _userCursor });
    if (reset) $('users-tbody').innerHTML = '';
    if (items.length === 0 && !_userCursor) { $('users-tbody').innerHTML = `<tr><td colspan="6" class="tbl-msg">No users found.</td></tr>`; }
    else { items.forEach((u) => $('users-tbody').appendChild(buildUserRow(u))); }
    _userCursor = cursor; $('users-load-more').toggleAttribute('hidden', !cursor);
  } catch (e) {
    if (reset) $('users-tbody').innerHTML = `<tr><td colspan="6" class="tbl-msg" style="color:var(--danger)">${esc(e.message)}</td></tr>`;
    toast(e.message, 'error');
  }
}

function buildUserRow(u) {
  const tr = document.createElement('tr');
  const initial = (u.displayName || 'U').charAt(0).toUpperCase();
  const avatar = u.photoURL ? `<img src="${esc(u.photoURL)}" alt="">` : initial;
  tr.innerHTML = `
    <td><div class="user-cell"><div class="user-cell-avatar">${avatar}</div><span style="font-size:.8125rem;font-weight:500">${esc(u.displayName || 'Unknown')}</span></div></td>
    <td><code class="mono" style="font-size:.7rem">${esc(truncate(u.uid, 12))}</code></td>
    <td>${statusBadge(u)}</td>
    <td class="text-muted" style="font-size:.75rem;max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(u.banReason || '-')}</td>
    <td class="text-muted" style="white-space:nowrap;font-size:.72rem">${formatDate(u.createdAt)}</td>
    <td><div class="action-cell"></div></td>`;
  buildUserActions(tr.querySelector('.action-cell'), u, tr);
  return tr;
}
function statusBadge(u) {
  return u.banned ? `<span class="badge badge-rejected">Banned</span>` : `<span class="badge badge-approved">Active</span>`;
}
function buildUserActions(cell, u, tr) {
  cell.innerHTML = '';
  const b = document.createElement('button');
  if (u.banned) {
    b.className = 'btn btn-ghost btn-sm'; b.textContent = 'Unban';
    b.addEventListener('click', async () => {
      if (!confirm(`Unban ${u.displayName || u.uid}?`)) return;
      try { await adminUnbanUser(u.uid); u.banned = false; u.banReason = null; refreshUserRow(tr, u); toast('User unbanned'); } catch (e) { toast(e.message, 'error'); }
    });
  } else {
    b.className = 'btn btn-danger btn-sm'; b.textContent = 'Ban';
    b.addEventListener('click', async () => {
      const reason = prompt(`Ban reason for ${u.displayName || u.uid}:`); if (reason === null) return;
      try { await adminBanUser(u.uid, reason || ''); u.banned = true; u.banReason = reason || ''; refreshUserRow(tr, u); toast('User banned'); } catch (e) { toast(e.message, 'error'); }
    });
  }
  cell.appendChild(b);
}
function refreshUserRow(tr, u) {
  const cells = tr.querySelectorAll('td');
  cells[2].innerHTML = statusBadge(u);
  cells[3].textContent = u.banReason || '-';
  buildUserActions(cells[5].querySelector('.action-cell'), u, tr);
}
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

bindEditorCloseHandlers();
