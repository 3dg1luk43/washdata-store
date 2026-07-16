# WashData Store

The WashData Store is a free, community-run library of appliance power-cycle reference recordings for the [ha_washdata](https://github.com/3dg1luk43/ha_washdata) Home Assistant integration. Instead of spending weeks recording your own washing machine programs from scratch, you can download a clean reference cycle that someone else already recorded on the same appliance, seed your local profile instantly, and start getting match results and time-remaining estimates straight away. Everything is hosted at zero cost -- GitHub Pages for the frontend, Firebase Firestore for the backend -- so there are no subscriptions, no ads, and no tracking.

## How it is organized

The library has four levels:

- **Brand** -- the appliance manufacturer (e.g. Bosch, Miele, Samsung).
- **Device** -- a specific model within that brand (e.g. "WAU28T40GB"), tagged with its appliance type (washer, dryer, dishwasher, washer-dryer combo).
- **Program** -- a wash or dry program on that device (e.g. "Cotton 60", "Eco 40-60", "Quick 30").
- **Reference cycles** -- individual clean recordings contributed for that program. Each is a power-time trace (watts vs. seconds) uploaded by a community member.

Two people with the same appliance and the same program land on the same Device and Program entry, so their recordings gather in one place and each one makes the next person's setup easier.

---

## Browsing and adopting

No account is needed to browse or download. Open the store, pick a brand, drill into a device and program, and download any approved reference cycle as JSON. In ha_washdata, import it through the panel to seed a profile.

For a faster path, use the built-in adopt flow in the ha_washdata panel: when the store has a matching device, the panel offers a one-click **Adopt** button that imports a full device package directly into your integration without leaving Home Assistant.

**What a device package includes:**

- All programs listed for that device
- All approved reference cycles for each program
- Optional cycle phase maps (pre-wash, main wash, rinse, spin, and so on)
- Optional detection and matching settings shared by the device owner

When you adopt, you choose whether to apply the optional settings or keep your own.

---

## Contributing

Contributions require a GitHub account. Sign in once; your public GitHub display name and avatar are the only things stored.

**From the web:**

1. Open the store and sign in with GitHub.
2. If your brand or device does not exist yet, use **Add brand** or **Add appliance** to create it.
3. Navigate to your device and the program you want to contribute to, or create the program entry if it does not exist.
4. Click **Upload cycle** and attach your cycle file. Accepted formats: JSON array of `[seconds, watts]` pairs, or a two-column CSV.
5. Submit. The cycle is marked pending until it clears the approval process (see below).

**From the ha_washdata panel (recommended):**

1. In ha_washdata, open the panel for your device.
2. Go to the Advanced tab, open the gear menu, and enable **Online features**.
3. Link your GitHub account when prompted (a one-time step).
4. On the Cycles tab, find a clean golden cycle and click **Share to store**.
5. The panel pre-fills brand, model, and program from your device configuration. Review and submit.

---

## The approval system

Every new entry -- brand, device, program, or reference cycle -- starts as **pending**. Pending entries are visible to signed-in users but not shown in public browsing or to the ha_washdata integration.

An entry is promoted to **approved** automatically when five distinct GitHub users confirm it (the threshold is admin-tunable). Any signed-in user can open a pending entry and click **Confirm** if it looks correct. When the count reaches the threshold the entry is auto-approved instantly, with no moderator action needed.

Confirmation documents are create-only and one-per-user, so the vote count cannot be inflated. Moderators can also approve, reject, or delete entries at any time through the admin panel.

---

## Device packages

A device package bundles everything associated with a device:

| Contents | Required |
|---|---|
| Program list | Yes |
| Reference cycles for each program | Yes |
| Cycle phase maps | No |
| Detection and matching settings | No |

When you share a device from the ha_washdata panel you control what is included. When you adopt a package you control what is applied locally.

---

## Appliance types

The store supports: **washer**, **dryer**, **dishwasher**, **washer-dryer combo**. The Other (Advanced) and Threshold Device types can receive and share reference cycles but have limited community-catalog support and no appliance-type-specific defaults.

---

## Integration with ha_washdata

The ha_washdata panel has built-in store integration once online features are enabled (Advanced tab, gear menu). Everything works directly inside Home Assistant:

- **Browse** the store catalog filtered to your device type
- **Adopt** a device package with one click
- **Share** a cycle to the store from the Cycles tab
- **Confirm** pending community entries from within the panel

Online features are opt-in per device and require a one-time GitHub account link. The panel opens a small popup to the `/connect` page for the one-time GitHub OAuth handoff, and a `/create` popup for adding missing brands or devices -- both post back to the panel via `postMessage`.

---

## Cycle data format

Reference cycles are stored as a sequence of `(offset_seconds, watts)` samples. The store accepts:

- **JSON:** array of `[seconds, watts]` pairs, array of `{t, v}` objects, or `{times, values}` object
- **CSV/TSV:** two columns (time and power); lines starting with `#` are ignored

Internally, cycles are downsampled to at most 10,000 points using LTTB (Largest Triangle Three Buckets) before being stored in Firestore as `{o, w}` map objects (Firestore forbids nested arrays). LTTB preserves peaks and troughs by selecting the most visually significant sample in each bucket rather than picking by index, so narrow transients (heater pulses, pump-out spikes) are retained rather than silently dropped. Statistics -- duration, energy in Wh, peak watts, mean watts -- are derived from the stored trace, so they are always consistent with what you see in the power graph.

The `qc` field records provenance: `1` = raw recording from ha_washdata, `2` = trimmed or edited, `3` = manually composed in the browser. Cycles uploaded from ha_washdata carry the appropriate code automatically.

---

## Privacy

- Sign-in uses GitHub OAuth. The store stores only your public GitHub display name and avatar URL, shown as attribution on your contributions.
- Browsing and downloading require no account and leave no personal trace.
- Reference cycles contain only power measurements over time. They carry no location data, usage habits, or personal information beyond the contributor's public GitHub display name and avatar URL.
- There is no analytics, no ad tracking, and no third-party marketing scripts.
- All Firestore security rules are [public](firestore.rules) and auditable.

---

## Architecture

The store has no server process. It is:

- **Frontend:** vanilla ES modules, no bundler, no framework. Firebase Modular SDK loaded from CDN.
- **Backend:** Cloud Firestore (Firebase free/Spark plan). The security-rules file is the entire access-control layer; admin operations require existence in a server-side `admins` collection not writable via the client.
- **Hosting:** GitHub Pages (static files only).
- **Auth:** Firebase Auth with GitHub OAuth. Contributors must authenticate; public browsing uses the Firestore REST API directly (no WebChannel handshake, faster cold load).
- **Python client:** `washstore_client.py` -- a `requests`-based read-only client used by the ha_washdata integration. It signs in anonymously via the Firebase REST API and queries approved cycles without the JS SDK.

### Data hierarchy

```
brands/{brandId}
devices/{deviceId}
  └─ confirmations/{uid}   (one-way vote, un-gameable)
  └─ ratings/{uid}
profiles/{profileId}
cycles/{cycleId}
  └─ confirmations/{uid}
  └─ comments/{commentId}
  └─ ratings/{uid}
admins/{uid}
users/{uid}
config/site                (maintenance flag, confirmThreshold)
```

Device and profile IDs are **deterministic**: two contributors with the same brand, model, and program produce identical IDs, so their cycles accumulate in one place automatically. IDs are derived by normalizing tokens with NFKD + diacritic stripping + non-alphanumeric collapsed to hyphens; non-Latin scripts are preserved to avoid empty-token collisions.

---

## Development setup

```bash
npm install                        # install test dependencies
npm run test:unit                  # unit tests for lib/ids.js and lib/trace.js
npm run test:rules                 # Firestore security-rules tests (requires Firebase emulator)
npm run stamp                      # cache-bust asset URLs before committing frontend changes
```

### Seeding local data

```bash
# Insert sample approved cycles for design/dev testing (requires service-account credentials)
node scripts/seed_sample.mjs

# One-time migration from v1 flat `envelopes` collection to v2 hierarchy (idempotent)
node scripts/migrate_v1_to_v2.mjs
```

### Deployment

Every push to `main` triggers the deploy workflow: it stamps a timestamp onto every local asset URL for cache-busting, assembles the static site into `dist/`, and publishes to GitHub Pages. No build step or bundler is involved.

---

## Project status

Community project. Hosted on GitHub Pages (static site, zero cost) backed by Firebase Firestore (free tier). No ads, no tracking, no paid tier, no subscriptions.

- **Store site:** [3dg1luk43.github.io/washdata-store](https://3dg1luk43.github.io/washdata-store)
- **Integration:** [ha_washdata on GitHub](https://github.com/3dg1luk43/ha_washdata)

Idea by [oli-z](https://github.com/oli-z). Developed by [3dg1luk43](https://github.com/3dg1luk43). Copyright (C) 2026.

---

## License

Licensed under the [GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later). Any modified version you run as a network service must also be made available as open source under the same license.
