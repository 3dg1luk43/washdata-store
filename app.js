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
import firebaseConfig, { GA_MEASUREMENT_ID } from './config.js';
import { MAINTENANCE } from './site-config.js';
import {
  init, onAuth, signIn, signOutUser, isAdmin, ensureUserProfile,
  listBrands, searchDevices, getDevicesByBrand, getProfiles, createProfile, getReferenceCycles,
  bumpDownload, favoriteDevice, getFavorites,
  addComment, listComments, deleteComment,
  submitRating, getUserRating, getRatingSummary,
  confirmDevice, rateDevice, getDeviceQuality, getUserDeviceRating, hasConfirmedDevice,
  confirmCycle, hasConfirmedCycle, countVisibleCycles, countVisibleProfiles,
  applianceLabel, confirmThresholdValue,
  saveAsFile, getSiteConfig,
  getUserDoc, subscribeUserStatus,
  logStoreEvent,
} from './washstore.js';
import { openSettingsEditor, openPhaseEditor, bindEditorCloseHandlers } from './editors.js';

init(firebaseConfig);
bindEditorCloseHandlers();

// Thin wrapper around window.gtag — silent no-op when GA is blocked or not configured.
function trackEvent(name, params = {}) {
  if (typeof window.gtag === 'function') {
    try { window.gtag('event', name, params); } catch (_) {}
  }
}

