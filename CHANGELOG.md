# Changelog

All notable changes to the WashData Store will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The WashData Store is the free, community-run catalog behind the
[ha_washdata](https://github.com/3dg1luk43/ha_washdata) Home Assistant integration: a place
to share and adopt appliance power-cycle reference recordings so nobody has to teach every
washing-machine program from scratch. It is a static site hosted on GitHub Pages, backed by
Firebase Firestore, with no ads, no tracking, and no paid tier.

## Unreleased

### Added

- **One search bar for the whole library**: searches brands, appliances, programs and reference cycles at once, grouped by kind. Matching is substring and multi-token: `wm14` finds `iQ300 WM14N292`, and `siemens dishwasher` matches across brand and appliance type. New contributions are searchable within a minute, your own immediately.
- **A-Z brand directory on the landing page**: every brand, alphabetical, with a jump bar. One typed letter filters the directory; two or more run the library search.
- **Back button, refresh and shareable links**: brand, appliance, program, cycle and search views each have their own URL, so Back walks through the catalog instead of leaving the site. A link to an entry that no longer exists shows "Not found".
- **Brand page header** with status, approval progress, totals and the Report action.
- **Brands auto-approve on their models**: a brand is approved once enough of its appliances are. Brand cards show the progress (`Pending - 1/3 models`).
- **Delete a cycle you shared**: signed in, your own reference cycles show **Delete** on the card and in the details window. Its ratings, confirmations and comments go with it.
- **Automation templates page**: lists the Home Assistant blueprints from [washdata-automations](https://github.com/3dg1luk43/washdata-automations), with search, an appliance filter, details and an **Import with My Home Assistant** link.

### Changed

- **Device pages load faster**: the program ratings no longer download every reference cycle's trace (a two-cycle program went from 132 KB to under 1 KB).
- **Fewer repeat reads while browsing**: sign-in reads your profile once, and whether you confirmed or rated an item is remembered for the session.
- **Programs with recordings are listed first** on an appliance page, then by name.
- **Duplicate entries are merged, not deleted**: their cycles, ratings, confirmations and favorites move to the surviving entry.

### Fixed

- **Add Appliance's brand autocomplete stopped at the 60th brand** ([#7](https://github.com/3dg1luk43/washdata-store/issues/7)): Siemens, Whirlpool and most brands from "I" on never appeared. It now lists every brand. Thanks to @xathon.
- **The landing page showed only the first 60 brands**: Miele, Siemens, Samsung, Whirlpool and later brands were reachable only through search.
- **A brand's dishwashers were missing from its model list**: Siemens showed 2 of its 31 dishwashers, Bosch 0 of 37. Opening a brand fetched 60 devices and filtered by type in the browser, and dishwashers sorted last. The type filter is now part of the query and the brand view has a working **Load more**.
- **"Pending - 2/3 models" on a brand with four approved models**: brands that already qualify are now approved.
- **Search box got stuck** on an old query after the Brands crumb, and retyping that query did nothing.
- **Search could list programs of removed appliances**, which opened to "Device not found".
- **The Contribute page said brands are reviewed by a moderator**; they auto-approve once enough of their appliances are.

## 1.2.0 (2026-07-23)

### Performance

- **Faster browsing on fewer reads**: the brand and device listings are cached in the browser for 5 minutes (a new contribution clears the cache), star ratings are read from totals stored on each cycle and device instead of one query per card, and the site config is read once per page load.

## 1.1.0 (2026-07-20)

### Added

- **Content reporting**: any signed-in contributor can report a brand, device, program, cycle, or comment, with a reason (spam, wrong data, offensive, duplicate, or other) and a comment. Reports are private to moderators and limited to one per user per object.

## 1.0.0 (2026-07-16)

The initial public release.

### Added

- **Community catalog with a four-level hierarchy**: Brand → Device (model + appliance type) → Program → Reference cycles. Two people with the same appliance and program land on the same entry, so their recordings gather in one place.
- **Browse and download without an account**: the full public catalog is readable anonymously. Reference cycles download as JSON for import into ha_washdata.
- **Sign in with GitHub for contributions**: GitHub OAuth is required only to contribute (upload, confirm).
- **Contribute reference cycles**: upload a power-time trace as a JSON array of `[seconds, watts]` pairs or a two-column CSV, from the web contribute page or directly from the ha_washdata panel's share flow.
- **Community confirmation and auto-promotion**: every new entry starts as **pending**. When five distinct GitHub users confirm it, it is promoted to **approved** with no moderator action needed.
- **Device packages**: a device bundles its program list and reference cycles, plus optional cycle phase maps and detection/matching settings. Contributors choose what to include; adopters choose what to apply.
- **Owner editing**: the owner of a device can edit its phase maps and shared settings after the fact.
- **Interactive graph previews**: reference cycles render as interactive power-time graphs before you download them.
- **Account linking for the integration**: the ha_washdata panel links a GitHub account in one round trip, so sharing works from inside Home Assistant.
- **Documentation**: an in-store docs page that renders the README.
- **Privacy by design**: no analytics, no ad tracking, no third-party marketing scripts. Reference cycles carry only power measurements over time.
- **Open source**: AGPL-3.0-or-later license and a contributor guide (`CONTRIBUTING.md`).
