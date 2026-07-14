// Contribute page: add an appliance (device) or a brand to the community catalog.
// New entries are created pending; they show "awaiting approval" until enough people
// confirm them. Can be opened standalone or as a popup from the ha_washdata panel
// (?type=&brand=&model=&origin=), in which case it posts the created deviceId back.
import firebaseConfig from './config.js';
import { MAINTENANCE } from './site-config.js';
import {
  init, onAuth, signIn, signOutUser, isAdmin, ensureUserProfile,
  createDevice, createBrand, listBrands, applianceLabel, confirmThresholdValue,
  getSiteConfig,
} from './washstore.js';

init(firebaseConfig);

const params = new URLSearchParams(location.search);
const PREFILL = {
  type: params.get('type') || '',
  brand: params.get('brand') || '',
  model: params.get('model') || '',
};
const OPENER_ORIGIN = params.get('origin') || '';

function isAllowedOrigin(origin) {
  try { const u = new URL(origin); return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.host; }
  catch { return false; }
}
const CAN_POST_BACK = !!(window.opener && isAllowedOrigin(OPENER_ORIGIN));

// ---------------------------------------------------------------- dom + toast
function $(id) { return document.getElementById(id); }
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ---------------------------------------------------------------- maintenance gate
let _maintenance = MAINTENANCE;
let _maintenanceKnown = false;
let _authKnown = false;
let _user = null;
let _adminFlag = false;

function showOnly(which) {
  $('boot').hidden = which !== 'boot';
  $('maintenance-screen').hidden = which !== 'maint';
  $('app-shell').hidden = which !== 'shell';
  $('maint-banner').hidden = !(which === 'shell' && _maintenance);
}
function reconcile() {
  if (!_maintenanceKnown) { showOnly('boot'); return; }
  if (!_maintenance) { showOnly('shell'); revealForm(); return; }
  if (!_authKnown) { showOnly('boot'); return; }
  if (_adminFlag) { showOnly('shell'); revealForm(); }
  else { showOnly('maint'); }
}

function revealForm() {
  const signedIn = !!_user;
  $('signin-gate').toggleAttribute('hidden', signedIn);
  $('contribute-body').toggleAttribute('hidden', !signedIn);
  if (signedIn && !_brandsLoaded) { _brandsLoaded = true; loadBrandOptions(); }
}

// ---------------------------------------------------------------- auth
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
$('gate-signin-btn').addEventListener('click', doSignIn);

onAuth(async (user) => {
  _user = user;
  _adminFlag = false;
  renderAuthArea(user);
  if (user) {
    try { await ensureUserProfile(user); } catch (_) {}
    try { _adminFlag = await isAdmin(); } catch (_) {}
  }
  _authKnown = true;
  reconcile();
});

// ---------------------------------------------------------------- brand autocomplete
let _brandsLoaded = false;
async function loadBrandOptions() {
  try {
    const { items } = await listBrands({ pageSize: 200, includePending: true });
    const dl = $('brand-list');
    dl.innerHTML = items.map((b) => `<option value="${esc(b.brand)}"></option>`).join('');
  } catch (_) { /* autocomplete is best-effort */ }
}

// ---------------------------------------------------------------- tabs + prefill
function switchTab(name) {
  document.querySelectorAll('[data-ctab]').forEach((b) => b.classList.toggle('active', b.dataset.ctab === name));
  document.querySelectorAll('[data-cpanel]').forEach((p) => p.toggleAttribute('hidden', p.dataset.cpanel !== name));
}
document.querySelectorAll('[data-ctab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.ctab)));

if (['washer', 'dryer', 'dishwasher', 'washer_dryer'].includes(PREFILL.type)) $('dev-type').value = PREFILL.type;
if (PREFILL.brand) $('dev-brand').value = PREFILL.brand;
if (PREFILL.model) $('dev-model').value = PREFILL.model;

// ---------------------------------------------------------------- submit: device
$('device-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!_user) { toast('Sign in to contribute', 'error'); return; }
  const applianceType = $('dev-type').value;
  const brand = $('dev-brand').value.trim();
  const model = $('dev-model').value.trim();
  const manualUrl = $('dev-manual').value.trim();
  const showName = $('dev-consent').checked;
  const btn = $('dev-submit'); btn.disabled = true;
  try {
    const devId = await createDevice({ applianceType, brand, model, manualUrl, showName });
    toast('Appliance added - awaiting approval');
    await showResult({ kind: 'device', deviceId: devId, applianceType, brand, model });
    if (CAN_POST_BACK) {
      window.opener.postMessage(
        { type: 'washdata-device-created', deviceId: devId, applianceType, brand, model, status: 'pending' },
        OPENER_ORIGIN,
      );
    }
  } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
});

// ---------------------------------------------------------------- submit: brand
$('brand-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!_user) { toast('Sign in to contribute', 'error'); return; }
  const brand = $('brand-name').value.trim();
  const showName = $('brand-consent').checked;
  const btn = $('brand-submit'); btn.disabled = true;
  try {
    await createBrand({ brand, showName });
    toast('Brand added - awaiting approval');
    await showResult({ kind: 'brand', brand });
    // Refresh the appliance-form autocomplete so the new brand is pickable.
    _brandsLoaded = false; loadBrandOptions();
  } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
});

async function showResult(res) {
  const box = $('create-result');
  let threshold = 5;
  try { threshold = await confirmThresholdValue(); } catch (_) {}
  const title = res.kind === 'device'
    ? `${esc(res.brand)} ${esc(res.model)} added`
    : `${esc(res.brand)} added`;
  const sub = res.kind === 'device'
    ? `${esc(applianceLabel(res.applianceType))} &middot; awaiting approval (0 of ${threshold} confirmations)`
    : 'Brand awaiting approval';
  const backHint = CAN_POST_BACK
    ? `<div class="text-muted" style="font-size:.8125rem;margin-top:.5rem">You can return to Home Assistant - it will be selected automatically.</div>
       <div class="btn-row"><button class="btn btn-primary btn-sm" id="result-close">Close this window</button></div>`
    : `<div class="btn-row"><a class="btn btn-ghost btn-sm" href="index.html">Back to browse</a></div>`;
  box.innerHTML = `<div class="result-title">${title}</div>
    <div class="text-muted" style="font-size:.875rem">${sub}</div>
    <div class="text-muted" style="font-size:.8125rem;margin-top:.5rem">It is already visible and searchable with an "awaiting approval" tag. It becomes approved once ${threshold} signed-in users confirm it.</div>
    ${backHint}`;
  box.removeAttribute('hidden');
  const closeBtn = $('result-close');
  if (closeBtn) closeBtn.addEventListener('click', () => window.close());
}

// ---------------------------------------------------------------- init
reconcile();
getSiteConfig().then((cfg) => {
  _maintenance = ('maintenance' in cfg) ? !!cfg.maintenance : MAINTENANCE;
}).catch(() => {}).finally(() => {
  _maintenanceKnown = true;
  reconcile();
});
