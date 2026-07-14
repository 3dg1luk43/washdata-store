import firebaseConfig from './config.js';
import {
  init, onAuth, signIn, signOutUser, isAdmin, ensureUserProfile,
  deleteEnvelope,
  adminListEnvelopes, adminUpdateStatus, adminListUsers, adminBanUser, adminUnbanUser,
  adminGetStats,
} from './washstore.js';

init(firebaseConfig);

// ============================================================
// Module state
// ============================================================
let _adminUser = null;
let _isAdmin = false;
let _reviewCursor = null;
let _envCursor = null;
let _userCursor = null;
let _envFilters = { status: '', applianceType: '' };
let _reviewRecord = null;

// ============================================================
// DOM shorthand
// ============================================================
function $(id) { return document.getElementById(id); }

// ============================================================
// Toast
// ============================================================
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ============================================================
// Helpers
// ============================================================
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  const map = { washer: 'Washer', dryer: 'Dryer', dishwasher: 'Dishwasher', washer_dryer: 'Washer-Dryer' };
  return map[t] || t;
}

function sparklineSVG(record, w = 80, h = 36) {
  let pts;
  if (record.cycle?.points?.length > 1) {
    pts = record.cycle.points;
  } else if (record.envelope?.avg?.length > 1) {
    const avg = record.envelope.avg;
    const dur = record.envelope.target_duration || avg.length;
    pts = avg.map((v, i) => [i * dur / (avg.length - 1), v]);
  } else {
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
  }
  if (pts.length > 200) {
    const step = Math.ceil(pts.length / 200);
    pts = pts.filter((_, i) => i % step === 0);
  }
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  const x0 = xs[0], xN = xs[xs.length - 1], yMax = Math.max(...ys) || 1;
  const pad = 2;
  const sx = x => pad + ((x - x0) / (xN - x0 || 1)) * (w - 2 * pad);
  const sy = y => h - pad - (y / yMax) * (h - 2 * pad);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <path d="${d}" stroke="var(--accent)" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
  </svg>`;
}

function truncate(str, max = 8) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

// ============================================================
// Auth
// ============================================================
function renderAuthArea(user) {
  const area = $('auth-status');
  if (user) {
    area.innerHTML = `
      ${user.photoURL ? `<img class="user-avatar" src="${esc(user.photoURL)}" alt="">` : ''}
      <span class="user-name">${esc(user.displayName || 'User')}</span>
      <button class="btn btn-ghost btn-sm" id="signout-btn">Sign out</button>
    `;
    $('signout-btn').addEventListener('click', async () => {
      try { await signOutUser(); } catch (e) { toast(e.message, 'error'); }
    });
  } else {
    area.innerHTML = `<button class="btn btn-primary btn-sm" id="signin-btn">Sign in with GitHub</button>`;
    $('signin-btn').addEventListener('click', async () => {
      try { await signIn(); } catch (e) { toast(e.message, 'error'); }
    });
  }
}

onAuth(async (user) => {
  _adminUser = user;
  renderAuthArea(user);

  // Hide gate spinner
  $('admin-gate').setAttribute('hidden', '');

  if (!user) {
    $('denied-title').textContent = 'Sign in Required';
    $('denied-text').textContent = 'Please sign in with an admin GitHub account to access this panel.';
    $('admin-signin-btn').removeAttribute('hidden');
    $('admin-signin-btn').addEventListener('click', async () => {
      try { await signIn(); } catch (e) { toast(e.message, 'error'); }
    });
    $('admin-denied').removeAttribute('hidden');
    $('admin-panel').setAttribute('hidden', '');
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
    $('admin-denied').removeAttribute('hidden');
    $('admin-panel').setAttribute('hidden', '');
    return;
  }

  $('admin-denied').setAttribute('hidden', '');
  $('admin-panel').removeAttribute('hidden');
  loadOverview();
});

// ============================================================
// Tab routing
// ============================================================
const ADMIN_TABS = ['overview', 'review', 'envelopes', 'users'];

function switchAdminTab(name) {
  ADMIN_TABS.forEach(t => {
    $(`${t}-tab`).toggleAttribute('hidden', t !== name);
    $(`${t}-btn`).classList.toggle('active', t === name);
    $(`${t}-btn`).setAttribute('aria-selected', t === name ? 'true' : 'false');
  });
}

ADMIN_TABS.forEach(name => {
  $(`${name}-btn`).addEventListener('click', () => {
    switchAdminTab(name);
    if (name === 'review' && !$('review-list').hasChildNodes()) loadReviewQueue(true);
    if (name === 'envelopes' && !$('envelopes-tbody').querySelector('tr td[data-env]')) loadEnvelopesTable(true);
    if (name === 'users' && !$('users-tbody').querySelector('tr td[data-uid]')) loadUsersTable(true);
  });
});

// ============================================================
// Overview
// ============================================================
async function loadOverview() {
  $('stats-grid').innerHTML = '<div class="loading-center" style="grid-column:1/-1"><div class="loading-spinner"></div></div>';
  try {
    const stats = await adminGetStats();
    $('stats-grid').innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Pending Review</div>
        <div class="stat-value c-pending">${stats.pending}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Approved</div>
        <div class="stat-value c-approved">${stats.approved}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Rejected</div>
        <div class="stat-value c-rejected">${stats.rejected}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Removed</div>
        <div class="stat-value c-removed">${stats.removed}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Banned Users</div>
        <div class="stat-value c-ban">${stats.bannedUsers}</div>
      </div>
    `;
  } catch (e) {
    $('stats-grid').innerHTML = `<div class="text-muted" style="grid-column:1/-1;padding:1rem">${esc(e.message)}</div>`;
    toast(e.message, 'error');
  }
}

