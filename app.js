import firebaseConfig from './config.js';
import {
  init, onAuth, signIn, signOutUser, isAdmin, ensureUserProfile,
  uploadEnvelope, listEnvelopes, deleteEnvelope, bumpDownload,
  addComment, listComments, deleteComment,
  submitRating, getUserRating,
  parseCycle, saveAsFile,
} from './washstore.js';

init(firebaseConfig);

// ============================================================
// Module state
// ============================================================
let _user = null;
let _adminFlag = false;
let _browseCursor = null;
let _browseFilters = { applianceType: '', brand: '' };
let _mineLoadedUid = null;
let _mineCursor = null;
let _openRecord = null;
let _replyToId = null;

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

function sparklineSVG(record, w = 160, h = 48) {
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
  const pad = 3;
  const sx = x => pad + ((x - x0) / (xN - x0 || 1)) * (w - 2 * pad);
  const sy = y => h - pad - (y / yMax) * (h - 2 * pad);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <path d="${d}" stroke="var(--accent)" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
  </svg>`;
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
    $('signin-btn').addEventListener('click', () => doSignIn());
  }
}

async function doSignIn() {
  try { await signIn(); } catch (e) { toast(e.message, 'error'); }
}

onAuth(async (user) => {
  _user = user;
  _adminFlag = false;
  renderAuthArea(user);

  // Update upload + mine tab visibility
  updateUploadAuth();
  updateMineAuth();

  if (user) {
    try { await ensureUserProfile(user); } catch (_) {}
    try {
      _adminFlag = await isAdmin();
    } catch (_) {}
  }

  // Show/hide admin nav link
  if (_adminFlag) {
    $('admin-link').removeAttribute('hidden');
  } else {
    $('admin-link').setAttribute('hidden', '');
  }

  // Reload mine grid if visible and user changed
  if (!$('mine-tab').hasAttribute('hidden')) {
    maybeLoadMine();
  }

  // Update comment form visibility if modal is open
  updateCommentFormAuth();
});

// ============================================================
// Tab routing
// ============================================================
function switchTab(name) {
  ['browse', 'upload', 'mine'].forEach(tab => {
    $(`${tab}-tab`).toggleAttribute('hidden', tab !== name);
    $(`${tab}-btn`).classList.toggle('active', tab === name);
    $(`${tab}-btn`).setAttribute('aria-selected', tab === name ? 'true' : 'false');
    $(`${tab}-nav`).classList.toggle('active', tab === name);
  });

  if (name === 'browse' && !$('card-grid').hasChildNodes()) {
    loadBrowse(true);
  }
  if (name === 'mine') {
    maybeLoadMine();
  }
}

$('browse-btn').addEventListener('click', () => switchTab('browse'));
$('upload-btn').addEventListener('click', () => switchTab('upload'));
$('mine-btn').addEventListener('click', () => switchTab('mine'));
$('browse-nav').addEventListener('click', () => switchTab('browse'));
$('upload-nav').addEventListener('click', () => switchTab('upload'));
$('mine-nav').addEventListener('click', () => switchTab('mine'));

// ============================================================
// Browse tab
// ============================================================
async function loadBrowse(reset = false) {
  if (reset) {
    _browseCursor = null;
    $('card-grid').innerHTML = '';
    $('load-more-btn').setAttribute('hidden', '');
  }

  const spinner = loadingPlaceholder();
  $('card-grid').appendChild(spinner);

  try {
    const { applianceType, brand } = _browseFilters;
    const result = await listEnvelopes({
      applianceType: applianceType || null,
      brand: brand || null,
      pageSize: 24,
      cursor: _browseCursor,
    });

    spinner.remove();

    if (result.items.length === 0 && !_browseCursor) {
      $('card-grid').innerHTML = emptyHTML('&#128269;', 'No envelopes found', 'Try a different filter or check back later.');
    } else {
      result.items.forEach(rec => $('card-grid').appendChild(buildCard(rec)));
    }

    _browseCursor = result.cursor;
    $('load-more-btn').toggleAttribute('hidden', !result.cursor);
  } catch (e) {
    spinner.remove();
    if (reset) {
      $('card-grid').innerHTML = emptyHTML('&#9888;', 'Failed to load', esc(e.message));
    }
    toast(e.message, 'error');
  }
}

function buildCard(rec) {
  const el = document.createElement('div');
  el.className = 'card';
  const stars = rec.avgRating != null ? `&#9733; ${rec.avgRating.toFixed(1)}` : '';
  el.innerHTML = `
    <div class="card-sparkline">${sparklineSVG(rec, 160, 48)}</div>
    <div class="card-body">
      <div class="card-title">${esc(rec.brand)} ${esc(rec.model)}</div>
      <div class="card-subtitle">${esc(rec.program)}</div>
      <div class="card-badges">
        <span class="badge badge-type">${esc(typeLabel(rec.applianceType))}</span>
        ${stars ? `<span class="badge badge-rating">${stars}</span>` : ''}
      </div>
      <div class="card-meta">
        <span>by ${esc(rec.uploaderName || 'Anonymous')}</span>
        <span>&middot; ${rec.downloads || 0} dl</span>
        ${rec.ratingCount ? `<span>&middot; ${rec.ratingCount} rating${rec.ratingCount > 1 ? 's' : ''}</span>` : ''}
      </div>
    </div>
    <div class="card-actions">
      <button class="btn btn-primary btn-sm">Details</button>
      <button class="btn btn-ghost btn-sm">Download</button>
    </div>
  `;
  const [detailsBtn, downloadBtn] = el.querySelectorAll('.card-actions .btn');
  detailsBtn.addEventListener('click', () => openDetails(rec));
  downloadBtn.addEventListener('click', () => doDownload(rec));
  return el;
}

