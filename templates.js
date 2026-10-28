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
//
// templates.html: the automation templates from the washdata-automations repository.
// library.json there is generated after every merge, so this page is always current and
// costs no Firestore read. Every string in it is contributor text: the page builds its DOM
// with textContent only, and links only to the URLs it expects.

const LIBRARY_URL = 'https://raw.githubusercontent.com/3dg1luk43/washdata-automations/main/library.json';
const REPO_URL = 'https://github.com/3dg1luk43/washdata-automations';
const LINK_PREFIXES = {
  file: `${REPO_URL}/blob/main/automation/`,
  import: 'https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=',
};
const DEVICE_LABELS = {
  all: 'All appliances',
  washing_machine: 'Washers',
  dryer: 'Dryers',
  washer_dryer: 'Washer-dryers',
  dishwasher: 'Dishwashers',
  pump: 'Pumps',
  generic: 'Other appliances',
  other: 'Threshold devices',
};
const NEEDS_RE = /^Needs WashData (\d+\.\d+\.\d+) or newer\.$/;
// Material Design Icons paths (@mdi/js 7.4.47, Apache-2.0), the same ones WashData's panel draws.
const ICONS = {
  plug: 'M16 7V3H14V7H10V3H8V7C7 7 6 8 6 9V14.5L9.5 18V21H14.5V18L18 14.5V9C18 8 17 7 16 7M16 13.67L13.09 16.59L12.67 17H11.33L10.92 16.59L8 13.67V9.09C8 9.06 8.06 9 8.09 9H15.92C15.95 9 16 9.06 16 9.09V13.67Z',
  light: 'M12,2A7,7 0 0,1 19,9C19,11.38 17.81,13.47 16,14.74V17A1,1 0 0,1 15,18H9A1,1 0 0,1 8,17V14.74C6.19,13.47 5,11.38 5,9A7,7 0 0,1 12,2M9,21V20H15V21A1,1 0 0,1 14,22H10A1,1 0 0,1 9,21M12,4A5,5 0 0,0 7,9C7,11.05 8.23,12.81 10,13.58V16H14V13.58C15.77,12.81 17,11.05 17,9A5,5 0 0,0 12,4Z',
  bell: 'M10 21H14C14 22.1 13.1 23 12 23S10 22.1 10 21M21 19V20H3V19L5 17V11C5 7.9 7 5.2 10 4.3V4C10 2.9 10.9 2 12 2S14 2.9 14 4V4.3C17 5.2 19 7.9 19 11V17L21 19M17 11C17 8.2 14.8 6 12 6S7 8.2 7 11V18H17V11Z',
  dryer: 'M6,2H18A2,2 0 0,1 20,4V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V4A2,2 0 0,1 6,2M7,4A1,1 0 0,0 6,5A1,1 0 0,0 7,6A1,1 0 0,0 8,5A1,1 0 0,0 7,4M10,4A1,1 0 0,0 9,5A1,1 0 0,0 10,6A1,1 0 0,0 11,5A1,1 0 0,0 10,4M12,8A6,6 0 0,0 6,14A6,6 0 0,0 12,20A6,6 0 0,0 18,14A6,6 0 0,0 12,8M8.11,10.5H10C9.76,11.88 10,12.67 10.58,13.29C11.68,14.36 12.16,15.71 11.89,17.5H10C10.24,16.12 10,15.33 9.42,14.71C8.32,13.64 7.85,12.29 8.11,10.5M12.11,10.5H14C13.76,11.88 14,12.67 14.58,13.29C15.68,14.36 16.16,15.71 15.89,17.5H14C14.24,16.12 14,15.33 13.42,14.71C12.32,13.64 11.85,12.29 12.11,10.5Z',
  washer: 'M14.83,11.17C16.39,12.73 16.39,15.27 14.83,16.83C13.27,18.39 10.73,18.39 9.17,16.83L14.83,11.17M6,2H18A2,2 0 0,1 20,4V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V4A2,2 0 0,1 6,2M7,4A1,1 0 0,0 6,5A1,1 0 0,0 7,6A1,1 0 0,0 8,5A1,1 0 0,0 7,4M10,4A1,1 0 0,0 9,5A1,1 0 0,0 10,6A1,1 0 0,0 11,5A1,1 0 0,0 10,4M12,8A6,6 0 0,0 6,14A6,6 0 0,0 12,20A6,6 0 0,0 18,14A6,6 0 0,0 12,8Z',
  dishwasher: 'M18,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V4A2,2 0 0,0 18,2M10,4A1,1 0 0,1 11,5A1,1 0 0,1 10,6A1,1 0 0,1 9,5A1,1 0 0,1 10,4M7,4A1,1 0 0,1 8,5A1,1 0 0,1 7,6A1,1 0 0,1 6,5A1,1 0 0,1 7,4M18,20H6V8H18V20M14.67,15.33C14.69,16.03 14.41,16.71 13.91,17.21C12.86,18.26 11.15,18.27 10.09,17.21C9.59,16.71 9.31,16.03 9.33,15.33C9.4,14.62 9.63,13.94 10,13.33C10.37,12.5 10.81,11.73 11.33,11L12,10C13.79,12.59 14.67,14.36 14.67,15.33',
  timer: 'M12,20A7,7 0 0,1 5,13A7,7 0 0,1 12,6A7,7 0 0,1 19,13A7,7 0 0,1 12,20M19.03,7.39L20.45,5.97C20,5.46 19.55,5 19.04,4.56L17.62,6C16.07,4.74 14.12,4 12,4A9,9 0 0,0 3,13A9,9 0 0,0 12,22C17,22 21,17.97 21,13C21,10.88 20.26,8.93 19.03,7.39M11,14H13V8H11M15,1H9V3H15V1Z',
  power: 'M7,2H17L13.5,9H17L10,22V14H7V2M9,4V12H12V14.66L14,11H10.24L13.76,4H9Z',
  default: 'M17.5 15.5C17.5 16.61 16.61 17.5 15.5 17.5S13.5 16.61 13.5 15.5 14.4 13.5 15.5 13.5 17.5 14.4 17.5 15.5M8.5 13.5C7.4 13.5 6.5 14.4 6.5 15.5S7.4 17.5 8.5 17.5 10.5 16.61 10.5 15.5 9.61 13.5 8.5 13.5M23 15V18C23 18.55 22.55 19 22 19H21V20C21 21.11 20.11 22 19 22H5C3.9 22 3 21.11 3 20V19H2C1.45 19 1 18.55 1 18V15C1 14.45 1.45 14 2 14H3C3 10.13 6.13 7 10 7H11V5.73C10.4 5.39 10 4.74 10 4C10 2.9 10.9 2 12 2S14 2.9 14 4C14 4.74 13.6 5.39 13 5.73V7H14C17.87 7 21 10.13 21 14H22C22.55 14 23 14.45 23 15M21 16H19V14C19 11.24 16.76 9 14 9H10C7.24 9 5 11.24 5 14V16H3V17H5V20H19V17H21V16Z',
};

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const str = (v) => (typeof v === 'string' ? v : '');
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || ICONS.default);
  svg.append(path);
  return svg;
}