$('stats-refresh-btn').addEventListener('click', () => loadOverview());

// ============================================================
// Review Queue
// ============================================================
async function loadReviewQueue(reset = false) {
  if (reset) {
    _reviewCursor = null;
    $('review-list').innerHTML = '';
    $('review-load-more').setAttribute('hidden', '');
  }

  const spinner = document.createElement('div');
  spinner.className = 'loading-center';
  spinner.innerHTML = '<div class="loading-spinner"></div>';
  $('review-list').appendChild(spinner);

  try {
    const result = await adminListEnvelopes({ status: 'pending', pageSize: 12, cursor: _reviewCursor });
    spinner.remove();

    if (result.items.length === 0 && !_reviewCursor) {
      $('review-list').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">&#9989;</div>
          <div class="empty-title">Queue is clear</div>
          <div class="empty-text">No envelopes pending review.</div>
        </div>`;
    } else {
      result.items.forEach(rec => $('review-list').appendChild(buildReviewCard(rec)));
    }

    _reviewCursor = result.cursor;
    $('review-load-more').toggleAttribute('hidden', !result.cursor);
  } catch (e) {
    spinner.remove();
    toast(e.message, 'error');
  }
}

function buildReviewCard(rec) {
  const el = document.createElement('div');
  el.className = 'review-card';
  el.id = `review-card-${rec.id}`;
  el.innerHTML = `
    <div class="review-card-spark">${sparklineSVG(rec, 100, 60)}</div>
    <div class="review-card-body">
      <div class="review-card-title">${esc(rec.brand)} ${esc(rec.model)}</div>
      <div class="text-muted" style="font-size:.8125rem">${esc(rec.program)}</div>
      <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.25rem">
        <span class="badge badge-type">${esc(typeLabel(rec.applianceType))}</span>
        <span class="badge badge-pending">Pending</span>
      </div>
      <div class="text-muted" style="font-size:.75rem;margin-top:.3rem">
        by ${esc(rec.uploaderName || 'Anonymous')} &middot; ${formatDate(rec.createdAt)}
      </div>
    </div>
    <div class="review-card-actions">
      <button class="btn btn-primary btn-sm">Approve</button>
      <button class="btn btn-danger btn-sm">Reject</button>
      <button class="btn btn-ghost btn-sm">View</button>
    </div>
  `;

  const [approveBtn, rejectBtn, viewBtn] = el.querySelectorAll('.review-card-actions .btn');

  approveBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    try {
      await adminUpdateStatus(rec.id, 'approved');
      el.remove();
      toast(`Approved: ${rec.brand} ${rec.model}`);
      if (!$('review-list').hasChildNodes()) {
        $('review-list').innerHTML = `<div class="empty-state">
          <div class="empty-icon">&#9989;</div>
          <div class="empty-title">Queue is clear</div>
          <div class="empty-text">No envelopes pending review.</div>
        </div>`;
      }
    } catch (e) {
      approveBtn.disabled = false;
      toast(e.message, 'error');
    }
  });

  rejectBtn.addEventListener('click', async () => {
    const reason = prompt('Rejection reason (shown to uploader):');
    if (reason === null) return;
    rejectBtn.disabled = true;
    try {
      await adminUpdateStatus(rec.id, 'rejected', reason || '');
      el.remove();
      toast('Rejected');
      if (!$('review-list').hasChildNodes()) {
        $('review-list').innerHTML = `<div class="empty-state">
          <div class="empty-icon">&#9989;</div>
          <div class="empty-title">Queue is clear</div>
          <div class="empty-text">No envelopes pending review.</div>
        </div>`;
      }
    } catch (e) {
      rejectBtn.disabled = false;
      toast(e.message, 'error');
    }
  });

  viewBtn.addEventListener('click', () => openReviewModal(rec));

  return el;
}

$('review-load-more').addEventListener('click', () => loadReviewQueue(false));

// ============================================================
// All Envelopes table
// ============================================================
async function loadEnvelopesTable(reset = false) {
  if (reset) {
    _envCursor = null;
    $('envelopes-load-more').setAttribute('hidden', '');
  }

  const tbody = $('envelopes-tbody');
  if (reset) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:1.5rem;color:var(--text-muted)">Loading...</td></tr>`;
  }

  try {
    const result = await adminListEnvelopes({
      status: _envFilters.status || null,
      applianceType: _envFilters.applianceType || null,
      pageSize: 25,
      cursor: _envCursor,
    });

    if (reset) tbody.innerHTML = '';

    if (result.items.length === 0 && !_envCursor) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--text-muted)">No envelopes found.</td></tr>`;
    } else {
      result.items.forEach(rec => tbody.appendChild(buildEnvelopeRow(rec)));
    }

    _envCursor = result.cursor;
    $('envelopes-load-more').toggleAttribute('hidden', !result.cursor);
  } catch (e) {
    if (reset) tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:1.5rem;color:var(--danger)">${esc(e.message)}</td></tr>`;
    toast(e.message, 'error');
  }
}

