# WashData Store

The WashData Store is a free, community-run library of appliance power-cycle reference recordings for the [ha_washdata](https://github.com/3dg1luk43/ha_washdata) Home Assistant integration. Instead of spending weeks recording your own washing machine programs from scratch, you can download a clean reference cycle that someone else already recorded on the same appliance, seed your local profile instantly, and start getting match results and time-remaining estimates straight away. Everything is hosted at zero cost -- GitHub Pages for the frontend, Firebase Firestore for the backend -- so there are no subscriptions and no ads. Aggregate usage (downloads, page views, searches) is counted with anonymous counters to help maintain the library; no personal data or browsing profiles are stored.

## How it is organized

The library has four levels:

- **Brand** -- the appliance manufacturer (e.g. Bosch, Miele, Samsung).
- **Device** -- a specific model within that brand (e.g. "WAU28T40GB"), tagged with its appliance type (washer, dryer, dishwasher, washer-dryer combo).
- **Program** -- a wash or dry program on that device (e.g. "Cotton 60", "Eco 40-60", "Quick 30").
- **Reference cycles** -- individual clean recordings contributed for that program. Each is a power-time trace (watts vs. seconds) uploaded by a community member.

Two people with the same appliance and the same program land on the same Device and Program entry, so their recordings gather in one place and each one makes the next person's setup easier.

---

## Browsing and adopting

No account is needed to browse. Open the store, pick a brand, drill into a device and program, and open a reference cycle's **Details** to see its power graph and stats. The website has no download button: you import cycles in ha_washdata, from the panel's **Store** tab, to seed a profile.

The search box at the top searches the whole library at once - brands, appliances, programs and reference cycles - and matches anywhere in a brand, model or program name, not just the start, so `wm14` finds `iQ300 WM14N292` (reference cycles match on the start of their program name). Every word you type has to appear somewhere, so `siemens dishwasher` narrows across the brand and the appliance type together.

For a faster path, use the built-in adopt flow in the ha_washdata panel: when the store has a matching device, the panel offers a one-click **Download this setup** button that imports a full device package directly into your integration without leaving Home Assistant.

Signed-in users can **favorite** a device with the star on its card. The browse view has a **Favorites only** filter alongside the search, approved-only and minimum-rating filters, so a shortlist of candidate models stays one click away.

**What a device package includes:**

- All programs listed for that device
- All reference cycles for each program, pending ones included
- Optional cycle phase maps (pre-wash, main wash, rinse, spin, and so on)
- Optional detection and matching settings shared with that appliance

When you adopt, you choose whether to apply the optional settings or keep your own.

---

## Contributing

Contributions require a GitHub account. Your name is shown on what you add only if you choose to show it; see Privacy below for what is stored.

**From the web:**

1. Open the store and sign in with GitHub.
2. If your brand or device does not exist yet, use **Add brand** or **Add appliance** to create it.
3. Open your device and, if your program is missing, add it with **Add profile**.
4. New entries are marked pending until they clear the approval process (see below).

Reference cycles cannot be uploaded on the website: share them from the ha_washdata panel.

**From the ha_washdata panel (recommended):**

1. In ha_washdata, open the panel for your device.
2. Open the gear (Preferences) in the panel header, go to **Online & Community** and turn on **Enable online features** (Home Assistant admins only).
3. Click **Connect GitHub** there (a one-time step for all your devices).
4. On the Cycles tab, open a reference cycle (⭐) and click **Share to store**. **Share this device**, next to the appliance in Settings, shares several programs at once.
5. Brand and model come from the device's Settings (**Appliance Brand** and **Appliance Model** must be set); the program is pre-selected from the cycle's profile. Review and click **Share**.

**Removing a cycle you shared:** sign in on the website, open the program, and press **Delete** on your cycle (on its card or in its details). Its ratings, confirmations and comments are deleted with it. Brands, appliances and programs are shared by everyone, so only a moderator can delete those.

---

## The approval system

Every new entry -- brand, device, program, or reference cycle -- starts as **pending**. Pending entries are public: they are searchable with an "awaiting approval" tag, and the ha_washdata integration can download them.

A device or reference cycle is promoted to **approved** automatically when enough distinct GitHub users confirm it (five by default). Any signed-in user can click **Confirm this appliance** or **Confirm this cycle** on a pending entry's card if it looks correct. When the count reaches the threshold the entry is auto-approved instantly, with no moderator action needed. A brand is approved once enough of its devices are; programs are approved by a moderator.

Each user can confirm an entry once, so the vote count cannot be inflated. Moderators can also approve, remove or restore entries.

---

## Device packages

A device package bundles everything associated with a device:

| Contents | Required |
|---|---|
| Program list | Yes |
| Reference cycles for each program | Yes |
| Cycle phase maps | No |
| Detection and matching settings | No |

When you share a device from the ha_washdata panel you control what is included. When you adopt a package you choose whether its settings are applied; programs, cycles and phase maps are always added.

---

## Appliance types

The store supports: **washer**, **dryer**, **dishwasher**, **washer-dryer combo**. The Other (Advanced) and Threshold Device types can import reference cycles from the store but cannot share to it, because the catalog has no matching appliance type.

---

## Integration with ha_washdata

The ha_washdata panel has built-in store integration once online features are enabled (gear menu, **Online & Community**). Everything works directly inside Home Assistant:

- **Browse** the store catalog filtered to your device type
- **Adopt** a device package with one click
- **Share** a cycle to the store from the Cycles tab
- **Confirm** and rate your appliance's catalog entry from within the panel

Online features are one opt-in for the whole install (off by default); sharing, confirming and rating need a one-time GitHub account link.

---

## Cycle data format

Reference cycles are stored as a sequence of `(offset_seconds, watts)` samples.

Before sharing, ha_washdata downsamples each cycle to at most 10,000 points using LTTB (Largest Triangle Three Buckets). LTTB preserves peaks and troughs by selecting the most visually significant sample in each bucket rather than picking by index, so narrow transients (heater pulses, pump-out spikes) are retained rather than silently dropped. Statistics -- duration, energy in Wh, peak watts, mean watts -- are computed by ha_washdata from its own cycle record and the full-resolution trace, before downsampling.

---

## Privacy

- Sign-in uses GitHub OAuth. The store keeps a private user record (your account uid, GitHub display name, username and avatar URL, sign-in times and favorites) that only you and the moderators can read.
- Everything you add (brands, appliances, programs, cycles, comments, ratings, confirmations) carries your account uid, which is public. Your display name is shown on brands, appliances and shared cycles only if you opt in ("Show my GitHub name" on the website, "Show my name on what I share" in ha_washdata); comments always show it.
- Browsing and downloading require no account and leave no personal trace.
- Reference cycles contain only power measurements over time. They carry no location data, usage habits, or personal information beyond the uploader's account uid and, if they chose to show it, their display name.
- Aggregate store usage (downloads, page views, searches) is counted with anonymous Firestore counters. No user IDs, cookies, or browsing profiles are stored. No ad-tech, no third-party marketing scripts.
- All Firestore security rules are [public](https://github.com/3dg1luk43/washdata-store/blob/main/firestore.rules) and auditable.

---

## Architecture

The store has no server process. It is:

- **Frontend:** vanilla ES modules, no bundler, no framework.
- **Backend:** Cloud Firestore. The [security rules](https://github.com/3dg1luk43/washdata-store/blob/main/firestore.rules) are the entire access-control layer.
- **Hosting:** GitHub Pages (static files only).
- **Auth:** Firebase Auth with GitHub OAuth, needed only to contribute.

Development setup and tests are covered in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Project status

Community project. Hosted on GitHub Pages (static site, zero cost) backed by Firebase Firestore (free tier). No ads, no paid tier, no subscriptions. Aggregate usage is counted with anonymous counters (no personal data).

- **Store site:** [3dg1luk43.github.io/washdata-store](https://3dg1luk43.github.io/washdata-store)
- **Integration:** [ha_washdata on GitHub](https://github.com/3dg1luk43/ha_washdata)

Idea by [oli-z](https://github.com/oli-z). Developed by [3dg1luk43](https://github.com/3dg1luk43). Copyright (C) 2026.

---

## License

Licensed under the [GNU Affero General Public License v3.0 or later](https://github.com/3dg1luk43/washdata-store/blob/main/LICENSE) (AGPL-3.0-or-later). Any modified version you run as a network service must also be made available as open source under the same license.
