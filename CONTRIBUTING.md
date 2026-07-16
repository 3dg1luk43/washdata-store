# Contributing to WashData Store

Thank you for your interest in contributing to the WashData Store! This document covers how to contribute code and frontend changes to the store itself. For contributing appliance programs and reference cycles via the web interface, see the [README](README.md).

## What is this repo?

This repository contains the static frontend (HTML/JS) and the Firebase Firestore rules and indexes for the [WashData Community Store](https://3dg1luk43.github.io/washdata_store) - a free, community-run catalog where WashData users share appliance power-cycle profiles.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Types of Contributions](#types-of-contributions)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [License](#license)

---

## Getting Started

### Prerequisites

- A GitHub account
- Basic familiarity with JavaScript (ES modules) and Firebase/Firestore

### Fork & Clone

1. **Fork the repository** on GitHub
2. **Clone your fork locally**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/washdata_store.git
   cd washdata_store
   ```
3. **Add upstream remote**:
   ```bash
   git remote add upstream https://github.com/3dg1luk43/washdata_store.git
   ```

---

## Development Setup

The store is a plain static site using ES modules - no build step needed.

```bash
# Serve locally (any static server works)
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080` in your browser. Firebase is configured to use the production Firestore instance by default; for write operations you will need to sign in with GitHub OAuth in the browser.

For Firestore rules changes, install the Firebase CLI:

```bash
npm install -g firebase-tools
firebase login
firebase emulators:start --only firestore
```

---

## Types of Contributions

### Bug Reports

Found a bug in the store frontend? Open an issue describing:
- What you expected to happen
- What actually happened
- Browser and OS version

### Feature Requests

Have an idea for the store UI? Open an issue. Bear in mind the store is intentionally minimal - features that belong in the ha_washdata panel integration are out of scope here.

### Code Contributions

Non-trivial code PRs go through an **accepted-issue flow** (the same as the ha_washdata integration):

1. **Open an issue** — a [Bug Report](https://github.com/3dg1luk43/washdata_store/issues/new?template=bug_report.yml) or [Feature Request](https://github.com/3dg1luk43/washdata_store/issues/new?template=feature_request.yml) describing what you want to fix or build.
2. **Indicate your intent** — check the "Contributing a Fix" / "Contributing an Implementation" box at the bottom of the issue form.
3. **Wait for the `accepted` label** — only the maintainer can apply it. This prevents you from spending time on work that's already in the pipeline or that the maintainer wouldn't merge.
4. **Open your PR** referencing the issue (`Closes #NNN`).

> An automated check enforces this: a PR with no linked `accepted` issue is warned and auto-closed after 3 days if none is linked. Linking an issue stops the timer; once the maintainer accepts it, the check passes.

### Firestore Rules / Indexes

Changes to `firestore.rules` or `firestore.indexes.json` are high-impact. Always test with the Firestore emulator (`npm run test:rules`) before submitting a PR, and include the test steps in your PR description. The CI runs these tests on every PR.

---

## Pull Request Process

1. **Get an accepted issue first** (see [Code Contributions](#code-contributions) above).
2. **Sync with upstream** before starting:
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```
3. **Create a feature branch**:
   ```bash
   git checkout -b fix/brief-description
   ```
4. **Make your changes** - keep PRs focused (one fix or feature per PR)
5. **Test locally**:
   ```bash
   npm run test:unit          # JS unit tests
   npm run test:rules         # Firestore rules tests (if you touched rules/indexes)
   ```
   and verify the UI works as expected in a browser.
6. **Add the license header** to any new source file (see [Coding Standards](#coding-standards)).
7. **Submit a PR** using the template, with:
   - A clear title
   - A description of what changed and why
   - `Closes #NNN` referencing the accepted issue

### PR Title Format

- `[FIX]` - Bug fixes
- `[FEATURE]` - New features
- `[RULES]` - Firestore rules/indexes changes
- `[DOCS]` - Documentation only

---

## Coding Standards

- **Plain ES modules** - no bundler, no transpiler, no framework; keep it simple
- **No external CDN dependencies** beyond Firebase SDK (already used)
- **No tracking scripts, analytics, or ads** - the store is privacy-first by design
- **Consistent style** - match the formatting of existing files (2-space indentation, single quotes)
- **License header** - every source file (`.js`, `.mjs`, `.py`) must start with the AGPL-3.0-or-later
  header used across the project (copy it from any existing file). CI fails the build if a source
  file is missing it.

---

## License

By contributing to WashData Store you agree that your contributions will be licensed under the
**GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later), the same licence
that covers the project. See [LICENSE](LICENSE) for the full terms.

This software is provided free of charge. No contributor is required to assign copyright
to the maintainer; you retain copyright in your own contributions while granting the project
the right to distribute them under AGPL-3.0-or-later.

---

**Last Updated**: 2026-07-16