function buildEnvelopeRow(rec) {
  const tr = document.createElement('tr');
  const actions = buildEnvelopeActions(rec);
  tr.innerHTML = `
    <td><code class="mono" style="font-size:.75rem">${esc(truncate(rec.id, 8))}</code></td>
    <td>
      <div style="font-weight:600;font-size:.8125rem">${esc(rec.brand)}</div>
      <div class="text-muted" style="font-size:.75rem">${esc(rec.model)}</div>
    </td>
    <td class="truncate" style="max-width:100px" title="${esc(rec.program)}">${esc(rec.program)}</td>
    <td><span class="badge badge-type">${esc(typeLabel(rec.applianceType))}</span></td>
    <td><span class="badge badge-${esc(rec.status)}">${esc(rec.status)}</span></td>
    <td class="text-muted truncate" title="${esc(rec.uploaderName || '')}">${esc(truncate(rec.uploaderName || 'Anon', 14))}</td>
    <td class="text-muted" style="white-space:nowrap;font-size:.75rem">${formatDate(rec.createdAt)}</td>
    <td class="text-muted">${rec.downloads || 0}</td>
    <td><div class="action-cell" data-env="${esc(rec.id)}"></div></td>
  `;
  // Mark the data cell so we can detect non-empty table
  tr.querySelector('td[data-env]').dataset.env = rec.id;
  buildEnvelopeActionBtns(tr.querySelector('.action-cell'), rec);
  return tr;
}

