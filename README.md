# WashData Store

A free, community-run store for sharing appliance power-cycle **reference recordings** for
the [ha_washdata](https://github.com/3dg1luk43/ha_washdata) Home Assistant integration.

Record one clean cycle on your machine, upload the raw power trace tagged by brand, model,
and program, and others can download it to seed their own profile instead of recording from
scratch. Browsing and downloading are open to everyone; you only sign in (with GitHub) to
contribute, comment, or rate.

## How it is organized

The store is a three-level library:

- **Device** - an appliance (brand + model + type). Star it to save it to your favorites.
- **Program** - a wash program on that device (e.g. "Cotton 40").
- **Reference cycles** - the individual clean recordings people have contributed for that
  program.

Two people with the same appliance and program automatically land on the same device and
program, so their recordings gather in one place.

## What it does

- **Browse** devices, drill into a program, and see its reference cycles - each with a
  power-cycle waveform preview.
- **Download** a reference cycle as JSON and import it into ha_washdata; the integration
  rebuilds the matching envelope locally from it.
- **Contribute** your own clean recordings (reviewed before they appear publicly).
- **Rate and comment** on reference cycles to flag which ones work well.
- **Favorite** devices for quick access.

## Appliance types

Washer, dryer, dishwasher, and washer-dryer.

## How ha_washdata reads the store

The integration pulls approved reference cycles over a read-only API, filtered by device and
program. Each cycle carries a `cycleSchemaVersion`, so older downloads keep working when the
trace format evolves - the integration decodes each version it supports and skips the rest.
The integration always computes the envelope locally from the raw trace; the store never
ships a precomputed envelope.

## Contributing a reference cycle

1. In ha_washdata, take a clean golden cycle for the program you want to share (or use the
   in-integration "Share to store" action once online features are enabled).
2. Sign in to the store with your GitHub account.
3. Open **Upload**, fill in the appliance details, and attach the cycle file (JSON array of
   `[seconds, watts]` pairs, or a two-column CSV).
4. Submit. Your upload is reviewed by a moderator before it appears in the public library.

Contributions are moderated to keep the library clean. Uploads stay private to you until
approved.

## Privacy and trust

- Sign-in uses your GitHub account. The store keeps only your public GitHub display name and
  avatar, shown as attribution on your uploads.
- Browsing and downloading need no account.
- Reference cycles describe an appliance's power curve over time. They contain no personal
  data beyond the attribution name you sign in with.

## Project status

Community project, hosted at zero cost on static hosting (GitHub Pages) plus a free-tier
backend (Firebase). No ads, no tracking, no paid tier.

Idea by [oli-z](https://github.com/oli-z). Developed by
[3dg1luk43](https://github.com/3dg1luk43). Copyright (C) 2026.

## License

See [LICENSE](LICENSE) if present, otherwise treat as all-rights-reserved pending a license
declaration by the maintainer.
