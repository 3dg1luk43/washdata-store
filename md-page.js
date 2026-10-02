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
// Renders a first-party Markdown file into docs.html / changelog.html. It used to be an
// inline <script> on each page; as a file it lets those pages run under a
// Content-Security-Policy that allows no inline script. The including tag names the file
// and the noun for the error text:
//   <script src="md-page.js" data-src="./README.md" data-what="documentation"></script>
// Requires the `marked` global (loaded by the preceding <script>).

// currentScript is only set while this file first executes, so read it before any await.
const _mdScript = document.currentScript;

(async function () {
  const url = (_mdScript && _mdScript.dataset.src) || './README.md';
  const what = (_mdScript && _mdScript.dataset.what) || 'documentation';

  const elLoading = document.getElementById('docs-loading');
  const elError   = document.getElementById('docs-error');
  const elContent = document.getElementById('docs-content');
  const elErrText = document.getElementById('docs-error-text');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const md = await res.text();
    elContent.innerHTML = marked.parse(md);
    elLoading.hidden = true;
    elContent.hidden = false;
  } catch (err) {
    elLoading.hidden = true;
    elErrText.textContent =
      'Unable to load the ' + what + ' (' +
      (err.name === 'AbortError' ? 'request timed out' : err.message) +
      '). Check your connection or view it on GitHub directly.';
    elError.hidden = false;
  } finally {
    clearTimeout(timer);
  }
})();