function buildEnvelopeActionBtns(container, rec) {
  container.innerHTML = '';

  if (rec.status !== 'approved') {
    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn btn-ghost btn-sm';
    approveBtn.textContent = 'Approve';
    approveBtn.addEventListener('click', async () => {
      approveBtn.disabled = true;
      try {
        await adminUpdateStatus(rec.id, 'approved');
        toast('Approved');
        rec.status = 'approved';
        const row = container.closest('tr');
        row.querySelector('.badge').className = `badge badge-approved`;
        row.querySelector('.badge').textContent = 'approved';
        buildEnvelopeActionBtns(container, rec);
      } catch (e) {
        approveBtn.disabled = false;
        toast(e.message, 'error');
      }
    });
    container.appendChild(approveBtn);
  }

  if (rec.status !== 'rejected') {
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn btn-ghost btn-sm';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', async () => {
      const reason = prompt('Rejection reason:');
      if (reason === null) return;
      rejectBtn.disabled = true;
      try {
        await adminUpdateStatus(rec.id, 'rejected', reason || '');
        toast('Rejected');
        rec.status = 'rejected';
        const row = container.closest('tr');
        row.querySelector('.badge').className = `badge badge-rejected`;
        row.querySelector('.badge').textContent = 'rejected';
        buildEnvelopeActionBtns(container, rec);
      } catch (e) {
        rejectBtn.disabled = false;
        toast(e.message, 'error');
      }
    });
    container.appendChild(rejectBtn);
  }

  if (rec.status === 'approved') {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-ghost btn-sm';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      if (!confirm('Remove this envelope from public view? The record is kept.')) return;
      removeBtn.disabled = true;
      try {
        await adminUpdateStatus(rec.id, 'removed');
        toast('Removed from public');
        rec.status = 'removed';
        const row = container.closest('tr');
        row.querySelector('.badge').className = `badge badge-removed`;
        row.querySelector('.badge').textContent = 'removed';
        buildEnvelopeActionBtns(container, rec);
      } catch (e) {
        removeBtn.disabled = false;
        toast(e.message, 'error');
      }
    });
    container.appendChild(removeBtn);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger btn-sm';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    if (!confirm(`Permanently delete "${rec.brand} ${rec.model} - ${rec.program}"? This cannot be undone.`)) return;
    deleteBtn.disabled = true;
    try {
      await deleteEnvelope(rec.id);
      container.closest('tr').remove();
      toast('Deleted permanently');
    } catch (e) {
      deleteBtn.disabled = false;
      toast(e.message, 'error');
    }
  });
  container.appendChild(deleteBtn);
}

$('env-filter-apply').addEventListener('click', () => {
  _envFilters.status = $('env-filter-status').value;
  _envFilters.applianceType = $('env-filter-type').value;
  loadEnvelopesTable(true);
});

$('env-filter-clear').addEventListener('click', () => {
  $('env-filter-status').value = '';
  $('env-filter-type').value = '';
  _envFilters = { status: '', applianceType: '' };
  loadEnvelopesTable(true);
});

$('envelopes-load-more').addEventListener('click', () => loadEnvelopesTable(false));

// ============================================================
// Users table
// ============================================================
async function loadUsersTable(reset = false) {
  if (reset) {
    _userCursor = null;
    $('users-load-more').setAttribute('hidden', '');
  }

  const tbody = $('users-tbody');
  if (reset) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:1.5rem;color:var(--text-muted)">Loading...</td></tr>`;
  }

  try {
    const result = await adminListUsers({ pageSize: 25, cursor: _userCursor });

    if (reset) tbody.innerHTML = '';

    if (result.items.length === 0 && !_userCursor) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted)">No users found.</td></tr>`;
    } else {
      result.items.forEach(user => tbody.appendChild(buildUserRow(user)));
    }

    _userCursor = result.cursor;
    $('users-load-more').toggleAttribute('hidden', !result.cursor);
  } catch (e) {
    if (reset) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:1.5rem;color:var(--danger)">${esc(e.message)}</td></tr>`;
    toast(e.message, 'error');
  }
}

