# Release checklist

## Automated candidate gate

- [ ] Working tree and version/changelog are intentional.
- [ ] `npm ci` and `npm audit --omit=dev` pass.
- [ ] `npm run release:check` passes coverage, performance, accessibility, stable builds, permissions, CSP, network-code, and size checks.
- [ ] `npm run test:e2e` passes all Chromium behavioral scenarios.
- [ ] `npm run test:firefox` passes Mozilla lint and temporary installation.
- [ ] `npm run test:soak:smoke` passes before extended soak.
- [ ] `npm run package` produces Chrome, Firefox, source, SBOM, and SHA-256 release metadata.
- [ ] Running `node scripts/package.mjs` twice without source changes produces identical archive hashes.

## Human/external stable gate

- [ ] Run `npm run test:soak -- --hours 24`; archive machine/browser versions and result.
- [ ] Complete the beta target in `docs/VALIDATION_PLAN.md` and accept its false-positive/recovery thresholds.
- [ ] Independent reviewer signs off security/privacy boundaries and deletion behavior.
- [ ] Verify Chrome stable/beta and Firefox stable/ESR versions declared in store metadata.
- [ ] Publish the privacy policy at HTTPS and verify support/security channels.
- [ ] Capture current store screenshots and reviewer video from the stable build.
- [ ] Sign/upload packages through authorized store accounts; verify requested permissions match the reviewed manifest.
- [ ] Test the store-installed signed versions, upgrade from the previous stable version, and rollback procedure.
- [ ] Create release notes, tag `vX.Y.Z`, retain checksums/SBOM/source, and monitor support after rollout.
