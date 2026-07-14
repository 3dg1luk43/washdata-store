import firebaseConfig from './config.js';
import {
  init, onAuth, signIn, signOutUser, isAdmin, ensureUserProfile,
  searchDevices, getDevice, getProfiles, getReferenceCycles, getCycle,
  uploadReferenceCycle, deleteCycle, bumpDownload, favoriteDevice, getFavorites, myCycles,
  addComment, listComments, deleteComment,
  submitRating, getUserRating, getRatingSummary,
  parseCycle, cycleStats, saveAsFile,
} from './washstore.js';

init(firebaseConfig);

// ============================================================ state
let _user = null;
let _adminFlag = false;
let _view = 'devices';            // devices | device | profile
let _device = null;               // { id, brand, model, applianceType, ... }
let _profile = null;              // { id, program, ... }
let _browseCursor = null;
let _browseFilters = { applianceType: '', brand: '', favoritesOnly: false };
let _favorites = new Set();
let _mineLoadedUid = null;
let _mineCursor = null;
let _openRecord = null;
let _replyToId = null;
let _parsedUpload = null;         // { points, stats }

const _ratingCache = new Map();

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
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rem}s`;
  return `${rem}s`;
}

function typeLabel(t) {
  return { washer: 'Washer', dryer: 'Dryer', dishwasher: 'Dishwasher', washer_dryer: 'Washer-Dryer' }[t] || t;
}

function modelOf(device) {
  return device.model || String(device.id || '').split('__')[2] || '';
}

// Sparkline drawn from a reference cycle's trace points.
function sparklineSVG(record, w = 160, h = 48) {
  let pts = record?.trace?.points;
  if (!Array.isArray(pts) || pts.length < 2) {
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
  }
  if (pts.length > 200) {
    const step = Math.ceil(pts.length / 200);
    pts = pts.filter((_, i) => i % step === 0);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = xs[0], xN = xs[xs.length - 1], yMax = Math.max(...ys) || 1;
  const pad = 3;
  const sx = (x) => pad + ((x - x0) / (xN - x0 || 1)) * (w - 2 * pad);
  const sy = (y) => h - pad - (y / yMax) * (h - 2 * pad);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <path d="${d}" stroke="var(--accent)" stroke-width="1.5" fill="none" stroke-linejoin="round"/></svg>`;
}

function fetchRatingSummary(id) {
  if (!_ratingCache.has(id)) _ratingCache.set(id, getRatingSummary(id));
  return _ratingCache.get(id);
}

async function populateCardRating(el, id) {
  try {
    const { avg, count } = await fetchRatingSummary(id);
    if (avg == null) return;
    const badge = el.querySelector('[data-rating]');
    if (badge) { badge.innerHTML = `&#9733; ${avg.toFixed(1)}`; badge.removeAttribute('hidden'); }
    const meta = el.querySelector('[data-rating-meta]');
    if (meta) meta.textContent = `· ${count} rating${count > 1 ? 's' : ''}`;
  } catch (_) {}
}

function loadingPlaceholder() {
  const el = document.createElement('div');
  el.className = 'loading-center';
  el.style.gridColumn = '1 / -1';
  el.innerHTML = '<div class="loading-spinner"></div>';
  return el;
}

function emptyHTML(icon, title, text) {
  return `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">${icon}</div>
    <div class="empty-title">${esc(title)}</div><div class="empty-text">${esc(text)}</div></div>`;
}

// ============================================================ auth
function renderAuthArea(user) {
  const area = $('auth-status');
  if (user) {
    area.innerHTML = `${user.photoURL ? `<img class="user-avatar" src="${esc(user.photoURL)}" alt="">` : ''}
      <span class="user-name">${esc(user.displayName || 'User')}</span>
      <button class="btn btn-ghost btn-sm" id="signout-btn">Sign out</button>`;
    $('signout-btn').addEventListener('click', async () => { try { await signOutUser(); } catch (e) { toast(e.message, 'error'); } });
  } else {
    area.innerHTML = `<button class="btn btn-primary btn-sm" id="signin-btn">Sign in with GitHub</button>`;
    $('signin-btn').addEventListener('click', doSignIn);
  }
}

async function doSignIn() { try { await signIn(); } catch (e) { toast(e.message, 'error'); } }