function safeUrl(url, kind) {
  return typeof url === 'string' && url.startsWith(LINK_PREFIXES[kind]) ? url : '';
}

function outLink(href, text, cls) {
  const a = el('a', cls, `${text} ↗`);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

function typesText(types) {
  const t = list(types);
  if (!t.length || t.includes('all')) return DEVICE_LABELS.all;
  return t.map((d) => DEVICE_LABELS[d] || d).join(', ');
}

// ---- tiles -----------------------------------------------------------------

function tile(t) {
  const card = el('article', 'card tpl-card');
  const body = el('div', 'card-body');
  const top = el('div', 'tpl-card-top');
  const port = el('span', 'tpl-port');
  port.append(icon(str(t.icon)));
  const head = el('div', 'tpl-card-head');
  head.append(el('h2', 'card-title tpl-card-title', str(t.name)));
  if (str(t.author)) head.append(el('div', 'card-subtitle', `by ${t.author}`));
  top.append(port, head);
  body.append(top);
  body.append(el('p', 'tpl-summary', str(t.summary)));
  const badges = el('div', 'card-badges');
  badges.append(el('span', 'badge badge-type', typesText(t.device_types)));
  for (const tag of list(t.tags)) badges.append(el('span', 'badge badge-removed', tag));
  if (str(t.risk)) badges.append(el('span', 'badge badge-rating', 'Risk note'));
  body.append(badges);
  if (str(t.min_version)) body.append(el('div', 'card-meta', `Needs WashData ${t.min_version} or newer`));

  const actions = el('div', 'card-actions');
  const details = el('button', 'btn btn-ghost btn-sm', 'Details');
  details.type = 'button';
  details.addEventListener('click', () => openDetails(t, details));
  actions.append(details);
  const imp = safeUrl(t.urls && t.urls.import, 'import');
  if (imp) actions.append(outLink(imp, 'Import with My Home Assistant', 'btn btn-primary btn-sm'));
  card.append(body, actions);
  return card;
}

// ---- details ---------------------------------------------------------------

const modal = document.getElementById('tpl-modal');
let returnFocus = null;

function openDetails(t, opener) {
  returnFocus = opener;
  document.getElementById('tpl-modal-title').textContent = str(t.name);
  document.getElementById('tpl-modal-author').textContent = str(t.author) ? `by ${t.author}` : '';

  const body = document.getElementById('tpl-modal-body');
  body.replaceChildren();
  let needs = str(t.min_version);
  for (const raw of str(t.description).split(/\n\s*\n/)) {
    const para = raw.replace(/\s*\n\s*/g, ' ').trim();
    if (!para) continue;
    const m = para.match(NEEDS_RE);
    if (m) { needs = needs || m[1]; continue; }
    body.append(el('p', para.startsWith('Risk:') ? 'tpl-risk' : 'tpl-para', para));
  }

  const facts = el('dl', 'tpl-facts');
  const fact = (k, v) => { if (v) facts.append(el('dt', null, k), el('dd', null, v)); };
  fact('For', typesText(t.device_types));
  fact('Needs', needs ? `WashData ${needs} or newer` : '');
  fact('Author', str(t.author));
  fact('Tags', list(t.tags).join(', '));
  body.append(facts);

  const inputs = Array.isArray(t.inputs) ? t.inputs.filter((i) => i && typeof i === 'object') : [];
  if (inputs.length) {
    body.append(el('h3', 'tpl-sub', 'What you can set'));
    const ul = el('ul', 'tpl-inputs');
    for (const i of inputs) {
      const li = el('li');
      const name = el('div', 'tpl-input-name', str(i.name) || str(i.key));
      if (i.required === true) name.append(el('span', 'badge badge-pending', 'Required'));
      li.append(name);
      if (str(i.description)) li.append(el('div', 'tpl-input-desc', str(i.description)));
      ul.append(li);
    }
    body.append(ul);
  }

  const footer = document.getElementById('tpl-modal-footer');
  footer.replaceChildren();
  const file = safeUrl(t.urls && t.urls.file, 'file');
  const imp = safeUrl(t.urls && t.urls.import, 'import');
  if (file) footer.append(outLink(file, 'View on GitHub', 'btn btn-ghost btn-sm'));
  if (imp) footer.append(outLink(imp, 'Import with My Home Assistant', 'btn btn-primary btn-sm'));

  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  document.getElementById('tpl-modal-close').focus();
}

function closeDetails() {
  modal.hidden = true;
  document.body.style.overflow = '';
  if (returnFocus) returnFocus.focus();
}

document.getElementById('tpl-modal-close').addEventListener('click', closeDetails);
modal.addEventListener('click', (e) => { if (e.target === modal) closeDetails(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeDetails(); });

// ---- list, search and filter -----------------------------------------------

const bodyEl = document.getElementById('tpl-body');
const searchEl = document.getElementById('tpl-search');
const typeEl = document.getElementById('tpl-type');
let templates = [];

function haystack(t) {
  return [t.name, t.description, t.author, ...list(t.tags)].map(str).join(' ').toLowerCase();
}

function render() {
  const words = searchEl.value.toLowerCase().split(/\s+/).filter(Boolean);
  const type = typeEl.value;
  const shown = templates.filter((t) => {
    const types = list(t.device_types);
    if (type && types.length && !types.includes('all') && !types.includes(type)) return false;
    const text = haystack(t);
    return words.every((w) => text.includes(w));
  });
  bodyEl.replaceChildren();
  if (!shown.length) {
    const empty = el('div', 'empty-state');
    empty.append(el('div', 'empty-title', templates.length ? 'No template matches' : 'No templates yet'));
    if (templates.length) {
      const clear = el('button', 'btn btn-ghost btn-sm', 'Clear search');
      clear.type = 'button';
      clear.addEventListener('click', () => { searchEl.value = ''; typeEl.value = ''; render(); });
      empty.append(clear);
    }
    bodyEl.append(empty);
    return;
  }
  const grid = el('div', 'card-grid');
  for (const t of shown) grid.append(tile(t));
  bodyEl.append(grid);
}

function showError(err) {
  const box = el('div', 'empty-state');
  box.append(
    el('div', 'empty-icon', '⚠'),
    el('div', 'empty-title', 'Could not load the templates'),
    el('div', 'empty-text', `${err.name === 'AbortError' ? 'The request timed out' : err.message}. Try again later, or browse them on GitHub.`),
    outLink(REPO_URL, 'View the templates on GitHub', 'btn btn-ghost btn-sm mt-1'),
  );
  bodyEl.replaceChildren(box);
}

async function load() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(LIBRARY_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    templates = Array.isArray(data && data.templates)
      ? data.templates.filter((t) => t && typeof t === 'object' && str(t.name))
      : [];
    render();
  } catch (err) {
    showError(err);
  } finally {
    clearTimeout(timer);
  }
}

searchEl.addEventListener('input', render);
typeEl.addEventListener('change', render);
load();
