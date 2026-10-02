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
- **Approved and pending catalog content is world-readable.** Brands, devices, programs
  (`profiles`) and reference cycles in `pending` status are public and searchable with an
  "awaiting approval" tag, and the integration downloads them by default. Only `removed`
  content is hidden. Comments and ratings are world-readable. The store is organized as
  `brands` / `devices` -> `profiles` -> `cycles` flat collections with deterministic
  parent-ID references.

## What is protected

- **Admin actions** (approve/reject/remove, ban/unban, delete, rename/merge, owner assignment)
  require the caller's UID to exist in the `admins` collection. That collection is not
  client-writable - admins are added only via the Firebase console. The `admin.html` page
  being public does not grant access; every action is checked server-side by the rules.
- **No self-approval.** Every contributor create must be `status: 'pending'`. Approval of a
  device or cycle is a community vote: any GitHub user may flip `pending -> approved` once its
  `confirmCount` reaches `config/site.confirmThreshold` (admin-tunable, default 5). Each user
  confirms at most once (a uid-keyed confirmation doc created in the same batch as the +1).
  A brand is promoted the same way once enough of its devices are approved
  (`brandConfirmThreshold`). Programs are approved by admins only. An uploader can delete their
  own reference cycle but cannot edit it.
- **Contributing requires a GitHub sign-in.** Every catalog, comment, rating, confirmation and
  report write is gated on `sign_in_provider == 'github.com'`. The only anonymous writes are
  the `downloads` +1 on a cycle and the bounded `analytics` counters. The integration reads
  anonymously and writes only through the user's connected GitHub account.
- **Bans are enforced server-side and cannot be self-reverted.** The moderation fields on
  `users/{uid}` (`status`, `banReason`, `bannedAt`, `bannedBy`, `removedContentCount`,
  `lastRemovalAt`) are admin-only, and a user cannot pre-seed them when their record is
  created. Banned users cannot contribute, comment, confirm, rate or report.
- **User records are private.** A signed-in user can read only their own `users` document;
  admins can read all. A self-created record holds only the uid, the public GitHub display
  name / login / avatar, timestamps, status and favorites (no email).
- **Creates are shape-validated.** For brands, devices, programs, cycles, users and reports the
  rules pin the exact field list, the types and length caps, the allowed appliance types and
  `*_lc` consistency. Catalog ids must be the normalized `type__brand__model[__program]` form
  and nest under their parent; a program's device and a cycle's program must exist, and a
  cycle's program must belong to the cycle's device. A creator cannot set `ownerId`, rating
  aggregates or counters (they must be absent or zero). Cycle `stats` and `trace` fields must
  be finite numbers. Owner edits are validated too: device `settings` accept only the shared
  setting keys with non-negative numbers, and phase maps are bounded.
- **What the rules cannot check.** Rules cannot loop over a list, so the interior of a cycle's
  point list and the elements of a phase map are only bounded (length, plus the first and last
  point), and documents written before this validation existed were never re-checked. Every
  consumer therefore treats stored data as untrusted: the website escapes every string and
  coerces every number before rendering, and the integration validates traces on import.
- **Script injection is contained.** Every page carries a Content-Security-Policy that allows
  no inline script and only the script origins the page needs (Firebase on `www.gstatic.com`
  and `apis.google.com`, Google Analytics on the browse page if enabled, the Markdown renderer
  on `cdn.jsdelivr.net` for the docs and changelog pages).
- **Ratings cannot be forged.** Each user has exactly one rating document (keyed by their UID,
  value constrained to 1-5) per cycle or device. The denormalized `ratingSum` / `ratingCount`
  on the parent may move only in the same batch as that user's rating doc, by exactly that
  rating's contribution. Documents without the aggregate fall back to a live aggregation over
  the subcollection.
- **Counters are tied to real contributions.** `favoriteCount` moves by one only in the batch
  that adds the device to (or removes it from) the caller's own favorites list, so each user
  counts once. `deviceCount` / `profileCount` / `cycleCount` may rise by one only in the batch
  that creates the counted child, which the write names (`lastDeviceId` / `lastProfileId` /
  `lastCycleId`). Decrements are admin-only. The integration does not maintain these counters,
  so they undercount what it contributes.
- **The `qc` provenance code is obscured, not secret.** Each cycle carries an integer
  provenance hint (how the recording was produced) that only the admin UI decodes to a label.
  Because cycles are world-readable, this is deliberate obscurity for a low-stakes
  moderation signal, not access control - do not treat it as private.

## Document size

Firestore enforces a hard **1 MiB (about 1.05 MB) per-document limit** server-side. That is
the real backend ceiling and it cannot be raised - a 5 MB document simply cannot be created in
Firestore. WashData Store therefore keeps documents small:

- The rules cap a cycle trace at 10000 points, a program description at 2000 characters, a
  phase map at 50 entries, and bound every metadata string. The integration downsamples traces
  before upload.
- Anything larger than 1 MiB is rejected by Firestore itself. Uploads land in `pending`,
  which is publicly readable until a moderator removes them.

If you ever need to store payloads larger than ~1 MiB (e.g. full-resolution raw traces), that
requires Cloud Storage, which needs the Blaze plan - out of scope for the zero-cost design.

## Rate limiting and quota

There is no application server, so true server-side rate limiting (per-client write throttling
or quotas) is not available without Cloud Functions (Blaze). Firebase App Check (below) is an
abuse-mitigation control, not a rate limiter. The current controls:

- **Client-side throttle (best-effort).** `washstore.js` limits writes to 20 per rolling minute
  per browser session and counts each cycle's download at most once per session. This stops
  accidental or casual flooding through the UI. It is **not** a security control - a scripted
  client that bypasses the UI is unaffected.
- **Public download and analytics counters** remain unauthenticated `+1` writes. A determined
  script could still spend the daily free write quota. Impact is bounded: on the Spark plan, quota exhaustion just
  pauses writes until the next day (no bill, no data loss), and the counter is a vanity metric.

To mitigate scripted abuse, enable
[Firebase App Check](https://firebase.google.com/docs/app-check) (reCAPTCHA provider for the web
app). App Check is attestation, not rate limiting: it blocks clients that cannot prove they are
your genuine web app, but it does not throttle a verified client's request rate. Enforcing it is
a deliberate trade-off, because the anonymous Python read client cannot attest and will be
blocked. If you need both App Check enforcement and anonymous reads, serve those reads through a
dedicated public-read path rather than a debug/exempt token (debug tokens are for local
development only, never a production fallback). Also set a Firestore usage budget alert in the
Google Cloud console so you are notified of unusual traffic.

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