onAuth(async (user) => {
  _user = user;
  _adminFlag = false;
  _favorites = new Set();
  renderAuthArea(user);
  updateUploadAuth();
  updateMineAuth();
  if (user) {
    try { await ensureUserProfile(user); } catch (_) {}
    try { _adminFlag = await isAdmin(); } catch (_) {}
    try { _favorites = new Set(await getFavorites()); } catch (_) {}
  }
  $('admin-link').toggleAttribute('hidden', !_adminFlag);
  if (!$('mine-tab').hasAttribute('hidden')) maybeLoadMine();
  updateCommentFormAuth();
});

// ============================================================ tabs
function switchTab(name) {
  ['browse', 'upload', 'mine'].forEach((t) => {
    $(`${t}-tab`).toggleAttribute('hidden', t !== name);
    $(`${t}-btn`).classList.toggle('active', t === name);
    $(`${t}-btn`).setAttribute('aria-selected', t === name ? 'true' : 'false');
    $(`${t}-nav`).classList.toggle('active', t === name);
  });
  if (name === 'browse' && !$('browse-body').hasChildNodes()) loadDevices(true);
  if (name === 'mine') maybeLoadMine();
}

['browse', 'upload', 'mine'].forEach((n) => {
  $(`${n}-btn`).addEventListener('click', () => switchTab(n));
  $(`${n}-nav`).addEventListener('click', () => switchTab(n));
});

// ============================================================ breadcrumb
function renderBreadcrumb() {
  const bc = $('breadcrumb');
  if (_view === 'devices') { bc.setAttribute('hidden', ''); return; }
  bc.removeAttribute('hidden');
  const parts = [`<button class="crumb" data-to="devices">Devices</button>`];
  if (_device) parts.push(`<span class="crumb-sep">/</span><button class="crumb" data-to="device">${esc(_device.brand)} ${esc(modelOf(_device))}</button>`);
  if (_view === 'profile' && _profile) parts.push(`<span class="crumb-sep">/</span><span class="crumb current">${esc(_profile.program)}</span>`);
  bc.innerHTML = parts.join('');
  bc.querySelectorAll('.crumb[data-to]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.to === 'devices') { _view = 'devices'; loadDevices(true); }
    else if (b.dataset.to === 'device') openDevice(_device);
  }));
}

// ============================================================ browse: devices
async function loadDevices(reset = false) {
  _view = 'devices';
  $('filter-rail').removeAttribute('hidden');
  renderBreadcrumb();
  const body = $('browse-body');
  if (reset) { _browseCursor = null; body.innerHTML = '<div class="card-grid" id="device-grid"></div>'; $('load-more-btn').setAttribute('hidden', ''); }
  const grid = $('device-grid') || body.querySelector('.card-grid');
  const spinner = loadingPlaceholder();
  grid.appendChild(spinner);
  try {
    const { applianceType, brand, favoritesOnly } = _browseFilters;
    if (favoritesOnly && !_user) { spinner.remove(); grid.innerHTML = emptyHTML('&#11088;', 'Sign in for favorites', 'Sign in to save and browse favorite devices.'); return; }
    const { items, cursor } = await searchDevices({ applianceType: applianceType || null, brand: brand || null, favoritesOnly, pageSize: 24, cursor: _browseCursor });
    spinner.remove();
    if (items.length === 0 && !_browseCursor) { grid.innerHTML = emptyHTML('&#128269;', 'No devices found', 'Try a different filter, or upload the first cycle for your appliance.'); }
    else { items.forEach((d) => grid.appendChild(buildDeviceCard(d))); }
    _browseCursor = cursor;
    $('load-more-btn').toggleAttribute('hidden', !cursor);
  } catch (e) { spinner.remove(); toast(e.message, 'error'); }
}