// Initialize GA4 by dynamically injecting the gtag script so the Measurement ID
// stays in one place (config.js). Page-view events fire automatically via
// gtag('config', ...). Custom store events are sent via trackEvent() / logStoreEvent().
if (GA_MEASUREMENT_ID) {
  const _gts = document.createElement('script');
  _gts.async = true;
  _gts.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_MEASUREMENT_ID)}`;
  document.head.appendChild(_gts);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', GA_MEASUREMENT_ID);
}

// ============================================================ state
let _user = null;
let _adminFlag = false;
let _view = 'brands';             // brands | brand | device | profile
let _brand = null;
let _device = null;
let _profile = null;
let _browseCursor = null;
let _browseFilters = { search: '', favoritesOnly: false, approvedOnly: false };
let _favorites = new Set();
let _confirmThreshold = 5;
let _openRecord = null;
let _replyToId = null;
let _browseLoaded = false;
let _userStatusUnsub = null;

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
// site-config.js MAINTENANCE is only the fallback; the live value comes from the
// admin-toggleable Firestore config/site doc (fetched fresh, never cached).
// A boot splash is shown until the state is resolved so nothing flashes.
let _maintenance = MAINTENANCE;
let _maintenanceKnown = false;
let _authKnown = false;

// Show exactly one of: boot | maint | shell.
function showOnly(which) {
  $('boot').hidden = which !== 'boot';
  $('maintenance-screen').hidden = which !== 'maint';
  $('app-shell').hidden = which !== 'shell';
  $('maint-banner').hidden = !(which === 'shell' && _maintenance);
}

function reconcile() {
  if (!_maintenanceKnown) { showOnly('boot'); return; }
  if (!_maintenance) { showOnly('shell'); maybeLoadBrowse(); return; }
  // Maintenance is on: we must know whether the viewer is an admin before revealing.
  if (!_authKnown) { showOnly('boot'); return; }
  if (_adminFlag) { showOnly('shell'); maybeLoadBrowse(); }
  else { showOnly('maint'); }
}

function browseVisible() { return _maintenanceKnown && (!_maintenance || _adminFlag); }
function maybeLoadBrowse() { if (browseVisible() && !_browseLoaded) { _browseLoaded = true; loadBrands(true); } }

// ============================================================ helpers
function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Defense-in-depth for hrefs: only allow absolute http(s) URLs. The write rules
// already enforce this on manualUrl, but the render layer must never trust stored
// data (a `javascript:`/`data:` href would execute despite esc()). Returns '' otherwise.
function safeUrl(u) {
  const s = String(u == null ? '' : u).trim();
  return /^https?:\/\//i.test(s) ? s : '';
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

// Simple interactive power graph for the cycle detail modal: hover/drag to read the
// power at any point in the cycle (vertical crosshair + dot + a time/watts readout).
function interactiveGraph(container, cycle) {
  const raw = cycle && cycle.trace && cycle.trace.points;
  if (!Array.isArray(raw) || raw.length < 2) { container.innerHTML = '<div class="text-muted" style="padding:1rem">No trace data.</div>'; return; }
  let pts = raw;
  if (pts.length > 600) { const step = Math.ceil(pts.length / 600); pts = pts.filter((_, i) => i % step === 0); }
  const W = 640, H = 170, pad = 8;
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const x0 = xs[0]; const xN = xs[xs.length - 1] || 1; const yMax = Math.max(...ys, 1);
  const sx = (x) => pad + ((x - x0) / ((xN - x0) || 1)) * (W - 2 * pad);
  const sy = (y) => H - pad - (y / yMax) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
  const area = `M${sx(x0).toFixed(1)},${(H - pad).toFixed(1)} ` + pts.map((p) => `L${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ') + ` L${sx(xN).toFixed(1)},${(H - pad).toFixed(1)} Z`;
  container.innerHTML = `<div class="cycle-graph">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="cycle-graph-svg">
      <path d="${area}" class="cg-area"/>
      <path d="${d}" class="cg-line"/>
      <line class="cg-cross" x1="0" x2="0" y1="${pad}" y2="${H - pad}" hidden/>
      <circle class="cg-dot" r="3.5" hidden/>
    </svg>
    <div class="cycle-graph-readout text-muted" data-readout>&#128072; Hover the graph to read power at any point</div>
  </div>`;
  const svg = container.querySelector('svg');
  const cross = svg.querySelector('.cg-cross');
  const dot = svg.querySelector('.cg-dot');
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

// Rating summaries are fetched lazily only when the details modal opens (not per card),
// so a browse page is a single query instead of one aggregation query per cycle.
function fetchRatingSummary(id) {
  if (!_ratingCache.has(id)) {
    // Cache the promise, but evict it on rejection so a transient failure does not
    // poison the cache and block the rating from ever loading for this cycle.
    _ratingCache.set(id, getRatingSummary(id).catch((e) => { _ratingCache.delete(id); throw e; }));
  }
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
function renderAuthArea(user, githubLogin) {
  const area = $('auth-status');
  if (user) {
    const name = user.displayName || githubLogin || 'User';
    area.innerHTML = `${user.photoURL ? `<img class="user-avatar" src="${esc(user.photoURL)}" alt="">` : ''}
      <span class="user-name">${esc(name)}</span>
      <button class="btn btn-ghost btn-sm" id="signout-btn">Sign out</button>`;
    $('signout-btn').addEventListener('click', async () => { try { await signOutUser(); } catch (e) { toast(e.message, 'error'); } });
  } else {
    area.innerHTML = `<button class="btn btn-primary btn-sm" id="signin-btn">Sign in with GitHub</button>`;
    $('signin-btn').addEventListener('click', doSignIn);
  }
}
async function doSignIn() { try { await signIn(); } catch (e) { toast(e.message, 'error'); } }

function showBannedMessage(reason) {
  const area = $('auth-status');
  if (area) area.innerHTML = `<span style="font-size:.8125rem;color:var(--error,#f44336);line-height:1.3">Account suspended${reason ? `<br><span style="font-size:.75rem;opacity:.85">${esc(reason)}</span>` : ''}</span>`;
}

onAuth(async (user) => {
  _user = user;
  _adminFlag = false;
  _favorites = new Set();
  // Clean up any previous status listener
  if (_userStatusUnsub) { _userStatusUnsub(); _userStatusUnsub = null; }
  renderAuthArea(user);
  if (user) {
    try { await ensureUserProfile(user); } catch (_) {}
    // Check ban status on login; also grab githubLogin for the name chip.
    try {
      const snap = await getUserDoc(user.uid);
      if (snap && snap.status === 'banned') {
        await signOutUser();
        showBannedMessage(snap.banReason);
        return;
      }
      if (snap && snap.githubLogin) renderAuthArea(user, snap.githubLogin);
    } catch (_) {}
    // Real-time listener: sign out immediately if banned by admin
    try {
      _userStatusUnsub = subscribeUserStatus(user.uid, (status, reason) => {
        if (status === 'banned') {
          signOutUser().catch(() => {});
          showBannedMessage(reason);
        }
      });
    } catch (_) {}
    try { _adminFlag = await isAdmin(); } catch (_) {}
    try { _favorites = new Set(await getFavorites()); } catch (_) {}
  }
  $('admin-link').toggleAttribute('hidden', !_adminFlag);
  _authKnown = true;
  reconcile();
  updateCommentFormAuth();
  // Re-render device community widgets that were built before this auth change.
  // Without this, cards rendered while signed-out keep showing "Sign in to confirm or rate."
  document.querySelectorAll('[data-community]').forEach((box) => {
    if (box._device) renderDeviceCommunity(box, box._device);
  });
});

function renderOwnerActions(actions) {
  const bar = $('owner-actions');
  if (!bar) return;
  if (!actions || actions.length === 0) { bar.setAttribute('hidden', ''); bar.innerHTML = ''; return; }
  bar.innerHTML = '';
  actions.forEach(({ label, handler }) => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm';
    btn.textContent = label;
    btn.addEventListener('click', handler);
    bar.appendChild(btn);
  });
  bar.removeAttribute('hidden');
}

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
  renderOwnerActions(null);
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
    const { items, cursor } = await listBrands({ search: _browseFilters.search || null, pageSize: 60, cursor: _browseCursor, includePending: !_browseFilters.approvedOnly });
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

// Awaiting-approval badge with the live confirm progress (pending only).
function statusBadge(rec) {
  if (!rec) return '';
  if (rec.status === 'pending') {
    // Only devices auto-promote via confirmations, so only they show the N/threshold
    // progress. Brands/profiles are admin-approved -> just "awaiting approval".
    const label = (typeof rec.confirmCount === 'number')
      ? `Awaiting approval &middot; ${rec.confirmCount}/${_confirmThreshold}`
      : 'Awaiting approval';
    return `<span class="badge badge-pending">${label}</span>`;
  }
  if (rec.status === 'approved') return `<span class="badge badge-approved">Approved</span>`;
  return '';
}
function addApplianceCTA(brand) {
  const q = brand ? `?brand=${encodeURIComponent(brand)}` : '';
  return `<div class="add-cta"><span class="text-muted">Can't find your appliance?</span> <a class="btn btn-ghost btn-sm" href="create.html${q}">Add it</a></div>`;
}

function buildBrandCard(b) {
  const el = document.createElement('div');
  el.className = 'card device-card';
  el.innerHTML = `
    <div class="card-body">
      <span class="eyebrow">Brand</span>
      <div class="card-title">${esc(b.brand)}</div>
      <div class="card-badges">${statusBadge(b)}</div>
      <div class="card-subtitle">Browse models &rsaquo;</div>
    </div>
    <div class="card-actions"><button class="btn btn-primary btn-sm" data-open>Open</button></div>`;
  el.querySelector('[data-open]').addEventListener('click', () => openBrand(b));
  return el;
}

// ============================================================ browse: brand -> devices
let _brandDevices = [];
let _brandTypeFilter = '';

async function openBrand(b) {
  trackEvent('store_brand_view', { brand: b.brand });
  logStoreEvent('brand_views');
  _brand = b; _device = null; _profile = null; _view = 'brand';
  _brandDevices = []; _brandTypeFilter = '';
  $('filter-rail').setAttribute('hidden', '');
  $('load-more-btn').setAttribute('hidden', '');
  renderBreadcrumb();
  renderOwnerActions(null);
  const body = $('browse-body');
  body.innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    const { items } = await getDevicesByBrand(b.brand_lc, { pageSize: 60, includePending: !_browseFilters.approvedOnly });
    _brandDevices = items;
    renderBrandDevices();
  } catch (e) { body.innerHTML = emptyHTML('&#9888;', 'Failed to load', esc(e.message)); }
}

