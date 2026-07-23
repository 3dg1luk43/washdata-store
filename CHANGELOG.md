# Changelog

All notable changes to the WashData Store will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The WashData Store is the free, community-run catalog behind the
[ha_washdata](https://github.com/3dg1luk43/ha_washdata) Home Assistant integration: a place
to share and adopt appliance power-cycle reference recordings so nobody has to teach every
washing-machine program from scratch. It is a static site hosted on GitHub Pages, backed by
Firebase Firestore, with no ads, no tracking, and no paid tier.

## 1.2.0 (2026-07-23)

Read-budget optimization. The store runs on Firebase's free tier (a fixed number of
document reads per day), and ordinary browsing was reading far more than it needed to. This
release cuts reads across the board with no change to what visitors see.

### Performance

- **The brand and device catalog is cached in the browser**: The browse grid re-queried the
  full brand and device listings on every page load, reload, and back-navigation, and the
  contribute page queried the brand list again. These public, slow-changing listings are now
  cached in `sessionStorage` for 5 minutes (shared between the browse and contribute pages,
  and surviving reloads), so repeat views cost no reads. Contributing a brand or device
  clears the cache immediately so the new entry shows up right away.
- **Ratings are read from a denormalized aggregate instead of a per-item query**: A cycle's
  and a device's star rating (average + count) used to be computed with one aggregation query
  *per card*, and a program's rating read its entire cycle list plus one query per cycle. The
  running total (`ratingSum` + `ratingCount`) is now stored on the cycle and device documents
  and maintained, un-gameably, in the same write that saves a rating (mirroring the confirm
  counter) — so browse cards and the derived program rating read it straight off documents
  already fetched, for zero extra reads. Cards fall back to the live query only for items that
  predate the backfill.
- **The site-config document is read once per page load**: The maintenance flag and the
  confirm threshold were each read separately at startup (two identical reads). Concurrent
  readers now share a single fetch. The value is still never cached across loads, so the
  maintenance flag stays current.
- **"Recalculate counts" is gated behind a confirmation**: The admin recount reads every
  brand, device, profile, and cycle in one pass (thousands of reads) — it now asks for
  confirmation and explains the cost, since the counters are normally kept correct
  automatically and it is only needed to repair drift. It also backfills the new rating
  aggregate.
- **The moderation queue dedupes contributor lookups**: A spam wave (one contributor, many
  reported objects) re-read the same user document once per report card; the Reports tab now
  caches contributor lookups per queue load.

### Changed

- **Security rules**: cycle and device documents now allow a signed-in user to maintain the
  `ratingSum`/`ratingCount` aggregate, but only in the same batch that writes that user's own
  rating document and only by the exact amount implied by their rating (a first rating adds
  one to the count and their value to the sum; an edit shifts only the sum). This mirrors the
  existing honest confirm-counter rule, so the aggregate cannot be forged. Covered by new
  emulator rules tests.

> **Deploying this release:** after publishing the site, deploy the rules
> (`firebase deploy --only firestore:rules`) and run **Recalculate counts** once in the admin
> panel to backfill `ratingSum`/`ratingCount` on existing cycles and devices. Until then,
> ratings fall back to the live aggregation query, so nothing breaks in the interim.

## 1.1.0 (2026-07-20)

### Added

- **Content reporting**: Any signed-in contributor can report a brand, device, program, cycle, or comment, choosing a reason (spam, wrong data, offensive, duplicate, or other) and adding a comment. Reports are private (only moderators can read them) and limited to one per user per object, enforced in the security rules.
- **Moderation review queue**: A new **Reports** tab in the admin panel consolidates every report filed against the same object into one card, so all reporters' comments sit in one place. From the card a moderator can hide the object (soft-remove), delete it permanently, dismiss the reports, or ban the contributor - and sees the object's live status and the contributor's strike count before acting.
- **Repeat-offender tracking**: Removing or deleting a contribution records a strike on the contributor's account (`removedContentCount`). Strikes surface in the review card and as a "Removed" column in the Users tab so repeat offenders are easy to spot.

### Changed