function buildDeviceCard(d) {
  const el = document.createElement('div');
  el.className = 'card device-card';
  const starred = _favorites.has(d.id);
  el.innerHTML = `
    <div class="card-body">
      <div class="card-title">${esc(d.brand)} ${esc(modelOf(d))}</div>
      <div class="card-badges">
        <span class="badge badge-type">${esc(typeLabel(d.applianceType))}</span>
        ${d.profileCount ? `<span class="badge">${d.profileCount} program${d.profileCount > 1 ? 's' : ''}</span>` : ''}
      </div>
      <div class="card-meta"><span>&#11088; ${d.favoriteCount || 0}</span></div>
    </div>
    <div class="card-actions">
      <button class="btn btn-primary btn-sm" data-open>Open</button>
      <button class="btn btn-ghost btn-sm star-btn${starred ? ' on' : ''}" data-star aria-label="Toggle favorite">${starred ? '&#9733;' : '&#9734;'}</button>
    </div>`;
  el.querySelector('[data-open]').addEventListener('click', () => openDevice(d));
  el.querySelector('[data-star]').addEventListener('click', (ev) => toggleStar(ev.currentTarget, d));
  return el;
}

async function toggleStar(btn, d) {
  if (!_user) { toast('Sign in to save favorites', 'error'); return; }
  const on = !_favorites.has(d.id);
  try {
    await favoriteDevice(d.id, on);
    if (on) _favorites.add(d.id); else _favorites.delete(d.id);
    btn.classList.toggle('on', on);
    btn.innerHTML = on ? '&#9733;' : '&#9734;';
  } catch (e) { toast(e.message, 'error'); }
}

// ============================================================ browse: device -> profiles
async function openDevice(d) {
  _device = d; _profile = null; _view = 'device';
  $('filter-rail').setAttribute('hidden', '');
  $('load-more-btn').setAttribute('hidden', '');
  renderBreadcrumb();
  const body = $('browse-body');
  body.innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    const profiles = await getProfiles(d.id);
    if (profiles.length === 0) { body.innerHTML = emptyHTML('&#128203;', 'No programs yet', 'No approved programs for this device yet. Be the first to upload one.'); return; }
    const list = document.createElement('div');
    list.className = 'profile-list';
    profiles.forEach((p) => list.appendChild(buildProfileRow(p)));
    body.innerHTML = '';
    body.appendChild(list);
  } catch (e) { body.innerHTML = emptyHTML('&#9888;', 'Failed to load', esc(e.message)); }
}

function buildProfileRow(p) {
  const el = document.createElement('button');
  el.className = 'profile-row';
  el.innerHTML = `<span class="profile-name">${esc(p.program)}</span>
    <span class="profile-meta">${p.cycleCount || 0} cycle${p.cycleCount === 1 ? '' : 's'} &rsaquo;</span>`;
  el.addEventListener('click', () => openProfile(p));
  return el;
}

// ============================================================ browse: profile -> reference cycles
async function openProfile(p) {
  _profile = p; _view = 'profile';
  renderBreadcrumb();
  const body = $('browse-body');
  body.innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    const { items } = await getReferenceCycles(p.id);
    if (items.length === 0) { body.innerHTML = emptyHTML('&#128200;', 'No reference cycles', 'No approved reference cycles for this program yet.'); return; }
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    items.forEach((c) => grid.appendChild(buildCycleCard(c)));
    body.innerHTML = '';
    body.appendChild(grid);
  } catch (e) { body.innerHTML = emptyHTML('&#9888;', 'Failed to load', esc(e.message)); }
}

function buildCycleCard(c) {
  const el = document.createElement('div');
  el.className = 'card';
  const st = c.stats || {};
  el.innerHTML = `
    <div class="card-sparkline">${sparklineSVG(c, 160, 48)}</div>
    <div class="card-body">
      <div class="card-title">${esc(_profile ? _profile.program : c.program_lc)}</div>
      <div class="card-subtitle">${formatDuration(st.duration)} &middot; ${st.energy_wh != null ? (st.energy_wh / 1000).toFixed(2) + ' kWh' : '-'}</div>
      <div class="card-badges"><span class="badge badge-rating" data-rating hidden></span></div>
      <div class="card-meta"><span>by ${esc(c.uploaderName || 'Anonymous')}</span><span>&middot; ${c.downloads || 0} dl</span><span data-rating-meta></span></div>
    </div>
    <div class="card-actions">
      <button class="btn btn-primary btn-sm" data-details>Details</button>
      <button class="btn btn-ghost btn-sm" data-dl>Download</button>
    </div>`;
  el.querySelector('[data-details]').addEventListener('click', () => openDetails(c));
  el.querySelector('[data-dl]').addEventListener('click', () => doDownload(c));
  populateCardRating(el, c.id);
  return el;
}