// Render the brand's appliances with a device-type filter (client-side over the
// already-fetched list, so switching type is instant).
function renderBrandDevices() {
  const body = $('browse-body');
  if (_brandDevices.length === 0) {
    body.innerHTML = emptyHTML('&#128203;', 'No models yet', 'No models for this brand yet.') + addApplianceCTA(_brand.brand);
    return;
  }
  const types = [...new Set(_brandDevices.map((d) => d.applianceType).filter(Boolean))].sort();
  const typeOpts = [`<option value="">${esc('All types')}</option>`]
    .concat(types.map((t) => `<option value="${esc(t)}" ${_brandTypeFilter === t ? 'selected' : ''}>${esc(typeLabel(t))}</option>`))
    .join('');
  const filtered = _brandTypeFilter ? _brandDevices.filter((d) => d.applianceType === _brandTypeFilter) : _brandDevices;
  body.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'filter-rail';
  bar.innerHTML = `<div class="form-group"><label for="brand-type-filter">Appliance type</label>
    <select id="brand-type-filter">${typeOpts}</select></div>`;
  body.appendChild(bar);
  bar.querySelector('#brand-type-filter').addEventListener('change', (e) => { _brandTypeFilter = e.target.value; renderBrandDevices(); });
  const grid = document.createElement('div');
  grid.className = 'card-grid';
  filtered.forEach((d) => grid.appendChild(buildDeviceCard(d)));
  body.appendChild(grid);
  const cta = document.createElement('div');
  cta.innerHTML = addApplianceCTA(_brand.brand);
  body.appendChild(cta);
}

