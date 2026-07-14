// Auth-handoff page. Opened by the ha_washdata integration panel in a popup.
// Runs on the store's own authorized domain (so the Firebase GitHub popup works),
// then hands the refresh token back to the opener via postMessage.
import firebaseConfig from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, signInWithPopup, GithubAuthProvider } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const params = new URLSearchParams(location.search);
const targetOrigin = params.get('origin') || '';
const msg = document.getElementById('msg');
const retry = document.getElementById('retry');

// The HA panel passes its own origin. Accept only real http(s) origins (never '*').
function isAllowedOrigin(origin) {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.host;
  } catch {
    return false;
  }
}

async function run() {
  if (!window.opener || !isAllowedOrigin(targetOrigin)) {
    msg.textContent = 'This page must be opened by the WashData integration.';
    retry.hidden = true;
    return;
  }
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
    retry.hidden = false;
  }
}

retry.addEventListener('click', run);
run();