async function doDownload(c) {
  try { await bumpDownload(c.id); saveAsFile(c); } catch (e) { toast(e.message, 'error'); }
}

$('filter-apply').addEventListener('click', () => {
  _browseFilters = { applianceType: $('filter-type').value, brand: $('filter-brand').value.trim(), favoritesOnly: $('filter-favorites').checked };
  loadDevices(true);
});
$('filter-clear').addEventListener('click', () => {
  $('filter-type').value = ''; $('filter-brand').value = ''; $('filter-favorites').checked = false;
  _browseFilters = { applianceType: '', brand: '', favoritesOnly: false };
  loadDevices(true);
});
$('load-more-btn').addEventListener('click', () => { if (_view === 'devices') loadDevices(false); });

// ============================================================ upload
function updateUploadAuth() {
  $('upload-auth-notice').toggleAttribute('hidden', !!_user);
  $('upload-form').toggleAttribute('hidden', !_user);
}
$('upload-signin-btn').addEventListener('click', doSignIn);

$('up-cycle-file').addEventListener('change', async () => {
  _parsedUpload = null;
  const prev = $('upload-preview');
  const file = $('up-cycle-file').files[0];
  if (!file) { prev.setAttribute('hidden', ''); return; }
  try {
    const points = parseCycle(await file.text());
    const stats = cycleStats(points);
    _parsedUpload = { points, stats };
    prev.innerHTML = `${sparklineSVG({ trace: { points } }, 240, 60)}
      <div class="text-muted" style="font-size:.8125rem">${points.length} points &middot; ${formatDuration(stats.duration)} &middot; ${(stats.energy_wh / 1000).toFixed(2)} kWh &middot; peak ${stats.peak_w} W</div>`;
    prev.removeAttribute('hidden');
  } catch (e) { prev.innerHTML = `<span class="text-danger">Cycle file error: ${esc(e.message)}</span>`; prev.removeAttribute('hidden'); }
});

$('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!_user) { toast('Please sign in first', 'error'); return; }
  const btn = $('upload-submit');
  const resultEl = $('upload-result');
  btn.disabled = true; btn.textContent = 'Uploading...'; resultEl.setAttribute('hidden', '');
  try {
    if (!_parsedUpload) throw new Error('Attach a valid reference cycle file first');
    const interval = Number($('up-interval').value);
    if (!interval || interval <= 0 || interval > 3600) throw new Error('Sample interval must be between 1 and 3600');
    const meta = {
      applianceType: $('up-type').value,
      brand: $('up-brand').value.trim(),
      model: $('up-model').value.trim(),
      program: $('up-program').value.trim(),
      sampleIntervalSec: interval,
      description: $('up-desc').value.trim(),
    };
    // Website uploads are provenance code 3 (manually added). The integration sets the real code.
    await uploadReferenceCycle(meta, _parsedUpload.points, _parsedUpload.stats, 3);
    $('upload-form').reset();
    $('upload-preview').setAttribute('hidden', '');
    _parsedUpload = null;
    resultEl.textContent = 'Submitted for review. It will appear publicly once approved.';
    resultEl.className = 'text-success mt-1';
    resultEl.removeAttribute('hidden');
    toast('Upload submitted - pending review');
  } catch (err) {
    resultEl.textContent = err.message; resultEl.className = 'text-danger mt-1'; resultEl.removeAttribute('hidden');
    toast(err.message, 'error');
  } finally { btn.disabled = false; btn.textContent = 'Submit Upload'; }
});

// ============================================================ my uploads
function updateMineAuth() {
  $('mine-signin-notice').toggleAttribute('hidden', !!_user);
  $('mine-content').toggleAttribute('hidden', !_user);
  if (!_user) { _mineLoadedUid = null; $('mine-grid').innerHTML = ''; $('mine-load-more').setAttribute('hidden', ''); }
}
$('mine-signin-btn').addEventListener('click', doSignIn);

function maybeLoadMine() {
  updateMineAuth();
  if (!_user) return;
  if (_mineLoadedUid === _user.uid && $('mine-grid').hasChildNodes()) return;
  _mineLoadedUid = _user.uid; _mineCursor = null; $('mine-grid').innerHTML = ''; $('mine-load-more').setAttribute('hidden', '');
  fetchMine();
}

