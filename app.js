import firebaseConfig from './config.js';
import { MAINTENANCE } from './site-config.js';
import {
  init, onAuth, signIn, signOutUser, isAdmin, ensureUserProfile,
  listBrands, searchDevices, getDevicesByBrand, getProfiles, getReferenceCycles,
  bumpDownload, favoriteDevice, getFavorites,
  addComment, listComments, deleteComment,
  submitRating, getUserRating, getRatingSummary,
  saveAsFile, getSiteConfig,
} from './washstore.js';

init(firebaseConfig);

// ============================================================ state
let _user = null;
let _adminFlag = false;
let _view = 'brands';             // brands | brand | device | profile
let _brand = null;
let _device = null;
let _profile = null;
let _browseCursor = null;
let _browseFilters = { search: '', favoritesOnly: false };
let _favorites = new Set();
let _openRecord = null;
let _replyToId = null;
let _browseLoaded = false;

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

// ============================================================ maintenance gate
// site-config.js MAINTENANCE is the fallback; the live value comes from the
// admin-toggleable Firestore config/site doc (fetched below).
let _maintenance = MAINTENANCE;

function applyMaintenance() {
  if (!_maintenance) {
    $('maintenance-screen').hidden = true;
    $('app-shell').hidden = false;
    $('maint-banner').hidden = true;
    return;
  }
  if (_adminFlag) {
    $('maintenance-screen').hidden = true;
    $('app-shell').hidden = false;
    $('maint-banner').hidden = false;
  } else {
    $('maintenance-screen').hidden = false;
    $('app-shell').hidden = true;
  }
}

function browseVisible() { return !_maintenance || _adminFlag; }
function maybeLoadBrowse() { if (browseVisible() && !_browseLoaded) { _browseLoaded = true; loadBrands(true); } }

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
function modelOf(device) { return device.model || String(device.id || '').split('__')[2] || ''; }

function sparklineSVG(record, w = 160, h = 48) {
  let pts = record?.trace?.points;
  if (!Array.isArray(pts) || pts.length < 2) return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
  if (pts.length > 200) { const step = Math.ceil(pts.length / 200); pts = pts.filter((_, i) => i % step === 0); }
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const x0 = xs[0], xN = xs[xs.length - 1], yMax = Math.max(...ys) || 1; const pad = 3;
  const sx = (x) => pad + ((x - x0) / (xN - x0 || 1)) * (w - 2 * pad);
  const sy = (y) => h - pad - (y / yMax) * (h - 2 * pad);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" stroke="var(--accent)" stroke-width="1.5" fill="none" stroke-linejoin="round"/></svg>`;
}

// Rating summaries are fetched lazily only when the details modal opens (not per card),
// so a browse page is a single query instead of one aggregation query per cycle.
function fetchRatingSummary(id) {
  if (!_ratingCache.has(id)) _ratingCache.set(id, getRatingSummary(id));
  return _ratingCache.get(id);
}

function loadingPlaceholder() {
  const el = document.createElement('div');
  el.className = 'loading-center'; el.style.gridColumn = '1 / -1';
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
  if (user) {
    try { await ensureUserProfile(user); } catch (_) {}
    try { _adminFlag = await isAdmin(); } catch (_) {}
    try { _favorites = new Set(await getFavorites()); } catch (_) {}
  }
  $('admin-link').toggleAttribute('hidden', !_adminFlag);
  applyMaintenance();
  maybeLoadBrowse();
  updateCommentFormAuth();
});

// ============================================================ breadcrumb
function renderBreadcrumb() {
  const bc = $('breadcrumb');
  if (_view === 'brands') { bc.setAttribute('hidden', ''); return; }
  bc.removeAttribute('hidden');
  const parts = [`<button class="crumb" data-to="brands">Brands</button>`];
  if (_brand) parts.push(`<span class="crumb-sep">/</span><button class="crumb" data-to="brand">${esc(_brand.brand)}</button>`);
  if (_device && (_view === 'device' || _view === 'profile')) parts.push(`<span class="crumb-sep">/</span><button class="crumb" data-to="device">${esc(_device.brand)} ${esc(modelOf(_device))}</button>`);
  if (_view === 'profile' && _profile) parts.push(`<span class="crumb-sep">/</span><span class="crumb current">${esc(_profile.program)}</span>`);
  bc.innerHTML = parts.join('');
  bc.querySelectorAll('.crumb[data-to]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.to === 'brands') loadBrands(true);
    else if (b.dataset.to === 'brand') openBrand(_brand);
    else if (b.dataset.to === 'device') openDevice(_device);
  }));
}

