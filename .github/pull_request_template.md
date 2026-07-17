> [!IMPORTANT]
> **Non-trivial PRs must reference an issue that carries the `accepted` label.**
> If no accepted issue is linked, this PR will be closed automatically.
> To get your work accepted: open a [Bug Report](https://github.com/3dg1luk43/washdata_store/issues/new?template=bug_report.yml) or [Feature Request](https://github.com/3dg1luk43/washdata_store/issues/new?template=feature_request.yml) first, indicate you plan to submit a PR, and wait for the maintainer to add the `accepted` label before opening this PR.

## Linked Accepted Issue

Closes #<!-- issue number — must have the `accepted` label -->

## Description

<!-- Brief summary of the changes. What problem does this solve? -->

## Type of Change

<!-- Mark the relevant option with an "x" -->

- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)
- [ ] ✨ New feature (non-breaking change that adds functionality)
- [ ] 🔄 Refactor (code reorganization with no behavior change)
- [ ] 📚 Documentation update
- [ ] 🧪 Test additions/improvements
- [ ] 🎨 UI/UX improvement
- [ ] 🔒 Firestore rules / indexes change

## Changes Made

<!-- Describe what you changed and why. Be specific. -->

- [ ] Change 1
- [ ] Change 2

## Testing

<!-- How have you tested these changes? -->

- [ ] `npm run test:unit` passes
- [ ] `npm run test:rules` passes (if Firestore rules/indexes changed)
- [ ] Manually tested in a browser (served locally with `npx serve .` or `python3 -m http.server`)

**Tested on:**
- Browser(s): <!-- e.g. Firefox 141, Chrome 138 -->
- Signed in with GitHub: [ ] yes / [ ] no (if the change touches contribution features)

## Firestore Rules / Indexes

<!-- Only if this PR changes firestore.rules or firestore.indexes.json -->

- [ ] N/A — this PR does not touch Firestore rules or indexes
- [ ] I tested the rules change against the emulator (`npm run test:rules`)
- [ ] I confirmed the change does not loosen read/write access unexpectedly

## Breaking Changes?

- [ ] This PR includes **breaking changes** (data model, URL structure, or rules)

<!-- If breaking, describe the change and any migration needed: -->

## Checklist

- [ ] My code matches the style of the surrounding files (plain ES modules, 2-space indent)
- [ ] I have **not** added any ad-tech, third-party marketing scripts, or additional analytics beyond the project's existing GA4 + Firestore counters
- [ ] I have **not** added new external/CDN dependencies beyond the existing Firebase SDK
- [ ] Every new source file carries the AGPL-3.0-or-later license header
- [ ] I've validated JSON config I changed (`node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"`)
- [ ] I've reviewed my own code for quality

## Screenshots / Demo

<!-- Add screenshots or a short clip for UI changes. -->

## Notes for Reviewers

<!-- Any additional context, concerns, or guidance for the reviewer? -->

---

**Thank you for contributing to the WashData Store!** 🙏

Before hitting submit, please make sure:
1. ✅ PR title clearly describes the change
2. ✅ Description is detailed enough for reviewers to understand
3. ✅ Tests pass locally
4. ✅ You've reviewed the [CONTRIBUTING.md](https://github.com/3dg1luk43/washdata_store/blob/main/CONTRIBUTING.md) guide