- **Admin Users tab**: Adds a total/banned user count, a status filter (all / active / banned), a sort (newest / most removed), a removed-content strike column, and UID search.
- **Admin Statistics tab**: Adds catalog totals - total users, brands, devices, programs, and cycles.

## 1.0.0 (2026-07-16)

Everything below is the initial build, accumulating toward the first public release. The

### Added

- **Community catalog with a four-level hierarchy**: Brand → Device (model + appliance type) → Program → Reference cycles. Two people with the same appliance and program land on the same entry, so their recordings gather in one place.
- **Browse and download without an account**: The full public catalog is readable anonymously. Reference cycles download as JSON for import into ha_washdata.
- **Sign in with GitHub for contributions**: GitHub OAuth is required only to contribute (upload, confirm). The store keeps just your public GitHub display name and avatar URL, shown as attribution.
- **Contribute reference cycles**: Upload a power-time trace as a JSON array of `[seconds, watts]` pairs or a two-column CSV, from the web contribute page or directly from the ha_washdata panel's share flow.
- **Community confirmation and auto-promotion**: Every new brand, device, program, and cycle starts as **pending**. When five distinct GitHub users confirm an entry it is auto-promoted to **approved** with no moderator action needed. The threshold is admin-tunable (`config/site.confirmThreshold`).
- **Admin moderation panel**: Approve, reject, or delete any entry; merge duplicate devices; ban abusive accounts (enforced in the security rules, not just the UI); and adjust the auto-approve threshold. Pending entries are sorted first for review.
- **Device packages**: A device bundles its program list and their approved reference cycles, plus optional cycle phase maps and optional detection/matching settings shared by the device owner. Contributors choose what to include on upload; adopters choose what to apply.
- **Owner editing in the public view**: The declared owner of a device can edit its per-profile phase maps and shared settings after the fact, without going through the admin panel.
- **Interactive graph previews and profile merge**: Reference cycles render as interactive power-time graphs before you download them; near-duplicate profiles can be merged.
- **Auth-handoff page for the integration** (`connect.html`): Lets the ha_washdata panel link a GitHub account in one round trip so sharing works from inside Home Assistant.
- **Documentation**: A README rewrite plus an in-store docs page (`docs.html`) that renders the README live.
- **Firestore security-rules test suite**: Rules are covered by `@firebase/rules-unit-testing` against the emulator (`npm run test:rules`), alongside unit tests for the deterministic-ID and trace pack/stats helpers (`npm run test:unit`).
- **Privacy by design**: No analytics, no ad tracking, no third-party marketing scripts. Reference cycles carry only power measurements over time; sign-in stores only the public GitHub display name and avatar.
- **Project infrastructure**: AGPL-3.0-or-later license with a per-file header on every source file, `CONTRIBUTING.md`, a CI workflow (unit + rules tests, JSON-config validation, license-header enforcement), issue and pull-request templates, and community-management workflows (issue/PR validation, auto-assign, and stale-issue/PR housekeeping) mirroring the ha_washdata integration's contributor flow.

### Changed

- **Data model migrated v1 → v2**: v1 stored a single flat `envelopes` collection where the shared unit was a computed envelope. v2 stores the `devices → profiles → cycles` hierarchy where the shared unit is a raw reference cycle, so multiple recordings accumulate under one program. An optional, idempotent migration script (`scripts/migrate_v1_to_v2.mjs`) converts existing v1 data; most deployments with no real v1 data can just deploy v2.
- **Reference-cycle trace storage**: Traces are stored as `{o, w}` offset/watts maps rather than nested arrays, because Firestore forbids nested arrays.
- **Cycle quality control moved to the community**: Reference cycles are community-voted rather than requiring up-front admin review, with server-side aggregation of confirmation counts.

### Performance

- **Public browse reads via the Firestore REST API** instead of the Firebase SDK, cutting page weight and per-card fetches; admin reads also go through authenticated REST.
- **Throttled `lastSeen` writes** and removed per-card rating fetches in favour of server-side aggregation.

### Infrastructure

- **GitHub Pages deploy workflow**: Every push to `main` stamps local assets with a deploy timestamp (cache-bust) and publishes the assembled static site to GitHub Pages.