async function doDownload(rec) {
  try {
    await bumpDownload(rec.id);
    saveAsFile(rec);
  } catch (e) {
    toast(e.message, 'error');
  }
}

$('filter-apply').addEventListener('click', () => {
  _browseFilters.applianceType = $('filter-type').value;
  _browseFilters.brand = $('filter-brand').value.trim();
  loadBrowse(true);
});

$('filter-clear').addEventListener('click', () => {
  $('filter-type').value = '';
  $('filter-brand').value = '';
  _browseFilters = { applianceType: '', brand: '' };
  loadBrowse(true);
});

$('load-more-btn').addEventListener('click', () => loadBrowse(false));

// ============================================================
// Upload tab
// ============================================================
function updateUploadAuth() {
  if (_user) {
    $('upload-auth-notice').setAttribute('hidden', '');
    $('upload-form').removeAttribute('hidden');
  } else {
    $('upload-auth-notice').removeAttribute('hidden');
    $('upload-form').setAttribute('hidden', '');
  }
}

$('upload-signin-btn').addEventListener('click', () => doSignIn());

$('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!_user) { toast('Please sign in first', 'error'); return; }

  const btn = $('upload-submit');
  const resultEl = $('upload-result');
  btn.disabled = true;
  btn.textContent = 'Uploading...';
  resultEl.setAttribute('hidden', '');

  try {
    const envFile = $('up-envelope-file').files[0];
    if (!envFile) throw new Error('Envelope JSON file is required');

    let envelope;
    try {
      envelope = JSON.parse(await envFile.text());
    } catch (_) {
      throw new Error('Envelope file is not valid JSON');
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new Error('Envelope must be a JSON object, not an array');
    }
    if (!Array.isArray(envelope.avg)) {
      throw new Error('Envelope must contain an "avg" array');
    }

    let cyclePoints = null;
    const cycleFile = $('up-cycle-file').files[0];
    if (cycleFile) {
      try {
        cyclePoints = parseCycle(await cycleFile.text());
      } catch (ce) {
        throw new Error('Cycle file error: ' + ce.message);
      }
    }

    const interval = Number($('up-interval').value);
    if (!interval || interval <= 0 || interval > 3600) {
      throw new Error('Sample interval must be a number between 1 and 3600');
    }

    const meta = {
      applianceType: $('up-type').value,
      brand: $('up-brand').value.trim(),
      model: $('up-model').value.trim(),
      program: $('up-program').value.trim(),
      sampleIntervalSec: interval,
      sensor: $('up-sensor').value.trim() || '',
      notes: $('up-notes').value.trim() || null,
    };

    await uploadEnvelope(meta, envelope, cyclePoints);

    $('upload-form').reset();
    resultEl.textContent = 'Submitted for review. Your envelope will appear publicly once approved.';
    resultEl.className = 'text-success mt-1';
    resultEl.removeAttribute('hidden');
    toast('Upload submitted - pending review');
  } catch (e) {
    resultEl.textContent = e.message;
    resultEl.className = 'text-danger mt-1';
    resultEl.removeAttribute('hidden');
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit Upload';
  }
});

