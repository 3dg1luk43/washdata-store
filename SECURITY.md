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
- **Approved envelopes, comments, and ratings** are world-readable (that is the point).

## What is protected

- **Admin actions** (approve/reject/remove, ban/unban, delete) require the caller's UID to
  exist in the `admins` collection. That collection is not client-writable - admins are added
  only via the Firebase console. The `admin.html` page being public does not grant access;
  every action is checked server-side by the rules.
- **Self-approval is impossible.** Changing an envelope's `status` to `approved` is allowed
  only for admins. An uploader can edit their own `notes` and nothing else.
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

## Residual and accepted risks

- **Download counter is a public, unauthenticated `+1`.** Anyone can inflate it, and a script
  could spend the project's daily free write quota by spamming increments. Impact is bounded:
  on the Spark free plan quota exhaustion just pauses writes until the next day (no bill, no
  data loss), and the counter is a vanity metric. Mitigations if abused: enable
  [Firebase App Check](https://firebase.google.com/docs/app-check), or drop the public counter.
- **Rating aggregate is best-effort.** The per-user rating in the `ratings` subcollection is
  authoritative and constrained (1-5, one per user). The denormalized `avgRating`/`ratingCount`
  on the envelope is client-written and bounded (0..count, 1..5 avg) but not proven to match
  the subcollection, because Firestore rules cannot aggregate across documents. A determined
  signed-in user could skew a displayed average. To eliminate this, compute the average at read
  time from the `ratings` subcollection, or aggregate it in a Cloud Function (requires the Blaze
  plan). Low stakes for a community library.
- **Direct-API document size.** The client guards uploads at ~800 KB, but a caller hitting the
  API directly is bounded only by Firestore's 1 MiB hard per-document limit and the field caps
  in the rules. Oversized uploads still land in `pending` (never public) and cost storage until
  a moderator deletes them.

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
