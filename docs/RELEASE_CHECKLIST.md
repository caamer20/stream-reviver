# Release checklist

## Automated candidate gate

- [ ] `HEAD`, the `vX.Y.Z` release tag, `package.json` version, generated manifests, build provenance, and browser `build-info.json` all identify the same release.
- [ ] Working tree is completely clean, including untracked files; the source allowlist contains only intended Git-tracked regular files and no symlink/submodule.
- [ ] Node 24.2.0/npm 11.4.2 are active; `npm ci`, `npm run check:toolchain`, and `npm run audit:dependencies` pass (including development dependencies).
- [ ] `npm run release:check` passes release-policy tests, coverage, performance, accessibility, stable provenance, permissions, CSP, network-code, and size checks.
- [ ] `npm run test:e2e` passes all 21 Chrome behavioral scenarios, including popup/settings/Mission Control navigation and layout plus post-refresh fullscreen/default opt-out behavior.
- [ ] `npm run lint:firefox` passes Mozilla lint and `npm run test:firefox` passes a temporary Firefox installation smoke.
- [ ] `npm run test:firefox:e2e` passes Firefox settings, playback/pause, fullscreen/opt-out, sibling-port isolation, and shared-permission lifecycle checks; retain its JSON report.
- [ ] `npm run test:soak:smoke` passes its one-browser/profile resource and false-recovery guards before extended soak; retain `artifacts/soak-report.json`.
- [ ] `npm run package:tagged` produces Chrome, Firefox, allowlisted tracked source, CycloneDX 1.6 SBOM, and SHA-256 release metadata.
- [ ] `npm run verify:reproducible -- --require-tag` proves two independent clean-workspace builds match the normal package and writes `artifacts/reproducibility.json`.
- [ ] Archive `release-manifest.json`, `reproducibility.json`, build provenance, SBOM, source package, browser packages, and SHA-256 hashes together.
- [ ] Complete `docs/RELEASE_EVIDENCE_TEMPLATE.md`; every checked gate links to retained evidence rather than relying on memory or a local terminal window.
- [ ] Preview a default diagnostic support bundle and verify origins, paths, selectors, browser details, queries/fragments, unknown metadata, screenshots, and visual hashes are absent or redacted as designed.

## Human/external stable gate

- [ ] Run `npm run test:soak -- --hours 24`; archive the machine-readable report with browser/OS/commit, per-scenario samples, peaks/slopes, and result.
- [ ] Complete the beta target in `docs/VALIDATION_PLAN.md` and accept its false-positive/recovery thresholds.
- [ ] Independent reviewer signs off security/privacy boundaries and deletion behavior.
- [ ] Manually verify Mission Control shows hostname-only data, rejects stale/disabled focus targets, and does not expose page paths, queries, or fragments.
- [ ] Verify Chrome stable/beta and Firefox stable/ESR versions declared in store metadata; keep Firefox for Android unselected until an automated mobile lane exists.
- [ ] Publish the privacy policy at HTTPS and verify support/security channels.
- [ ] Capture current store screenshots and reviewer video from the stable build.
- [ ] Sign/upload packages through authorized store accounts; verify requested permissions match the reviewed manifest.
- [ ] Test the store-installed signed versions, upgrade from the previous stable version, and the emergency roll-forward procedure in `docs/ROLLBACK_RUNBOOK.md`.
- [ ] Create release notes and the immutable `vX.Y.Z` tag before running the protected release workflow; retain checksums/SBOM/source/provenance and monitor support after rollout.