// ============================================================
// My Uploads tab
// ============================================================
function updateMineAuth() {
  if (_user) {
    $('mine-signin-notice').setAttribute('hidden', '');
    $('mine-content').removeAttribute('hidden');
  } else {
    $('mine-signin-notice').removeAttribute('hidden');
    $('mine-content').setAttribute('hidden', '');
    _mineLoadedUid = null;
    $('mine-grid').innerHTML = '';
    $('mine-load-more').setAttribute('hidden', '');
  }
}

$('mine-signin-btn').addEventListener('click', () => doSignIn());

function maybeLoadMine() {
  updateMineAuth();
  if (!_user) return;
  // Only reload if the user changed since last load
  if (_mineLoadedUid === _user.uid && $('mine-grid').hasChildNodes()) return;
  _mineLoadedUid = _user.uid;
  _mineCursor = null;
  $('mine-grid').innerHTML = '';
  $('mine-load-more').setAttribute('hidden', '');
  fetchMine();
}

async function fetchMine() {
  const spinner = loadingPlaceholder();
  $('mine-grid').appendChild(spinner);

  try {
    const result = await listEnvelopes({ mine: true, pageSize: 24, cursor: _mineCursor });
    spinner.remove();

    if (result.items.length === 0 && !_mineCursor) {
      $('mine-grid').innerHTML = emptyHTML(
        '&#128228;',
        'No uploads yet',
        'Upload your first envelope and share your appliance data with the community.'
      );
    } else {
      result.items.forEach(rec => $('mine-grid').appendChild(buildMineCard(rec)));
    }

    _mineCursor = result.cursor;
    $('mine-load-more').toggleAttribute('hidden', !result.cursor);
  } catch (e) {
    spinner.remove();
    toast(e.message, 'error');
  }
}