function buildDeviceCard(d) {
  const el = document.createElement('div');
  el.className = 'card device-card';
  const starred = _favorites.has(d.id);
  const manualHref = safeUrl(d.manualUrl);
  const manual = manualHref
    ? `<span><a class="card-manual" href="${esc(manualHref)}" target="_blank" rel="noopener noreferrer nofollow">Manual &#8599;</a></span>`
    : '';
  el.innerHTML = `
    <div class="card-body">
      <span class="eyebrow">${esc(typeLabel(d.applianceType))}</span>
      <div class="card-title">${esc(d.brand)} ${esc(modelOf(d))}</div>
      <div class="card-badges">
        ${statusBadge(d)}
        <span class="badge" data-pcount hidden></span>
      </div>
      <div class="card-meta"><span>&#11088; ${d.favoriteCount || 0}</span><span>by ${esc(d.createdByName || 'Anonymous')}</span>${manual}</div>
      <div class="card-community" data-community></div>
    </div>
    <div class="card-actions">
      <button class="btn btn-primary btn-sm" data-open>Open</button>
      <button class="btn btn-ghost btn-sm star-btn${starred ? ' on' : ''}" data-star aria-label="Toggle favorite">${starred ? '&#9733;' : '&#9734;'}</button>
    </div>`;
  el.querySelector('[data-open]').addEventListener('click', () => openDevice(d));
  el.querySelector('[data-star]').addEventListener('click', (ev) => toggleStar(ev.currentTarget, d));
  renderDeviceCommunity(el.querySelector('[data-community]'), d);
  // Profile count is calculated (approved + pending), not a stored total.
  countVisibleProfiles(d.id).then((n) => {
    const badge = el.querySelector('[data-pcount]');
    if (badge && n > 0) { badge.textContent = `${n} profile${n > 1 ? 's' : ''}`; badge.hidden = false; }
  }).catch(() => {});
  return el;
}

// Confirm ("I have this appliance / this entry is correct") + optional 5-star quality.
// Kept cheap: the quality aggregation is fetched only when the user opens the stars.
function renderDeviceCommunity(box, d) {
  if (!box) return;
  box._device = d; // stored so onAuth can re-render after sign-in
  if (!_user) {
    box.innerHTML = `<span class="text-muted" style="font-size:.75rem">Sign in to confirm or rate this appliance.</span>`;
    return;
  }
  box.innerHTML = `
    <button class="btn btn-ghost btn-sm" data-confirm>${d.status === 'pending' ? 'Confirm this appliance' : 'Confirm'}</button>
    <button class="btn btn-ghost btn-sm" data-rate>Rate quality</button><span class="text-muted" data-rate-summary style="font-size:.75rem"></span>
    <span class="community-msg text-muted" data-msg></span>
    <div class="device-stars" data-stars hidden></div>`;
  const confirmBtn = box.querySelector('[data-confirm]');
  confirmBtn.addEventListener('click', () => doConfirmDevice(box, d, confirmBtn));
  hasConfirmedDevice(d.id)
    .then((did) => { if (did) { confirmBtn.disabled = true; confirmBtn.textContent = 'You confirmed this'; } })
    .catch(() => {});
  box.querySelector('[data-rate]').addEventListener('click', () => toggleDeviceStars(box, d));
  // Pre-load the aggregate so users can see the current rating without clicking.
  getDeviceQuality(d.id).then((s) => {
    const el = box.querySelector('[data-rate-summary]');
    if (el && s.avg != null && s.count > 0) {
      el.textContent = `— ★ ${s.avg.toFixed(1)} (${s.count})`;
    }
  }).catch(() => {});
}