function buildUserRow(user) {
  const tr = document.createElement('tr');
  const initial = (user.displayName || 'U').charAt(0).toUpperCase();
  const avatarHtml = user.photoURL
    ? `<img src="${esc(user.photoURL)}" alt="">`
    : initial;
  const statusBadge = user.banned
    ? `<span class="badge badge-rejected">Banned</span>`
    : `<span class="badge badge-approved">Active</span>`;

  tr.innerHTML = `
    <td>
      <div class="user-cell">
        <div class="user-cell-avatar">${avatarHtml}</div>
        <span style="font-size:.8125rem;font-weight:500">${esc(user.displayName || 'Unknown')}</span>
      </div>
    </td>
    <td data-uid="${esc(user.uid)}"><code class="mono" style="font-size:.72rem">${esc(truncate(user.uid, 12))}</code></td>
    <td>${statusBadge}</td>
    <td class="text-muted" style="font-size:.75rem;max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(user.banReason || '-')}</td>
    <td class="text-muted" style="white-space:nowrap;font-size:.75rem">${formatDate(user.createdAt)}</td>
    <td><div class="action-cell"></div></td>
  `;

  buildUserActionBtns(tr.querySelector('.action-cell'), user, tr);
  return tr;
}

function buildUserActionBtns(container, user, tr) {
  container.innerHTML = '';

  if (user.banned) {
    const unbanBtn = document.createElement('button');
    unbanBtn.className = 'btn btn-ghost btn-sm';
    unbanBtn.textContent = 'Unban';
    unbanBtn.addEventListener('click', async () => {
      if (!confirm(`Unban ${user.displayName || user.uid}?`)) return;
      unbanBtn.disabled = true;
      try {
        await adminUnbanUser(user.uid);
        toast('User unbanned');
        user.banned = false;
        user.banReason = null;
        refreshUserRow(tr, user);
      } catch (e) {
        unbanBtn.disabled = false;
        toast(e.message, 'error');
      }
    });
    container.appendChild(unbanBtn);
  } else {
    const banBtn = document.createElement('button');
    banBtn.className = 'btn btn-danger btn-sm';
    banBtn.textContent = 'Ban';
    banBtn.addEventListener('click', async () => {
      const reason = prompt(`Ban reason for ${user.displayName || user.uid}:`);
      if (reason === null) return;
      banBtn.disabled = true;
      try {
        await adminBanUser(user.uid, reason || '');
        toast('User banned');
        user.banned = true;
        user.banReason = reason || '';
        refreshUserRow(tr, user);
      } catch (e) {
        banBtn.disabled = false;
        toast(e.message, 'error');
      }
    });
    container.appendChild(banBtn);
  }
}

function refreshUserRow(tr, user) {
  // Update status cell and ban reason cell, rebuild action cell
  const cells = tr.querySelectorAll('td');
  cells[2].innerHTML = user.banned
    ? `<span class="badge badge-rejected">Banned</span>`
    : `<span class="badge badge-approved">Active</span>`;
  cells[3].textContent = user.banReason || '-';
  buildUserActionBtns(cells[5].querySelector('.action-cell'), user, tr);
}

$('users-load-more').addEventListener('click', () => loadUsersTable(false));