async function fetchMine() {
  const spinner = loadingPlaceholder();
  $('mine-grid').appendChild(spinner);
  try {
    const { items, cursor } = await myCycles({ pageSize: 24, cursor: _mineCursor });
    spinner.remove();
    if (items.length === 0 && !_mineCursor) { $('mine-grid').innerHTML = emptyHTML('&#128228;', 'No uploads yet', 'Share your first reference cycle with the community.'); }
    else { items.forEach((c) => $('mine-grid').appendChild(buildMineCard(c))); }
    _mineCursor = cursor;
    $('mine-load-more').toggleAttribute('hidden', !cursor);
  } catch (e) { spinner.remove(); toast(e.message, 'error'); }
}

function buildMineCard(c) {
  const el = document.createElement('div');
  el.className = 'card';
  const parts = String(c.deviceId || '').split('__');
  el.innerHTML = `
    <div class="card-sparkline">${sparklineSVG(c, 160, 48)}</div>
    <div class="card-body">
      <div class="card-title">${esc(parts[1] || '')} ${esc(parts[2] || '')}</div>
      <div class="card-subtitle">${esc(c.program_lc || '')}</div>
      <div class="card-badges">
        <span class="badge badge-type">${esc(typeLabel(c.applianceType))}</span>
        <span class="badge badge-${esc(c.status)}">${esc(c.status)}</span>
      </div>
      ${c.rejectionReason ? `<div class="rejection-reason mt-1">${esc(c.rejectionReason)}</div>` : ''}
      <div class="card-meta"><span>${formatDate(c.createdAt)}</span><span>&middot; ${c.downloads || 0} downloads</span></div>
    </div>
    <div class="card-actions">
      <button class="btn btn-ghost btn-sm" data-details>Details</button>
      <button class="btn btn-danger btn-sm" data-del>Delete</button>
    </div>`;
  el.querySelector('[data-details]').addEventListener('click', () => openDetails(c));
  el.querySelector('[data-del]').addEventListener('click', async () => {
    if (!confirm('Delete this reference cycle? This cannot be undone.')) return;
    try {
      await deleteCycle(c.id); el.remove(); toast('Deleted');
      if (!$('mine-grid').hasChildNodes()) $('mine-grid').innerHTML = emptyHTML('&#128228;', 'No uploads yet', 'Share your first reference cycle.');
    } catch (e) { toast(e.message, 'error'); }
  });
  return el;
}
$('mine-load-more').addEventListener('click', fetchMine);

// ============================================================ details modal
async function openDetails(c) {
  _openRecord = c; _replyToId = null;
  const parts = String(c.deviceId || '').split('__');
  $('modal-title').textContent = `${parts[1] || ''} ${parts[2] || ''}`.trim() || 'Reference cycle';
  $('modal-program').textContent = _profile ? _profile.program : (c.program_lc || '');
  $('modal-badges').innerHTML = `<span class="badge badge-type">${esc(typeLabel(c.applianceType))}</span>
    <span class="badge badge-${esc(c.status)}">${esc(c.status)}</span>`;
  $('modal-sparkline').innerHTML = sparklineSVG(c, 320, 80);
  $('modal-detail-content').innerHTML = buildDetailGrid(c);
  switchModalTab('detail');
  $('modal-json-content').textContent = JSON.stringify({ trace: c.trace, stats: c.stats, cycleSchemaVersion: c.cycleSchemaVersion }, null, 2);
  await loadRatingSection(c.id);
  await loadComments(c.id);
  updateCommentFormAuth();
  $('details-modal').removeAttribute('hidden');
  $('details-modal').focus();
}

