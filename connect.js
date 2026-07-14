// Auth-handoff page. Opened by the ha_washdata integration panel in a popup.
// Runs on the store's own authorized domain (so the Firebase GitHub popup works),
// then hands an auth token back to the opener via postMessage.
//
// Security: this page can hand the caller a Firebase refresh token, which is powerful.
// It therefore (a) never posts to '*', only to a concrete http(s) origin, and (b) never
// signs in automatically - it shows the destination origin and requires an explicit
// click, so a malicious site cannot silently phish a token by opening this page with
// its own ?origin=.
import firebaseConfig from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, signInWithPopup, GithubAuthProvider } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const params = new URLSearchParams(location.search);
const targetOrigin = params.get('origin') || '';
const msg = document.getElementById('msg');
const retry = document.getElementById('retry');

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The HA panel passes its own origin. Accept only real http(s) origins (never '*').
function isAllowedOrigin(origin) {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.host;
  } catch {
    return false;
  }
}

async function connect() {
  retry.disabled = true;
  try {
    msg.textContent = 'Opening GitHub sign-in...';
    const cred = await signInWithPopup(auth, new GithubAuthProvider());
    const u = cred.user;
    window.opener.postMessage({
      type: 'washdata-connect',
      refreshToken: u.refreshToken,
      uid: u.uid,
      displayName: u.displayName || null,
      photoURL: u.photoURL || null,
    }, targetOrigin);
    msg.textContent = 'Connected. You can close this window.';
    retry.hidden = true;
    setTimeout(() => window.close(), 800);
  } catch (e) {
    msg.textContent = 'Sign-in failed: ' + (e && e.message ? e.message : 'unknown error');
    retry.disabled = false;
    retry.hidden = false;
  }
}

function init() {
  if (!window.opener || !isAllowedOrigin(targetOrigin)) {
    msg.textContent = 'This page must be opened by the WashData integration.';
    retry.hidden = true;
    return;
  }
  // Do NOT auto-sign-in. Show where the token will be sent and require an explicit click,
  // so an unexpected destination is visible before any token is handed over.
  msg.innerHTML = 'This connects your WashData Store account to:<br><code style="color:var(--accent,#7c9cff)">'
    + escHtml(targetOrigin)
    + '</code><br><br>Only continue if that is your own Home Assistant.';
  retry.textContent = 'Connect with GitHub';
  retry.hidden = false;
  retry.addEventListener('click', connect);
}

init();