// ============================================================ browse: brands
async function loadBrands(reset = false) {
  _view = 'brands'; _brand = null; _device = null; _profile = null;
  $('filter-rail').removeAttribute('hidden');
  renderBreadcrumb();
  const body = $('browse-body');
  const favoritesOnly = _browseFilters.favoritesOnly;
  if (reset) { _browseCursor = null; body.innerHTML = '<div class="card-grid" id="brand-grid"></div>'; $('load-more-btn').setAttribute('hidden', ''); }
  const grid = body.querySelector('.card-grid');
  const spinner = loadingPlaceholder();
  grid.appendChild(spinner);
  try {
    if (favoritesOnly) {
      if (!_user) { spinner.remove(); grid.innerHTML = emptyHTML('&#11088;', 'Sign in for favorites', 'Sign in to save and browse favorite devices.'); return; }
      const { items } = await searchDevices({ favoritesOnly: true, pageSize: 60 });
      spinner.remove();
      grid.innerHTML = '';
      if (items.length === 0) grid.innerHTML = emptyHTML('&#11088;', 'No favorites yet', 'Star a device to find it here quickly.');
      else items.forEach((d) => grid.appendChild(buildDeviceCard(d)));
      $('load-more-btn').setAttribute('hidden', '');
      return;
    }
    const { items, cursor } = await listBrands({ search: _browseFilters.search || null, pageSize: 60, cursor: _browseCursor });
    spinner.remove();
    if (items.length === 0 && !_browseCursor) grid.innerHTML = emptyHTML('&#128269;', 'No brands found', 'Try a different search. The library grows as people contribute.');
    else items.forEach((b) => grid.appendChild(buildBrandCard(b)));
    _browseCursor = cursor;
    $('load-more-btn').toggleAttribute('hidden', !cursor);
  } catch (e) {
    spinner.remove();
    const g = $('browse-body').querySelector('.card-grid') || $('browse-body');
    g.innerHTML = emptyHTML('&#9888;', 'Could not load the library', esc(e.message));
    toast(e.message, 'error');
  }
}

function buildBrandCard(b) {
  const el = document.createElement('div');
  el.className = 'card device-card';
  el.innerHTML = `
    <div class="card-body">
      <span class="eyebrow">Brand</span>
      <div class="card-title">${esc(b.brand)}</div>
      <div class="card-subtitle">Browse models &rsaquo;</div>
    </div>
    <div class="card-actions"><button class="btn btn-primary btn-sm" data-open>Open</button></div>`;
  el.querySelector('[data-open]').addEventListener('click', () => openBrand(b));
  return el;
}

// ============================================================ browse: brand -> devices
async function openBrand(b) {
  _brand = b; _device = null; _profile = null; _view = 'brand';
  $('filter-rail').setAttribute('hidden', '');
  $('load-more-btn').setAttribute('hidden', '');
  renderBreadcrumb();
  const body = $('browse-body');
  body.innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    const { items } = await getDevicesByBrand(b.brand_lc, { pageSize: 60 });
    if (items.length === 0) { body.innerHTML = emptyHTML('&#128203;', 'No models yet', 'No approved models for this brand yet.'); return; }
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    items.forEach((d) => grid.appendChild(buildDeviceCard(d)));
    body.innerHTML = '';
    body.appendChild(grid);
  } catch (e) { body.innerHTML = emptyHTML('&#9888;', 'Failed to load', esc(e.message)); }
}

function buildDeviceCard(d) {
  const el = document.createElement('div');
  el.className = 'card device-card';
  const starred = _favorites.has(d.id);
  el.innerHTML = `
    <div class="card-body">
      <span class="eyebrow">${esc(typeLabel(d.applianceType))}</span>
      <div class="card-title">${esc(d.brand)} ${esc(modelOf(d))}</div>
      <div class="card-badges">
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
    if (profiles.length === 0) { body.innerHTML = emptyHTML('&#128203;', 'No programs yet', 'No approved programs for this device yet.'); return; }
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
      <div class="card-subtitle mono-data">${formatDuration(st.duration)} &middot; ${st.energy_wh != null ? (st.energy_wh / 1000).toFixed(2) + ' kWh' : '-'}</div>
      <div class="card-meta"><span>by ${esc(c.uploaderName || 'Anonymous')}</span><span>&middot; ${c.downloads || 0} dl</span></div>
    </div>
    <div class="card-actions">
      <button class="btn btn-primary btn-sm" data-details>Details</button>
      <button class="btn btn-ghost btn-sm" data-dl>Download</button>
    </div>`;
  el.querySelector('[data-details]').addEventListener('click', () => openDetails(c));
  el.querySelector('[data-dl]').addEventListener('click', () => doDownload(c));
  return el;
}