function buildDetailGrid(c) {
  const st = c.stats || {};
  const parts = String(c.deviceId || '').split('__');
  return `<div class="detail-grid">
    <div class="detail-item"><span class="detail-label">Brand</span><span class="detail-value">${esc(parts[1] || '')}</span></div>
    <div class="detail-item"><span class="detail-label">Model</span><span class="detail-value">${esc(parts[2] || '')}</span></div>
    <div class="detail-item"><span class="detail-label">Program</span><span class="detail-value">${esc(_profile ? _profile.program : c.program_lc)}</span></div>
    <div class="detail-item"><span class="detail-label">Type</span><span class="detail-value">${esc(typeLabel(c.applianceType))}</span></div>
    <div class="detail-item"><span class="detail-label">Duration</span><span class="detail-value">${formatDuration(st.duration)}</span></div>
    <div class="detail-item"><span class="detail-label">Energy</span><span class="detail-value">${st.energy_wh != null ? (st.energy_wh / 1000).toFixed(3) + ' kWh' : '-'}</span></div>
    <div class="detail-item"><span class="detail-label">Peak</span><span class="detail-value">${st.peak_w != null ? st.peak_w + ' W' : '-'}</span></div>
    <div class="detail-item"><span class="detail-label">Interval</span><span class="detail-value">${c.trace && c.trace.sampleIntervalSec != null ? c.trace.sampleIntervalSec + 's' : '-'}</span></div>
    <div class="detail-item"><span class="detail-label">Uploader</span><span class="detail-value">${esc(c.uploaderName || 'Anonymous')}</span></div>
    <div class="detail-item"><span class="detail-label">Uploaded</span><span class="detail-value">${formatDate(c.createdAt)}</span></div>
    <div class="detail-item"><span class="detail-label">Downloads</span><span class="detail-value">${c.downloads || 0}</span></div>
    <div class="detail-item"><span class="detail-label">Schema v</span><span class="detail-value">${c.cycleSchemaVersion ?? '-'}</span></div>
  </div>`;
}

function closeModal() { $('details-modal').setAttribute('hidden', ''); _openRecord = null; cancelReply(); }
$('modal-close').addEventListener('click', closeModal);
$('modal-close-footer').addEventListener('click', closeModal);
$('details-modal').addEventListener('click', (e) => { if (e.target === $('details-modal')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('details-modal').hasAttribute('hidden')) closeModal(); });
$('modal-download-btn').addEventListener('click', () => { if (_openRecord) doDownload(_openRecord); });

function switchModalTab(name) {
  ['detail', 'json', 'comments'].forEach((t) => {
    $(`modal-${t}-section`).toggleAttribute('hidden', t !== name);
    $(`modal-${t}-tab-btn`).classList.toggle('active', t === name);
  });
}
$('modal-detail-tab-btn').addEventListener('click', () => switchModalTab('detail'));
$('modal-json-tab-btn').addEventListener('click', () => switchModalTab('json'));
$('modal-comments-tab-btn').addEventListener('click', () => switchModalTab('comments'));

// ============================================================ rating
async function loadRatingSection(id) {
  let summary = { avg: null, count: 0 };
  try { summary = await fetchRatingSummary(id); } catch (_) {}
  let current = 0;
  if (_user) { try { current = (await getUserRating(id)) || 0; } catch (_) {} }
  renderStars(summary, current, id);
}

