# Release checkpoint — 3.2.0

Date: 2026-10-12. Version 3.2.0 adds reviewed settings imports and a more usable Mission Control. The immutable `v3.2.0` tag and its GitHub release assets identify the packaged source and retained verification evidence. Firefox Add-ons approval is a separate store process; the previously approved 3.1.6 package remains identified by immutable tag `v3.1.6` at `7e514be935275c6bf203e539eb1a031c4c74275f`.

## Changes

- Validate bounded settings backups before mutation, retain supported schema migration, and preview the exact normalized replacement, missing defaults, removed configurations, and current site deactivation.
- Check each site-deactivation response before writing a replacement, preserve unsaved drafts, reject stale reviews, and explain partial failure without claiming removed access was rolled back. Imported sites remain disabled.
- Add hostname search, coverage/status filters, matching counts, expandable lists, and bounded scroll areas to Mission Control. The snapshot includes up to 500 configured sites, 100 fresh monitors, and 50 recent recovery events.
- Preserve keyboard focus through live updates and transient failures, suspend hidden-page polling, and disable tab actions when displayed data is stale.
- Replace the Firefox build tool's unused Android/ADB dependency chain with direct Mozilla lint and a real disposable geckodriver temporary-install check; retain dependency-audit enforcement.
- Keep viewport-emulation sessions alive for Linux Chrome, preserving strict popup-size and visible-footer assertions.

## Verification and retained evidence

Use the release tag, package manifest, provenance, and attached reports as the authoritative evidence for the packaged commit. A development screenshot or pre-commit test result is not tagged release provenance.

```bash
npm ci
npm run release:check
npm run build
npm run test:e2e
npm run test:firefox
npm run test:firefox:e2e
npm run test:soak:smoke
npm run package:tagged
npm run verify:reproducible -- --require-tag
npm run verify:source
```

Firefox installation and behavioral checks require Mozilla geckodriver 0.37.1 on PATH or `GECKODRIVER_BIN`. Browser harnesses use disposable profiles and synthetic localhost origins; they do not test human permission dialogs or representative production streams.

`release-manifest.json` binds the version, tag, commit, browser/source archives, SBOM, and hashes. `provenance.json`, `reproducibility.json`, and `source-rebuild.json` record build identity, independent clean-build comparison, and reconstruction from the actual source ZIP without Git. Browser/soak logs and reports and a release evidence record accompany those artifacts. Inspect each report's commit, version, and result before treating its gate as complete.

The source ZIP includes `SOURCE_BUILD.json`. Reviewers extract it, run `npm ci` and `npm run build:source`, and inspect `dist/source-archive/firefox`. The source inventory and hashes must validate before compilation; normal repository packaging still requires a clean tree and matching release tag.

## Outstanding external evidence

- A retained uninterrupted 24-hour soak result for this candidate; smoke is not a substitute.
- Representative consented field/beta evidence and the acceptance thresholds in `VALIDATION_PLAN.md`.
- Independent security/privacy review.
- Human permission-prompt checks and the declared stable/ESR browser/OS matrix.
- Store submission, signing, and N-1 signed-package upgrade verification for 3.2.0.
- Firefox for Android and Chrome Web Store publication are not claimed.

See `RELEASE_CHECKLIST.md`, `VALIDATION_PLAN.md`, and `RELEASE_EVIDENCE_TEMPLATE.md`. GitHub publication and passing automation do not imply these external gates passed. Preserve failures alongside successful evidence.
