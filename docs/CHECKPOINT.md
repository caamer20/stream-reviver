# Release checkpoint — 3.1.6

Date: 2026-09-19. Firefox 3.1.6 is approved and publicly available; this is not a claim that every production-readiness gate is complete. Immutable tag `v3.1.6` identifies commit `7e514be935275c6bf203e539eb1a031c4c74275f`; later main changes only maintain tests/workflow/documentation.

## Changes

- Firefox custom-port host permission and registration fixes, with exact-origin monitoring and optional player-bridge isolation.
- Shared Firefox grants remain until the last enabled sibling origin is disabled.
- Full dependency audit includes development tools; the former linter exception is closed.
- Packaging retains older archives and test evidence, atomically replaces owned output files, and compares only the validated current release inventory for reproducibility.
- A geckodriver lane exercises Firefox behavior and supports signed installation and N-1 upgrades. GitHub Actions retains browser evidence for 90 days.
- The 3.1.6 patch removes selector/player-label leakage from legacy diagnostic history and stops storing those values in new history. The real preview and downloaded support JSON are tested, alongside dashboard privacy and disabled/closed focus rejection.
- Icon PNGs use deterministic stored zlib blocks with golden hashes; artwork pixels remain identical to 3.1.5.

## Verification and retained evidence

Use the immutable version tag and its GitHub release assets as the source of final release provenance. Do not treat a pre-commit development report as tagged release evidence.

```bash
npm ci
npm run check
npm run test:coverage
npm run test:e2e
npm run test:firefox
npm run test:firefox:e2e
npm run test:soak:smoke
npm run package:tagged
npm run verify:reproducible -- --require-tag
npm run verify:source
```

The final release passed 570 unit/property tests, all 21 Chrome scenarios, and tagged clean packaging/reproducibility/source-rebuild gates. Linux and macOS archives, source, SBOM and manifest are byte-identical. Firefox's 12 behavioral checks include settings persistence, diagnostic preview/download redaction, dashboard privacy/focus, healthy playback, pause protection, fullscreen restoration/opt-out, sibling-port isolation, and shared-grant revocation. Mozilla's signed package passed 12 fresh-install and 13 upgrade checks (3.1.5→3.1.6), with active persistent signed state 2. Warning stacks from Firefox document disposal are retained for review, not silently discarded or equated with a live-page hang.

`artifacts/release-manifest.json` binds version, tag, commit, archives, source, SBOM, and hashes. `artifacts/reproducibility.json` records independent clean-build comparison. `artifacts/firefox-e2e-report.json` and `artifacts/soak-report.json` record browser evidence. Signed-package reports additionally include XPI hashes and installation identity. Packaging preserves all these reports.

The source ZIP includes generated `SOURCE_BUILD.json`. Reviewers run `npm ci` and `npm run build:source` without Git; the metadata inventory and source hash must validate first. `artifacts/source-rebuild.json` records that the actual extracted source reconstructs both submitted browser file inventories exactly. This mode writes `dist/source-archive` and does not relax normal stable-release Git/tag enforcement.

## Outstanding production evidence

- A retained uninterrupted 24-hour soak result (smoke is not a substitute).
- Representative field/beta evidence and the acceptance thresholds in `VALIDATION_PLAN.md`.
- Independent security/privacy review.
- Human permission-prompt checks and the declared stable/ESR browser/OS matrix.
- Firefox for Android and Chrome Web Store publication are not claimed.

See `RELEASE_CHECKLIST.md`, `VALIDATION_PLAN.md`, and `RELEASE_EVIDENCE_TEMPLATE.md`. Preserve failures as well as passes; never mark an external gate complete based only on local automation or store approval.
