# WashData Store

A free, community-run store for sharing appliance power-cycle envelopes for the
[ha_washdata](https://github.com/3dg1luk43/ha_washdata) Home Assistant integration.

Record one clean cycle on your machine, upload the resulting envelope tagged by brand,
model, and program, and others can download the matching profile instead of recording it
themselves. Browsing and downloading are open to everyone; you only sign in (with GitHub) to
contribute, comment, or rate.

## What it does

- **Browse** a library of appliance profiles, filtered by appliance type and brand, each
  shown with a power-cycle waveform preview.
- **Download** an envelope as JSON and import it into ha_washdata so your appliance's cycle
  detection works without a manual recording run.
- **Contribute** your own recorded envelopes (reviewed before they appear publicly).
- **Rate and comment** on envelopes to flag which profiles work well.

## Appliance types

Washer, dryer, dishwasher, and washer-dryer.

## How ha_washdata reads the store

The integration pulls approved envelopes directly over a read-only API, filtered by appliance
type and brand. Each envelope carries an `envelopeSchemaVersion`, so older downloads keep
working when the envelope format evolves - the integration decodes each version it supports
and skips the rest.

## Contributing an envelope

1. In ha_washdata, record and export the envelope for a program you want to share.
2. Sign in to the store with your GitHub account.
3. Open **Upload**, fill in the appliance details, and attach the envelope JSON (optionally a
   raw power trace).
4. Submit. Your upload is reviewed by a moderator before it appears in the public library.

Contributions are moderated to keep the library clean. Uploads stay private to you until
approved.

## Privacy and trust

- Sign-in uses your GitHub account. The store keeps only your public GitHub display name and
  avatar, shown as attribution on your uploads.
- Browsing and downloading need no account.
- Envelopes describe an appliance's power curve. They contain no personal data beyond the
  attribution name you sign in with.

## Project status

Community project, hosted at zero cost on static hosting plus a free-tier backend. No ads, no
tracking, no paid tier.

## License

See [LICENSE](LICENSE) if present, otherwise treat as all-rights-reserved pending a license
declaration by the maintainer.
