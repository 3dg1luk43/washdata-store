import firebaseConfig from './config.js';
import {
  init, onAuth, signIn, signOutUser, isAdmin, ensureUserProfile,
  deleteCycle, qcLabel,
  adminListCycles, adminSetCycleStatus,
  adminListDevices, adminSetDeviceStatus, adminSetProfileStatus, adminSetBrandStatus, adminMergeDevices, adminMergeProfiles,
  adminListBrands, adminListProfiles,
  adminListUsers, adminBanUser, adminUnbanUser, adminGetStats,
  getSiteConfig, setMaintenance, setConfirmThreshold,
} from './washstore.js';

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

function sparklineSVG(record, w = 100, h = 60) {
  let pts = record?.trace?.points;
  if (!Array.isArray(pts) || pts.length < 2) return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
  if (pts.length > 200) { const step = Math.ceil(pts.length / 200); pts = pts.filter((_, i) => i % step === 0); }
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const x0 = xs[0], xN = xs[xs.length - 1], yMax = Math.max(...ys) || 1; const pad = 2;
  const sx = (x) => pad + ((x - x0) / (xN - x0 || 1)) * (w - 2 * pad);
  const sy = (y) => h - pad - (y / yMax) * (h - 2 * pad);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" stroke="var(--accent)" stroke-width="1.5" fill="none" stroke-linejoin="round"/></svg>`;
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

function buildBrandRow(b) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${esc(b.brand || '')}</td>
    <td><code class="mono" style="font-size:.7rem">${esc(b.id || '')}</code></td>
    <td><span class="badge badge-${esc(b.status)}">${esc(b.status)}</span></td>
    <td class="text-muted" style="font-size:.75rem">${esc(b.createdByName || '-')}</td>
    <td><div class="action-cell"></div></td>`;
  const cell = tr.querySelector('.action-cell');
  const mk = (label, status) => {
    const btn = document.createElement('button'); btn.className = 'btn btn-ghost btn-sm'; btn.textContent = label;
    btn.addEventListener('click', async () => {
      try {
        await adminSetBrandStatus(b.id, status); b.status = status;
        const badge = tr.children[2].querySelector('.badge'); badge.className = `badge badge-${status}`; badge.textContent = status;
        toast(`Brand ${status}`);
      } catch (e) { toast(e.message, 'error'); }
    });
    cell.appendChild(btn);
  };
  if (b.status !== 'approved') mk('Approve', 'approved');
  if (b.status !== 'removed') mk('Remove', 'removed');
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
  const cell = tr.querySelector('.action-cell');
  const mk = (label, status) => {
    const btn = document.createElement('button'); btn.className = 'btn btn-ghost btn-sm'; btn.textContent = label;
    btn.addEventListener('click', async () => {
      try {
        await adminSetProfileStatus(p.id, status); p.status = status;
        const badge = tr.children[3].querySelector('.badge'); badge.className = `badge badge-${status}`; badge.textContent = status;
        toast(`Profile ${status}`);
      } catch (e) { toast(e.message, 'error'); }
    });
    cell.appendChild(btn);
  };
  if (p.status !== 'approved') mk('Approve', 'approved');
  if (p.status !== 'removed') mk('Remove', 'removed');
  const target = document.createElement('button');
  target.className = 'btn btn-ghost btn-sm'; target.textContent = 'Merge target';
  target.addEventListener('click', () => { $('pmerge-to').value = p.id; });
  cell.appendChild(target);
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
  $('review-modal-sparkline').innerHTML = sparklineSVG(c, 320, 80);
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