async function doConfirmDevice(box, d, btn) {
  btn.disabled = true;
  try {
    const res = await confirmDevice(d.id);
    d.confirmCount = res.confirmCount; d.status = res.status;
    btn.textContent = 'You confirmed this';
    trackEvent('store_device_confirm');
    logStoreEvent('device_confirms');
    const msg = box.querySelector('[data-msg]');
    if (msg) msg.textContent = res.status === 'approved' ? 'Approved by the community' : `${res.confirmCount}/${_confirmThreshold} confirmations`;
    const badges = box.closest('.card') ? box.closest('.card').querySelector('.card-badges') : null;
    if (badges) {
      const b = badges.querySelector('.badge-pending');
      if (res.status === 'approved') { if (b) b.remove(); }
      else if (b) b.innerHTML = `Awaiting approval &middot; ${res.confirmCount}/${_confirmThreshold}`;
    }
    toast('Thanks for confirming');
  } catch (e) { btn.disabled = false; toast(e.message, 'error'); }
}

async function toggleDeviceStars(box, d) {
  const wrap = box.querySelector('[data-stars]');
  if (!wrap.hasAttribute('hidden')) { wrap.setAttribute('hidden', ''); return; }
  wrap.removeAttribute('hidden');
  wrap.innerHTML = '<span class="text-muted" style="font-size:.75rem">Loading...</span>';
  let current = 0; let summary = { avg: null, count: 0 };
  try { current = (await getUserDeviceRating(d.id)) || 0; } catch (_) {}
  try { summary = await getDeviceQuality(d.id); } catch (_) {}
  // Guard: user may have clicked again while awaiting, hiding the panel.
  if (!wrap.hasAttribute('hidden')) renderDeviceStars(wrap, d, current, summary);
}

function renderDeviceStars(wrap, d, current, summary) {
  const avgInfo = summary.avg != null ? `Avg ${summary.avg.toFixed(1)} (${summary.count})` : 'No ratings yet';
  wrap.innerHTML = `<div class="rating-stars">${[1, 2, 3, 4, 5].map((n) => `<button class="star${n <= current ? ' filled' : ''}" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">&#9733;</button>`).join('')}</div><span class="rating-info">${esc(avgInfo)}</span>`;
  wrap.querySelectorAll('.star').forEach((btn) => btn.addEventListener('click', async () => {
    const n = +btn.dataset.n;
    try {
      await rateDevice(d.id, n);
      toast('Quality rating saved');
      trackEvent('store_device_rate', { rating: n });
      logStoreEvent('device_ratings');
      let fresh = { avg: null, count: 0 };
      try { fresh = await getDeviceQuality(d.id); } catch (_) {}
      renderDeviceStars(wrap, d, n, fresh);
    } catch (e) { toast(e.message, 'error'); }
  }));
}

async function toggleStar(btn, d) {
  if (!_user) { toast('Sign in to save favorites', 'error'); return; }
  const on = !_favorites.has(d.id);
  try {
    await favoriteDevice(d.id, on);
    if (on) {
      _favorites.add(d.id);
      trackEvent('store_device_favorite');
      logStoreEvent('favorites');
    } else {
      _favorites.delete(d.id);
    }
    btn.classList.toggle('on', on);
    btn.innerHTML = on ? '&#9733;' : '&#9734;';
  } catch (e) { toast(e.message, 'error'); }
}

