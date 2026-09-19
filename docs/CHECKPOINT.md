# Release checkpoint — 3.1.5

Date: 2026-09-19. This is an engineering release candidate, not a claim that every production-readiness gate is complete.

## Changes

- Firefox custom-port host permission and registration fixes, with exact-origin monitoring and optional player-bridge isolation.
- Shared Firefox grants remain until the last enabled sibling origin is disabled.
- Full dependency audit includes development tools; the former linter exception is closed.
- Packaging retains older archives and test evidence, atomically replaces owned output files, and compares only the validated current release inventory for reproducibility.
- A geckodriver lane exercises Firefox behavior and supports signed installation and N-1 upgrades. GitHub Actions retains browser evidence for 90 days.

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
```

The local candidate passed 569 unit/property tests; Firefox's 10 behavioral checks include settings persistence, healthy playback, pause protection, fullscreen restoration/opt-out, unenabled sibling-port isolation, and shared-grant revocation. The full clean-tree release gate must run again after the final commit.

`artifacts/release-manifest.json` binds version, tag, commit, archives, source, SBOM, and hashes. `artifacts/reproducibility.json` records independent clean-build comparison. `artifacts/firefox-e2e-report.json` and `artifacts/soak-report.json` record browser evidence. Signed-package reports additionally include XPI hashes and installation identity. Packaging preserves all these reports.

## Outstanding production evidence

- A retained uninterrupted 24-hour soak result (smoke is not a substitute).
- Representative field/beta evidence and the acceptance thresholds in `VALIDATION_PLAN.md`.
- Independent security/privacy review.
- Signed 3.1.5 installation and N-1 upgrade evidence after Mozilla supplies the signed package.
- Human permission-prompt checks and the declared stable/ESR browser/OS matrix.
- Firefox for Android and Chrome Web Store publication are not claimed.

See `RELEASE_CHECKLIST.md`, `VALIDATION_PLAN.md`, and `RELEASE_EVIDENCE_TEMPLATE.md`. Preserve failures as well as passes; never mark an external gate complete based only on local automation or store approval.
