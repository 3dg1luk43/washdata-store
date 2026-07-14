# Security model

WashData Store is a static frontend (no server code) talking directly to Cloud Firestore.
There is no application server to compromise: the Firestore security rules
(`firestore.rules`) are the entire access-control layer. This document explains what is and
is not protected, and the residual risks an operator should know about.

## What is public by design

- **All frontend code** (`*.js`, `*.html`, `styles.css`) and the Firebase web config
  (`config.js`) are served to every visitor's browser. Publishing them in a public repo
  exposes nothing that loading the site would not.
- **The Firebase `apiKey` is not a secret.** It identifies the project; it is not a
  credential. Access is enforced by the rules, not by hiding the key.
- **Approved devices, programs, reference cycles, comments, and ratings** are world-readable
  (that is the point). The store is organized as `devices` -> `profiles` -> `cycles` flat
  collections with deterministic parent-ID references.

## What is protected

- **Admin actions** (approve/reject/remove, ban/unban, delete) require the caller's UID to
  exist in the `admins` collection. That collection is not client-writable - admins are added
  only via the Firebase console. The `admin.html` page being public does not grant access;
  every action is checked server-side by the rules.
- **Self-approval is impossible.** Changing a device's, program's, or cycle's `status` to
  `approved` is allowed only for admins. An uploader can delete their own reference cycle but
  cannot approve it or alter other fields.
- **Contributing requires a GitHub sign-in.** Upload, comment, and rating writes are gated on
  `sign_in_provider == 'github.com'`. Anonymous sessions (used by the read-only integration
  client) can browse approved content but cannot write.
- **Bans are enforced server-side and cannot be self-reverted.** A user cannot modify their
  own moderation fields (`banned`, `banReason`, ...); only an admin can. Banned users cannot
  upload, comment, or rate.
- **User records are private.** A signed-in user can read only their own `users` document;
  admins can read all. No email addresses are stored (only the public GitHub display name and
  avatar used for attribution).
- **Field validation** (types, length caps, allowed appliance types, `*_lc` consistency) is
  enforced by the rules on create, so malformed or oversized documents are rejected regardless
  of what a client sends.
- **Ratings cannot be forged.** Each user has exactly one rating document (keyed by their UID,
  value constrained to 1-5) in a cycle's `ratings` subcollection. There is no denormalized
  average stored on the cycle. The displayed average and count are computed at read time with a
  server-side aggregation query over that subcollection, so they always reflect the real
  per-user ratings.
- **The `qc` provenance code is obscured, not secret.** Each cycle carries an integer
  provenance hint (how the recording was produced) that only the admin UI decodes to a label.
  Because approved cycles are world-readable, this is deliberate obscurity for a low-stakes
  moderation signal, not access control - do not treat it as private.

## Document size

Firestore enforces a hard **1 MiB (about 1.05 MB) per-document limit** server-side. That is
the real backend ceiling and it cannot be raised - a 5 MB document simply cannot be created in
Firestore. WashData Store therefore keeps documents small:

- The client rejects an upload larger than ~900 KB (`MAX_DOC_BYTES` in `washstore.js`) with a
  clear message, before it reaches the backend.
- The rules cap the raw cycle trace at 3000 points and bound every metadata string, so a
  direct-API caller still cannot create a document anywhere near the 1 MiB limit with valid
  data.
- Any oversized or malformed write is rejected by Firestore. Uploads that do get through always
  land in `pending` (never public) and can be deleted by a moderator.

If you ever need to store payloads larger than ~1 MiB (e.g. full-resolution raw traces), that
requires Cloud Storage, which needs the Blaze plan - out of scope for the zero-cost design.

## Rate limiting and quota

There is no application server, so true server-side rate limiting is not available without
Cloud Functions (Blaze) or Firebase App Check. The current controls:

- **Client-side throttle (best-effort).** `washstore.js` limits writes to 20 per rolling minute
  per browser session and counts each cycle's download at most once per session. This stops
  accidental or casual flooding through the UI. It is **not** a security control - a scripted
  client that bypasses the UI is unaffected.
- **Public download counter** remains an unauthenticated `+1`. A determined script could still
  spend the daily free write quota. Impact is bounded: on the Spark plan, quota exhaustion just
  pauses writes until the next day (no bill, no data loss), and the counter is a vanity metric.

For real server-side protection against scripted abuse, enable
[Firebase App Check](https://firebase.google.com/docs/app-check) (reCAPTCHA provider for the web
app). Note that enforcing App Check will block the anonymous Python read client unless it is
given a debug/exempt token, so enable enforcement deliberately. Also set a Firestore usage
budget alert in the Google Cloud console so you are notified of unusual traffic.

## Operator hardening checklist

1. **Restrict the API key.** In Google Cloud Console → APIs & Services → Credentials, add an
   HTTP referrer restriction so the web key works only from your site's domain.
2. **Keep the admin list small** and add admins only via the Firebase console.
3. **Watch Firestore usage** in the Firebase console if you suspect abuse; consider App Check
   if the public counter or anonymous reads are targeted.
4. **Never commit real secrets.** The only true secret (the GitHub OAuth Client Secret) lives
   in the Firebase console, never in this repo.

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the maintainer directly. Please
do not file public issues for exploitable vulnerabilities.