function buildMineCard(rec) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="card-sparkline">${sparklineSVG(rec, 160, 48)}</div>
    <div class="card-body">
      <div class="card-title">${esc(rec.brand)} ${esc(rec.model)}</div>
      <div class="card-subtitle">${esc(rec.program)}</div>
      <div class="card-badges">
        <span class="badge badge-type">${esc(typeLabel(rec.applianceType))}</span>
        <span class="badge badge-${esc(rec.status)}">${esc(rec.status)}</span>
      </div>
      ${rec.rejectionReason ? `<div class="rejection-reason mt-1">${esc(rec.rejectionReason)}</div>` : ''}
      <div class="card-meta">
        <span>${formatDate(rec.createdAt)}</span>
        <span>&middot; ${rec.downloads || 0} downloads</span>
      </div>
    </div>
    <div class="card-actions">
      <button class="btn btn-ghost btn-sm">Details</button>
      <button class="btn btn-danger btn-sm">Delete</button>
    </div>
  `;
  const [detailsBtn, deleteBtn] = el.querySelectorAll('.card-actions .btn');
  detailsBtn.addEventListener('click', () => openDetails(rec));
  deleteBtn.addEventListener('click', async () => {
    if (!confirm(`Delete "${rec.brand} ${rec.model} - ${rec.program}"? This cannot be undone.`)) return;
    try {
      await deleteEnvelope(rec.id);
      el.remove();
      toast('Envelope deleted');
      // If grid is now empty, show empty state
      if (!$('mine-grid').hasChildNodes()) {
        $('mine-grid').innerHTML = emptyHTML('&#128228;', 'No uploads yet', 'Upload your first envelope.');
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  return el;
}

$('mine-load-more').addEventListener('click', () => fetchMine());

// ============================================================
// Details modal - open / close
// ============================================================
async function openDetails(rec) {
  _openRecord = rec;
  _replyToId = null;

  $('modal-title').textContent = `${rec.brand} ${rec.model}`;
  $('modal-program').textContent = rec.program;
  $('modal-badges').innerHTML = `
    <span class="badge badge-type">${esc(typeLabel(rec.applianceType))}</span>
    <span class="badge badge-${esc(rec.status)}">${esc(rec.status)}</span>
  `;

  $('modal-sparkline').innerHTML = sparklineSVG(rec, 320, 80);

  // Populate detail section
  const env = rec.envelope || {};
  $('modal-detail-content').innerHTML = buildDetailGrid(rec, env);

  // Reset to details tab
  switchModalTab('detail');

  // JSON section
  $('modal-json-content').textContent = JSON.stringify(rec.envelope || {}, null, 2);

  // Rating
  await loadRatingSection(rec.id);

  // Comments
  await loadComments(rec.id);

  // Update comment form
  updateCommentFormAuth();

  $('details-modal').removeAttribute('hidden');
  $('details-modal').focus();
}

function buildDetailGrid(rec, env) {
  return `
    <div class="detail-grid">
      <div class="detail-item"><span class="detail-label">Brand</span><span class="detail-value">${esc(rec.brand)}</span></div>
      <div class="detail-item"><span class="detail-label">Model</span><span class="detail-value">${esc(rec.model)}</span></div>
      <div class="detail-item"><span class="detail-label">Program</span><span class="detail-value">${esc(rec.program)}</span></div>
      <div class="detail-item"><span class="detail-label">Type</span><span class="detail-value">${esc(typeLabel(rec.applianceType))}</span></div>
      <div class="detail-item"><span class="detail-label">Duration</span><span class="detail-value">${formatDuration(env.target_duration)}</span></div>
      <div class="detail-item"><span class="detail-label">Avg Energy</span><span class="detail-value">${env.avg_energy != null ? env.avg_energy.toFixed(3) + ' kWh' : '-'}</span></div>
      <div class="detail-item"><span class="detail-label">Cycles</span><span class="detail-value">${env.cycle_count ?? '-'}</span></div>
      <div class="detail-item"><span class="detail-label">Interval</span><span class="detail-value">${rec.sampleIntervalSec != null ? rec.sampleIntervalSec + 's' : '-'}</span></div>
      <div class="detail-item"><span class="detail-label">Uploader</span><span class="detail-value">${esc(rec.uploaderName || 'Anonymous')}</span></div>
      <div class="detail-item"><span class="detail-label">Uploaded</span><span class="detail-value">${formatDate(rec.createdAt)}</span></div>
      <div class="detail-item"><span class="detail-label">Downloads</span><span class="detail-value">${rec.downloads || 0}</span></div>
      <div class="detail-item"><span class="detail-label">Schema v</span><span class="detail-value">${rec.envelopeSchemaVersion ?? '-'}</span></div>
    </div>
    ${rec.sensor ? `<div class="mt-1 text-muted" style="font-size:.8125rem">Sensor: ${esc(rec.sensor)}</div>` : ''}
    ${rec.notes ? `<div class="mt-1" style="font-size:.875rem;color:var(--text)">${esc(rec.notes)}</div>` : ''}
    ${rec.rejectionReason ? `<div class="rejection-reason mt-2">Rejection reason: ${esc(rec.rejectionReason)}</div>` : ''}
  `;
}

function closeModal() {
  $('details-modal').setAttribute('hidden', '');
  _openRecord = null;
  cancelReply();
}

$('modal-close').addEventListener('click', closeModal);
$('modal-close-footer').addEventListener('click', closeModal);
$('details-modal').addEventListener('click', (e) => {
  if (e.target === $('details-modal')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('details-modal').hasAttribute('hidden')) closeModal();
});

$('modal-download-btn').addEventListener('click', () => {
  if (!_openRecord) return;
  doDownload(_openRecord);
});

// ============================================================
// Details modal - sub-tabs
// ============================================================
function switchModalTab(name) {
  ['detail', 'json', 'comments'].forEach(t => {
    $(`modal-${t}-section`).toggleAttribute('hidden', t !== name);
    $(`modal-${t}-tab-btn`).classList.toggle('active', t === name);
  });
}

$('modal-detail-tab-btn').addEventListener('click', () => switchModalTab('detail'));
$('modal-json-tab-btn').addEventListener('click', () => switchModalTab('json'));
$('modal-comments-tab-btn').addEventListener('click', () => switchModalTab('comments'));

// ============================================================
// Rating
// ============================================================
async function loadRatingSection(envelopeId) {
  const section = $('modal-rating-section');
  if (!_user) {
    section.innerHTML = `<div class="text-muted" style="font-size:.875rem">Sign in to rate this envelope.</div>`;
    return;
  }
  try {
    const current = (await getUserRating(envelopeId)) || 0;
    renderStars(current, envelopeId);
  } catch (_) {
    section.innerHTML = `<div class="text-muted" style="font-size:.875rem">Could not load rating.</div>`;
  }
}

function renderStars(current, envelopeId) {
  const section = $('modal-rating-section');
  const avgInfo = _openRecord?.avgRating != null
    ? `Avg ${_openRecord.avgRating.toFixed(1)} from ${_openRecord.ratingCount} rating${_openRecord.ratingCount > 1 ? 's' : ''}`
    : 'No ratings yet';

  section.innerHTML = `
    <div class="rating-row">
      <div class="rating-stars" id="star-row" aria-label="Rate this envelope">
        ${[1, 2, 3, 4, 5].map(n => `<button class="star${n <= current ? ' filled' : ''}" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">&#9733;</button>`).join('')}
      </div>
      <span class="rating-info">${esc(avgInfo)}</span>
    </div>
    ${current ? `<div class="text-muted" style="font-size:.75rem">Your rating: ${current}/5</div>` : ''}
  `;

  const row = $('star-row');
  const stars = Array.from(row.querySelectorAll('.star'));

  stars.forEach(btn => {
    btn.addEventListener('mouseenter', () => {
      const n = +btn.dataset.n;
      stars.forEach(s => s.classList.toggle('hov', +s.dataset.n <= n));
    });
    btn.addEventListener('mouseleave', () => {
      stars.forEach(s => s.classList.remove('hov'));
    });
    btn.addEventListener('click', async () => {
      const n = +btn.dataset.n;
      try {
        await submitRating(envelopeId, n);
        toast('Rating saved');
        renderStars(n, envelopeId);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });
}

// ============================================================
// Comments
// ============================================================
async function loadComments(envelopeId) {
  const list = $('modal-comments-list');
  list.innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';
  try {
    const { items } = await listComments(envelopeId);
    renderComments(items, envelopeId);
  } catch (_) {
    list.innerHTML = `<div class="text-muted" style="font-size:.875rem">Could not load comments.</div>`;
  }
}

function renderComments(comments, envelopeId) {
  const list = $('modal-comments-list');
  list.innerHTML = '';

  if (!comments.length) {
    list.innerHTML = `<div class="text-muted" style="font-size:.875rem">No comments yet.</div>`;
    return;
  }

  const topLevel = comments.filter(c => !c.parentId);
  const byParent = {};
  comments.filter(c => c.parentId).forEach(c => {
    if (!byParent[c.parentId]) byParent[c.parentId] = [];
    byParent[c.parentId].push(c);
  });

  topLevel.forEach(c => {
    list.appendChild(buildCommentEl(c, false, envelopeId));
    (byParent[c.id] || []).forEach(r => list.appendChild(buildCommentEl(r, true, envelopeId)));
  });
}

function buildCommentEl(comment, isReply, envelopeId) {
  const el = document.createElement('div');
  el.className = `comment${isReply ? ' is-reply' : ''}`;
  const initial = (comment.authorName || 'A').charAt(0).toUpperCase();
  const canDelete = _user && (_adminFlag || _user.uid === comment.authorUid);

  el.innerHTML = `
    <div class="comment-avatar">${esc(initial)}</div>
    <div class="comment-body">
      <div class="comment-header">
        <span class="comment-author">${esc(comment.authorName || 'Anonymous')}</span>
        <span class="comment-date">${formatDate(comment.createdAt)}</span>
      </div>
      <div class="comment-text">${esc(comment.text)}</div>
      <div class="comment-actions">
        ${!isReply && _user ? `<button class="reply-btn" data-reply-id="${esc(comment.id)}">Reply</button>` : ''}
        ${canDelete ? `<button class="reply-btn danger" data-del-id="${esc(comment.id)}">Delete</button>` : ''}
      </div>
    </div>
  `;

  const replyBtn = el.querySelector('[data-reply-id]');
  if (replyBtn) {
    replyBtn.addEventListener('click', () => {
      _replyToId = comment.id;
      $('reply-indicator-text').textContent = `Replying to ${comment.authorName || 'Anonymous'}`;
      $('reply-indicator').removeAttribute('hidden');
      $('cancel-reply-btn').removeAttribute('hidden');
      $('comment-input').focus();
      switchModalTab('comments');
    });
  }

  const delBtn = el.querySelector('[data-del-id]');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      if (!confirm('Delete this comment?')) return;
      try {
        await deleteComment(envelopeId, comment.id);
        toast('Comment deleted');
        await loadComments(envelopeId);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  return el;
}

function updateCommentFormAuth() {
  if (!$('details-modal') || $('details-modal').hasAttribute('hidden')) return;
  if (_user) {
    $('comment-auth-notice').setAttribute('hidden', '');
    $('comment-input').removeAttribute('hidden');
    $('comment-submit-row').removeAttribute('hidden');
  } else {
    $('comment-auth-notice').removeAttribute('hidden');
    $('comment-input').setAttribute('hidden', '');
    $('comment-submit-row').setAttribute('hidden', '');
  }
}

function cancelReply() {
  _replyToId = null;
  $('reply-indicator').setAttribute('hidden', '');
  $('cancel-reply-btn').setAttribute('hidden', '');
  $('reply-indicator-text').textContent = '';
}

$('cancel-reply-btn').addEventListener('click', cancelReply);

$('submit-comment-btn').addEventListener('click', async () => {
  if (!_user) { toast('Sign in to comment', 'error'); return; }
  const text = $('comment-input').value.trim();
  if (!text) return;
  if (!_openRecord) return;

  const btn = $('submit-comment-btn');
  btn.disabled = true;
  try {
    await addComment(_openRecord.id, text, _replyToId || null);
    $('comment-input').value = '';
    cancelReply();
    toast('Comment posted');
    await loadComments(_openRecord.id);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// Shared UI helpers
// ============================================================
function loadingPlaceholder() {
  const el = document.createElement('div');
  el.className = 'loading-center';
  el.style.gridColumn = '1 / -1';
  el.innerHTML = '<div class="loading-spinner"></div>';
  return el;
}

function emptyHTML(icon, title, text) {
  return `<div class="empty-state" style="grid-column:1/-1">
    <div class="empty-icon">${icon}</div>
    <div class="empty-title">${esc(title)}</div>
    <div class="empty-text">${esc(text)}</div>
  </div>`;
}

// ============================================================
// Initial load
// ============================================================
switchTab('browse');