// ============================================================ browse: device -> profiles
async function openDevice(d) {
  trackEvent('store_device_view', { appliance_type: d.applianceType, brand: d.brand });
  logStoreEvent('device_views');
  _device = d; _profile = null; _view = 'device';
  $('filter-rail').setAttribute('hidden', '');
  $('load-more-btn').setAttribute('hidden', '');
  renderBreadcrumb();
  renderOwnerActions(_user && d.ownerId && d.ownerId === _user.uid
    ? [{ label: 'Edit settings', handler: () => openSettingsEditor(d) }]
    : null);
  const body = $('browse-body');
  body.innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    const profiles = await getProfiles(d.id, { includePending: !_browseFilters.approvedOnly });
    body.innerHTML = '';
    // Device header card
    const header = document.createElement('div');
    header.className = 'device-header-card';
    const manualHeaderHref = safeUrl(d.manualUrl);
    const manualLink = manualHeaderHref ? `<a class="device-header-link" href="${esc(manualHeaderHref)}" target="_blank" rel="noopener noreferrer">Manual / product page &rarr;</a>` : '';
    const ownerNote = d.ownerId ? `<span class="device-header-owner">&#128274; Community-curated</span>` : '';
    header.innerHTML = `
      <div class="device-header-meta">
        <span class="badge badge-type">${esc(typeLabel(d.applianceType))}</span>
        ${statusBadge(d)}
        ${ownerNote}
      </div>
      <h2 class="device-header-title">${esc(d.brand)} <span class="device-header-model">${esc(modelOf(d))}</span></h2>
      <div class="device-header-stats">
        <span>&#11088; ${d.favoriteCount || 0} saves</span>
        <span>&middot;</span>
        <span>&#10003; ${d.confirmCount || 0} confirmations</span>
        <span>&middot;</span>
        <span>${profiles.length} profile${profiles.length === 1 ? '' : 's'}</span>
        <span>&middot;</span>
        <span data-totalcycles>&hellip;</span>
      </div>
      ${manualLink}`;
    body.appendChild(header);
    // Cycle count is calculated per-profile; fill in asynchronously.
    if (profiles.length > 0) {
      Promise.all(profiles.map((p) => countVisibleCycles(p.id))).then((counts) => {
        const total = counts.reduce((a, b) => a + b, 0);
        const el = header.querySelector('[data-totalcycles]');
        if (el) el.textContent = `${total} reference cycle${total === 1 ? '' : 's'}`;
      }).catch(() => {
        const el = header.querySelector('[data-totalcycles]');
        if (el) el.textContent = '';
      });
    } else {
      const el = header.querySelector('[data-totalcycles]');
      if (el) el.textContent = '0 reference cycles';
    }
    if (profiles.length === 0) {
      body.insertAdjacentHTML('beforeend', emptyHTML('&#128203;', 'No profiles yet', 'No profiles for this appliance yet.'));
    } else {
      const list = document.createElement('div');
      list.className = 'profile-list';
      profiles.forEach((p) => list.appendChild(buildProfileRow(p)));
      body.appendChild(list);
    }
    body.appendChild(buildAddProfile(d));
  } catch (e) { body.innerHTML = emptyHTML('&#9888;', 'Failed to load', esc(e.message)); }
}

function buildProfileRow(p) {
  const el = document.createElement('button');
  el.className = 'profile-row';
  el.innerHTML = `<span class="profile-name">${esc(p.program)}${statusBadge(p)}</span>
    <span class="profile-meta" data-count>&hellip; &rsaquo;</span>`;
  el.addEventListener('click', () => openProfile(p));
  // Count is calculated (approved + pending), not a stored total; fill in on arrival.
  countVisibleCycles(p.id).then((n) => {
    const meta = el.querySelector('[data-count]');
    if (meta) meta.innerHTML = `${n} cycle${n === 1 ? '' : 's'} &rsaquo;`;
  }).catch(() => {
    const meta = el.querySelector('[data-count]');
    if (meta) meta.innerHTML = '&rsaquo;';
  });
  return el;
}