async function doDownload(c) {
  try { await bumpDownload(c.id); saveAsFile(c); } catch (e) { toast(e.message, 'error'); }
}

$('filter-apply').addEventListener('click', () => {
  _browseFilters = { search: $('filter-brand').value.trim(), favoritesOnly: $('filter-favorites').checked };
  loadBrands(true);
});
$('filter-clear').addEventListener('click', () => {
  $('filter-brand').value = ''; $('filter-favorites').checked = false;
  _browseFilters = { search: '', favoritesOnly: false };
  loadBrands(true);
});
$('filter-brand').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('filter-apply').click(); });
$('load-more-btn').addEventListener('click', () => { if (_view === 'brands') loadBrands(false); });

// ============================================================ details modal
// Prefer the pretty brand/model from the device we navigated through; the deviceId
// only holds normalized tokens (lowercased, hyphenated), which read badly in the UI.
function prettyBrand(c) { return _device ? _device.brand : (String(c.deviceId || '').split('__')[1] || ''); }
function prettyModel(c) { return _device ? modelOf(_device) : (String(c.deviceId || '').split('__')[2] || ''); }

async function openDetails(c) {
  _openRecord = c; _replyToId = null;
  $('modal-title').textContent = `${prettyBrand(c)} ${prettyModel(c)}`.trim() || 'Reference cycle';
  $('modal-program').textContent = _profile ? _profile.program : (c.program_lc || '');
  $('modal-badges').innerHTML = `<span class="badge badge-type">${esc(typeLabel(c.applianceType))}</span>`;
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
  return `<div class="detail-grid">
    <div class="detail-item"><span class="detail-label">Brand</span><span class="detail-value">${esc(prettyBrand(c))}</span></div>
    <div class="detail-item"><span class="detail-label">Model</span><span class="detail-value">${esc(prettyModel(c))}</span></div>
    <div class="detail-item"><span class="detail-label">Program</span><span class="detail-value">${esc(_profile ? _profile.program : c.program_lc)}</span></div>
    <div class="detail-item"><span class="detail-label">Type</span><span class="detail-value">${esc(typeLabel(c.applianceType))}</span></div>
    <div class="detail-item"><span class="detail-label">Duration</span><span class="detail-value mono-data">${formatDuration(st.duration)}</span></div>
    <div class="detail-item"><span class="detail-label">Energy</span><span class="detail-value mono-data">${st.energy_wh != null ? (st.energy_wh / 1000).toFixed(3) + ' kWh' : '-'}</span></div>
    <div class="detail-item"><span class="detail-label">Peak</span><span class="detail-value mono-data">${st.peak_w != null ? st.peak_w + ' W' : '-'}</span></div>
    <div class="detail-item"><span class="detail-label">Interval</span><span class="detail-value mono-data">${c.trace && c.trace.sampleIntervalSec != null ? c.trace.sampleIntervalSec + 's' : '-'}</span></div>
    <div class="detail-item"><span class="detail-label">Uploader</span><span class="detail-value">${esc(c.uploaderName || 'Anonymous')}</span></div>
    <div class="detail-item"><span class="detail-label">Uploaded</span><span class="detail-value">${formatDate(c.createdAt)}</span></div>
    <div class="detail-item"><span class="detail-label">Downloads</span><span class="detail-value mono-data">${c.downloads || 0}</span></div>
    <div class="detail-item"><span class="detail-label">Schema v</span><span class="detail-value mono-data">${c.cycleSchemaVersion ?? '-'}</span></div>
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
    $('comment-input').focus();
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
// Paint from the fallback immediately, then reconcile with the live maintenance flag.
applyMaintenance();
maybeLoadBrowse();
getSiteConfig().then((cfg) => {
  if (typeof cfg.maintenance === 'boolean') _maintenance = cfg.maintenance;
  applyMaintenance();
  maybeLoadBrowse();
}).catch(() => {});