function renderStars(summary, current, id) {
  const section = $('modal-rating-section');
  const avgInfo = summary.avg != null ? `Avg ${summary.avg.toFixed(1)} from ${summary.count} rating${summary.count > 1 ? 's' : ''}` : 'No ratings yet';
  if (!_user) {
    section.innerHTML = `<div class="rating-row"><span class="rating-info">${summary.avg != null ? '&#9733; ' : ''}${esc(avgInfo)}</span></div>
      <div class="text-muted" style="font-size:.8125rem">Sign in to rate this cycle.</div>`;
    return;
  }
  section.innerHTML = `<div class="rating-row">
      <div class="rating-stars" id="star-row" aria-label="Rate this cycle">
        ${[1, 2, 3, 4, 5].map((n) => `<button class="star${n <= current ? ' filled' : ''}" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">&#9733;</button>`).join('')}
      </div><span class="rating-info">${esc(avgInfo)}</span></div>
    ${current ? `<div class="text-muted" style="font-size:.75rem">Your rating: ${current}/5</div>` : ''}`;
  const stars = Array.from($('star-row').querySelectorAll('.star'));
  stars.forEach((btn) => {
    btn.addEventListener('mouseenter', () => { const n = +btn.dataset.n; stars.forEach((s) => s.classList.toggle('hov', +s.dataset.n <= n)); });
    btn.addEventListener('mouseleave', () => stars.forEach((s) => s.classList.remove('hov')));
    btn.addEventListener('click', async () => {
      const n = +btn.dataset.n;
      try {
        await submitRating(id, n); _ratingCache.delete(id); toast('Rating saved');
        let fresh = { avg: null, count: 0 }; try { fresh = await fetchRatingSummary(id); } catch (_) {}
        renderStars(fresh, n, id);
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

// ============================================================ comments
async function loadComments(id) {
  const list = $('modal-comments-list');
  list.innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try { const { items } = await listComments(id); renderComments(items, id); }
  catch (_) { list.innerHTML = `<div class="text-muted" style="font-size:.875rem">Could not load comments.</div>`; }
}

function renderComments(comments, id) {
  const list = $('modal-comments-list');
  list.innerHTML = '';
  if (!comments.length) { list.innerHTML = `<div class="text-muted" style="font-size:.875rem">No comments yet.</div>`; return; }
  const top = comments.filter((c) => !c.parentId);
  const byParent = {};
  comments.filter((c) => c.parentId).forEach((c) => { (byParent[c.parentId] = byParent[c.parentId] || []).push(c); });
  top.forEach((c) => { list.appendChild(buildCommentEl(c, false, id)); (byParent[c.id] || []).forEach((r) => list.appendChild(buildCommentEl(r, true, id))); });
}

function buildCommentEl(comment, isReply, id) {
  const el = document.createElement('div');
  el.className = `comment${isReply ? ' is-reply' : ''}`;
  const initial = (comment.authorName || 'A').charAt(0).toUpperCase();
  const canDelete = _user && (_adminFlag || _user.uid === comment.authorUid);
  el.innerHTML = `<div class="comment-avatar">${esc(initial)}</div>
    <div class="comment-body">
      <div class="comment-header"><span class="comment-author">${esc(comment.authorName || 'Anonymous')}</span><span class="comment-date">${formatDate(comment.createdAt)}</span></div>
      <div class="comment-text">${esc(comment.text)}</div>
      <div class="comment-actions">
        ${!isReply && _user ? `<button class="reply-btn" data-reply-id="${esc(comment.id)}">Reply</button>` : ''}
        ${canDelete ? `<button class="reply-btn danger" data-del-id="${esc(comment.id)}">Delete</button>` : ''}
      </div></div>`;
  const replyBtn = el.querySelector('[data-reply-id]');
  if (replyBtn) replyBtn.addEventListener('click', () => {
    _replyToId = comment.id;
    $('reply-indicator-text').textContent = `Replying to ${comment.authorName || 'Anonymous'}`;
    $('reply-indicator').removeAttribute('hidden'); $('cancel-reply-btn').removeAttribute('hidden');
    $('comment-input').focus(); switchModalTab('comments');
  });
  const delBtn = el.querySelector('[data-del-id]');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm('Delete this comment?')) return;
    try { await deleteComment(id, comment.id); toast('Comment deleted'); await loadComments(id); }
    catch (e) { toast(e.message, 'error'); }
  });
  return el;
}

function updateCommentFormAuth() {
  if (!$('details-modal') || $('details-modal').hasAttribute('hidden')) return;
  $('comment-auth-notice').toggleAttribute('hidden', !!_user);
  $('comment-input').toggleAttribute('hidden', !_user);
  $('comment-submit-row').toggleAttribute('hidden', !_user);
}

function cancelReply() {
  _replyToId = null;
  $('reply-indicator').setAttribute('hidden', ''); $('cancel-reply-btn').setAttribute('hidden', ''); $('reply-indicator-text').textContent = '';
}
$('cancel-reply-btn').addEventListener('click', cancelReply);

$('submit-comment-btn').addEventListener('click', async () => {
  if (!_user) { toast('Sign in to comment', 'error'); return; }
  const text = $('comment-input').value.trim();
  if (!text || !_openRecord) return;
  const btn = $('submit-comment-btn'); btn.disabled = true;
  try {
    await addComment(_openRecord.id, text, _replyToId || null);
    $('comment-input').value = ''; cancelReply(); toast('Comment posted'); await loadComments(_openRecord.id);
  } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
});

// ============================================================ init
switchTab('browse');