// "Can't see your profile? Add it" inline creator, shown under a device's profiles.
function buildAddProfile(d) {
  const wrap = document.createElement('div');
  wrap.className = 'add-cta add-profile';
  if (!_user) {
    wrap.innerHTML = `<span class="text-muted">Can't see your profile?</span> <span class="text-muted" style="font-size:.8125rem">Sign in to add one.</span>`;
    return wrap;
  }
  wrap.innerHTML = `<span class="text-muted">Can't see your profile?</span>
    <input type="text" id="add-profile-name" maxlength="60" placeholder="e.g. Cotton 40" autocomplete="off" style="max-width:220px">
    <button class="btn btn-primary btn-sm" id="add-profile-btn">Add profile</button>`;
  const input = wrap.querySelector('#add-profile-name');
  const btn = wrap.querySelector('#add-profile-btn');
  const submit = async () => {
    const program = input.value.trim();
    if (!program) { input.focus(); return; }
    btn.disabled = true;
    try {
      await createProfile({ deviceId: d.id, program });
      toast('Profile added - awaiting approval');
      openDevice(d);   // refresh so the new pending profile shows with its tag
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  return wrap;
}

// ============================================================ browse: profile -> reference cycles
async function openProfile(p) {
  trackEvent('store_profile_view', { program: p.program });
  logStoreEvent('profile_views');
  _profile = p; _view = 'profile';
  renderBreadcrumb();
  renderOwnerActions(_user && _device && _device.ownerId && _device.ownerId === _user.uid
    ? [{ label: 'Edit phases', handler: () => openPhaseEditor(p) }]
    : null);
  const body = $('browse-body');
  body.innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    const { items } = await getReferenceCycles(p.id, { includePending: !_browseFilters.approvedOnly });
    if (items.length === 0) { body.innerHTML = emptyHTML('&#128200;', 'No reference cycles', 'No reference cycles for this profile yet. Upload one from the ha_washdata integration.'); return; }
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
  const badge = statusBadge(c);
  el.innerHTML = `
    <div class="card-sparkline">${sparklineSVG(c, 160, 48)}</div>
    <div class="card-body">
      <div class="card-title">${esc(_profile ? _profile.program : c.program_lc)}</div>
      ${badge ? `<div class="card-badges">${badge}</div>` : ''}
      <div class="card-subtitle mono-data">${formatDuration(st.duration)} &middot; ${st.energy_wh != null ? (st.energy_wh / 1000).toFixed(2) + ' kWh' : '-'}</div>
      <div class="card-meta">
        <span>by ${esc(c.uploaderName || 'Anonymous')}</span>
        <span>&middot; ${c.downloads || 0} dl</span>
        <span data-crating hidden>&middot; &#9733; <span></span></span>
      </div>
      <div class="card-community" data-community></div>
    </div>
    <div class="card-actions">
      <button class="btn btn-primary btn-sm" data-details>Details</button>
      <button class="btn btn-ghost btn-sm" data-dl>Download</button>
    </div>`;
  el.querySelector('[data-details]').addEventListener('click', () => openDetails(c));
  el.querySelector('[data-dl]').addEventListener('click', () => doDownload(c));
  renderCycleCommunity(el.querySelector('[data-community]'), c);
  // Lazy-load aggregate rating — shares the session Promise cache with the detail modal.
  fetchRatingSummary(c.id).then((s) => {
    if (s.avg != null && s.count > 0) {
      const badge2 = el.querySelector('[data-crating]');
      if (badge2) { badge2.querySelector('span').textContent = `${s.avg.toFixed(1)} (${s.count})`; badge2.hidden = false; }
    }
  }).catch(() => {});
  return el;
}

// Confirm ("I have this appliance and this cycle looks right") for pending cycles,
// mirroring the device confirm flow. Approved cycles show nothing here.
function renderCycleCommunity(box, c) {
  if (!box || c.status !== 'pending') return;
  if (!_user) {
    box.innerHTML = `<span class="text-muted" style="font-size:.75rem">Sign in to confirm this cycle.</span>`;
    return;
  }
  box.innerHTML = `<button class="btn btn-ghost btn-sm" data-confirm>Confirm this cycle</button><span class="community-msg text-muted" data-msg></span>`;
  const btn = box.querySelector('[data-confirm]');
  hasConfirmedCycle(c.id).then((did) => { if (did) { btn.disabled = true; btn.textContent = 'You confirmed this'; } }).catch(() => {});
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await confirmCycle(c.id);
      c.confirmCount = res.confirmCount; c.status = res.status;
      btn.textContent = 'You confirmed this';
      const badges = box.closest('.card') ? box.closest('.card').querySelector('.badge-pending') : null;
      const msg = box.querySelector('[data-msg]');
      if (res.status === 'approved') { if (badges) badges.remove(); if (msg) msg.textContent = 'Approved by the community'; }
      else {
        // Still pending: keep the pill's count in sync with the message.
        if (badges) badges.textContent = `Awaiting approval · ${res.confirmCount}/${_confirmThreshold}`;
        if (msg) msg.textContent = `${res.confirmCount}/${_confirmThreshold} confirmations`;
      }
      toast('Thanks for confirming');
    } catch (e) { btn.disabled = false; toast(e.message, 'error'); }
  });
}