// ============================================================
// Review modal
// ============================================================
function openReviewModal(rec) {
  _reviewRecord = rec;
  $('review-modal-title').textContent = `${rec.brand} ${rec.model}`;
  $('review-modal-subtitle').textContent = rec.program;
  $('review-modal-sparkline').innerHTML = sparklineSVG(rec, 320, 80);

  const env = rec.envelope || {};
  $('review-modal-body').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.875rem">
      <div class="detail-item"><span class="detail-label">Type</span><span class="detail-value">${esc(typeLabel(rec.applianceType))}</span></div>
      <div class="detail-item"><span class="detail-label">Uploader</span><span class="detail-value">${esc(rec.uploaderName || 'Anonymous')}</span></div>
      <div class="detail-item"><span class="detail-label">Duration</span><span class="detail-value">${formatDuration(env.target_duration)}</span></div>
      <div class="detail-item"><span class="detail-label">Avg Energy</span><span class="detail-value">${env.avg_energy != null ? env.avg_energy.toFixed(3) + ' kWh' : '-'}</span></div>
      <div class="detail-item"><span class="detail-label">Cycles</span><span class="detail-value">${env.cycle_count ?? '-'}</span></div>
      <div class="detail-item"><span class="detail-label">Interval</span><span class="detail-value">${rec.sampleIntervalSec != null ? rec.sampleIntervalSec + 's' : '-'}</span></div>
      <div class="detail-item"><span class="detail-label">Uploaded</span><span class="detail-value">${formatDate(rec.createdAt)}</span></div>
      <div class="detail-item"><span class="detail-label">Schema v</span><span class="detail-value">${rec.envelopeSchemaVersion ?? '-'}</span></div>
    </div>
    ${rec.sensor ? `<div class="mt-1 text-muted" style="font-size:.8125rem">Sensor: ${esc(rec.sensor)}</div>` : ''}
    ${rec.notes ? `<div class="mt-2" style="font-size:.875rem;color:var(--text)">${esc(rec.notes)}</div>` : ''}
    <div style="margin-top:.875rem">
      <div class="detail-label" style="margin-bottom:.35rem">Envelope preview</div>
      <pre class="envelope-json" style="max-height:180px">${esc(JSON.stringify(rec.envelope || {}, null, 2))}</pre>
    </div>
  `;

  $('review-modal').removeAttribute('hidden');
}

function closeReviewModal() {
  $('review-modal').setAttribute('hidden', '');
  _reviewRecord = null;
}

$('review-modal-close').addEventListener('click', closeReviewModal);
$('review-modal-close-footer').addEventListener('click', closeReviewModal);
$('review-modal').addEventListener('click', (e) => {
  if (e.target === $('review-modal')) closeReviewModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('review-modal').hasAttribute('hidden')) closeReviewModal();
});

$('review-approve-btn').addEventListener('click', async () => {
  if (!_reviewRecord) return;
  const btn = $('review-approve-btn');
  btn.disabled = true;
  try {
    await adminUpdateStatus(_reviewRecord.id, 'approved');
    toast(`Approved: ${_reviewRecord.brand} ${_reviewRecord.model}`);
    // Remove from review queue if visible
    const card = $(`review-card-${_reviewRecord.id}`);
    if (card) {
      card.remove();
      if (!$('review-list').hasChildNodes()) {
        $('review-list').innerHTML = `<div class="empty-state">
          <div class="empty-icon">&#9989;</div>
          <div class="empty-title">Queue is clear</div>
          <div class="empty-text">No envelopes pending review.</div>
        </div>`;
      }
    }
    closeReviewModal();
  } catch (e) {
    btn.disabled = false;
    toast(e.message, 'error');
  }
});

$('review-reject-btn').addEventListener('click', async () => {
  if (!_reviewRecord) return;
  const reason = prompt('Rejection reason (shown to uploader):');
  if (reason === null) return;
  const btn = $('review-reject-btn');
  btn.disabled = true;
  try {
    await adminUpdateStatus(_reviewRecord.id, 'rejected', reason || '');
    toast('Rejected');
    const card = $(`review-card-${_reviewRecord.id}`);
    if (card) {
      card.remove();
      if (!$('review-list').hasChildNodes()) {
        $('review-list').innerHTML = `<div class="empty-state">
          <div class="empty-icon">&#9989;</div>
          <div class="empty-title">Queue is clear</div>
          <div class="empty-text">No envelopes pending review.</div>
        </div>`;
      }
    }
    closeReviewModal();
  } catch (e) {
    btn.disabled = false;
    toast(e.message, 'error');
  }
});
