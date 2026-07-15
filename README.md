# WashData Store

The WashData Store is a free, community-run library of appliance power-cycle reference recordings for the [ha_washdata](https://github.com/3dg1luk43/ha_washdata) Home Assistant integration. Instead of spending weeks recording your own washing machine programs from scratch, you can download a clean reference cycle that someone else already recorded on the same appliance, seed your local profile instantly, and start getting match results and time-remaining estimates straight away. Everything is hosted at zero cost -- GitHub Pages for the frontend, Firebase Firestore for the backend -- so there are no subscriptions, no ads, and no tracking.

## How it is organized

The library has four levels:

- **Brand** -- the appliance manufacturer (e.g. Bosch, Miele, Samsung).
- **Device** -- a specific model within that brand (e.g. "WAU28T40GB"), tagged with its appliance type (washer, dryer, dishwasher, washer-dryer combo).
- **Program** -- a wash or dry program on that device (e.g. "Cotton 60", "Eco 40-60", "Quick 30").
- **Reference cycles** -- individual clean recordings contributed for that program. Each is a power-time trace (watts vs. seconds) uploaded by a community member.

Two people with the same appliance and the same program land on the same Device and Program entry, so their recordings gather in one place and each one makes the next person's setup easier.

## Browsing and adopting

No account is needed to browse or download. Open the store, pick a brand, drill into a device and program, and download any approved reference cycle as JSON. In ha_washdata, import it through the panel to seed a profile.

For a faster path, use the built-in adopt flow in the ha_washdata panel: when the store has a matching device, the panel offers a one-click **Adopt** button that imports a full device package directly into your integration without leaving Home Assistant.

**What a device package includes:**

- All programs listed for that device
- All approved reference cycles for each program
- Optional cycle phase maps (pre-wash, main wash, rinse, spin, and so on)
- Optional detection and matching settings shared by the device owner

When you adopt, you choose whether to apply the optional settings or keep your own.

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

## The approval system

Every new entry -- brand, device, program, or reference cycle -- starts as **pending**. Pending entries are visible to signed-in users but not shown in public browsing or to the ha_washdata integration.

An entry is promoted to **approved** automatically when five distinct GitHub users confirm it. Any signed-in user can open a pending entry and click **Confirm** if it looks correct. When the count reaches the threshold the entry is auto-approved instantly, with no moderator action needed.

Moderators can also approve, reject, or delete entries at any time through the admin panel. Approved entries can be removed if they turn out to be incorrect.

## Device packages

A device package bundles everything associated with a device:

| Contents | Required |
|---|---|
| Program list | Yes |
| Reference cycles for each program | Yes |
| Cycle phase maps | No |
| Detection and matching settings | No |

When you share a device from the ha_washdata panel you control what is included. When you adopt a package you control what is applied locally.

## Appliance types

The store supports: **washer**, **dryer**, **dishwasher**, **washer-dryer combo**. The Other (Advanced) and Threshold Device types can receive and share reference cycles but have limited community-catalog support and no appliance-type-specific defaults.

## Integration with ha_washdata

The ha_washdata panel has built-in store integration once online features are enabled (Advanced tab, gear menu). Everything works directly inside Home Assistant:

- **Browse** the store catalog filtered to your device type
- **Adopt** a device package with one click
- **Share** a cycle to the store from the Cycles tab
- **Confirm** pending community entries from within the panel

Online features are opt-in per device and require a one-time GitHub account link.

## Privacy

- Sign-in uses GitHub OAuth. The store stores only your public GitHub display name and avatar URL, shown as attribution on your contributions.
- Browsing and downloading require no account and leave no personal trace.
- Reference cycles contain only power measurements over time. They carry no location data, usage habits, or personal information beyond the contributor's public GitHub display name and avatar URL.
- There is no analytics, no ad tracking, and no third-party marketing scripts.

## Project status

Community project. Hosted on GitHub Pages (static site, zero cost) backed by Firebase Firestore (free tier). No ads, no tracking, no paid tier, no subscriptions.

- **Store site:** [washdata-store on GitHub](https://github.com/3dg1luk43/washdata_store)
- **Integration:** [ha_washdata on GitHub](https://github.com/3dg1luk43/ha_washdata)

Idea by [oli-z](https://github.com/oli-z). Developed by [3dg1luk43](https://github.com/3dg1luk43). Copyright (C) 2026.

## License

See [LICENSE](LICENSE) if present, otherwise treat as all-rights-reserved pending a license declaration by the maintainer.