async function doDownload(c) {
  trackEvent('store_cycle_download', { appliance_type: c.applianceType });
  logStoreEvent('downloads');
  try { await bumpDownload(c.id); saveAsFile(c); } catch (e) { toast(e.message, 'error'); }
}

function _applyFilters() {
  _browseFilters = {
    search: $('filter-brand').value.trim(),
    favoritesOnly: $('filter-favorites').checked,
    approvedOnly: $('filter-approved') ? $('filter-approved').checked : false,
  };
  if (_browseFilters.search) {
    trackEvent('store_search', { query_length: _browseFilters.search.length });
    logStoreEvent('searches');
  }
  loadBrands(true);
}
let _filterTimer = null;
$('filter-brand').addEventListener('input', () => { clearTimeout(_filterTimer); _filterTimer = setTimeout(_applyFilters, 350); });
$('filter-favorites').addEventListener('change', _applyFilters);
if ($('filter-approved')) $('filter-approved').addEventListener('change', _applyFilters);
$('filter-apply').addEventListener('click', _applyFilters);
$('filter-clear').addEventListener('click', () => {
  $('filter-brand').value = ''; $('filter-favorites').checked = false;
  if ($('filter-approved')) $('filter-approved').checked = false;
  _browseFilters = { search: '', favoritesOnly: false, approvedOnly: false };
  loadBrands(true);
});
$('load-more-btn').addEventListener('click', () => { if (_view === 'brands') loadBrands(false); });

// ============================================================ details modal
// Prefer the pretty brand/model from the device we navigated through; the deviceId
// only holds normalized tokens (lowercased, hyphenated), which read badly in the UI.
function prettyBrand(c) { return _device ? _device.brand : (String(c.deviceId || '').split('__')[1] || ''); }
function prettyModel(c) { return _device ? modelOf(_device) : (String(c.deviceId || '').split('__')[2] || ''); }

async function openDetails(c) {
  trackEvent('store_cycle_detail', { appliance_type: c.applianceType });
  logStoreEvent('cycle_details');
  _ratingCache.delete(c.id); // always fetch fresh aggregate when modal opens
  _openRecord = c; _replyToId = null;
  $('modal-title').textContent = `${prettyBrand(c)} ${prettyModel(c)}`.trim() || 'Reference cycle';
  $('modal-program').textContent = _profile ? _profile.program : (c.program_lc || '');
  $('modal-badges').innerHTML = `<span class="badge badge-type">${esc(typeLabel(c.applianceType))}</span>`;
  interactiveGraph($('modal-sparkline'), c);
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
    <div class="detail-item"><span class="detail-label">Profile</span><span class="detail-value">${esc(_profile ? _profile.program : c.program_lc)}</span></div>
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
        trackEvent('store_cycle_rate', { rating: n });
        logStoreEvent('cycle_ratings');
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
// Show the boot splash until the live maintenance flag is known (and, if on, whether
// the viewer is an admin). Never paints the homepage or maintenance screen prematurely.
reconcile();
confirmThresholdValue().then((v) => { _confirmThreshold = v; }).catch(() => {});
getSiteConfig().then((cfg) => {
  _maintenance = ('maintenance' in cfg) ? !!cfg.maintenance : MAINTENANCE;
}).catch(() => {}).finally(() => {
  _maintenanceKnown = true;
  reconcile();
});
