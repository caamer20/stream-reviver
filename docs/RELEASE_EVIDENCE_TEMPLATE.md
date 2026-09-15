# Release evidence record

Copy this file to the private release-evidence archive for every beta or stable candidate. Do not mark a gate complete without attaching its artifact, URL, reviewer, or command output.

## Identity

- Version / channel:
- Git tag and commit:
- Clean tree verified:
- Node / npm / esbuild:
- Chrome package SHA-256:
- Firefox package SHA-256:
- Source package SHA-256:
- SBOM SHA-256:
- Release manifest / provenance location:
- Reproducibility report location:

## Automated gates

- [ ] TypeScript and unit/property suite
- [ ] Coverage and mutation-critical guards
- [ ] Performance budgets
- [ ] Accessibility/static localization gate
- [ ] Release-integrity and no-egress fixtures
- [ ] Stable build and release validation
- [ ] All 21 Chrome real-extension scenarios
- [ ] Firefox lint and temporary-install smoke
- [ ] Long-lived single-browser/profile soak smoke
- [ ] Two-workspace reproducibility
- [ ] Default diagnostic export redaction review

Record the command, timestamp, host, exit status, and retained log for each checked item.

## Browser compatibility

| Browser | Exact version | OS | Signed package | Install | Upgrade from N-1 | Permission lifecycle | Popup/options | Recovery fixture | Result |
|---|---|---|---|---|---|---|---|---|---|
| Chrome Stable | | | | | | | | | |
| Chrome Beta | | | | | | | | | |
| Firefox Stable | | | | | | | | | |
| Firefox ESR | | | | | | | | | |

## Reliability evidence

- 24-hour continuous soak report:
- Monitored healthy hours:
- False automatic reloads / healthy hours:
- User-rated recovery precision:
- Soft-recovery share:
- Crash/error-free monitored hours:
- Protected-category violations (must be zero):
- Memory/storage growth review:
- Beta participant/player/browser distribution:

Leave the 24-hour and beta fields blank until the retained report and consented sample exist. A smoke run, unit suite, or localhost E2E run is not equivalent evidence.

## Human reviews

- Security reviewer / date / report:
- Privacy reviewer / date / report:
- Accessibility reviewer / date / report:
- Product/reliability owner approval:
- Open exceptions, owner, rationale, and expiry:

## Store and operations

- Public privacy-policy URL:
- Support URL/contact tested:
- Store listing/reviewer notes updated:
- Store permission diff reviewed:
- Signed package smoke completed:
- Rollout cohort and start time:
- Last-known-good version:
- Emergency roll-forward version reserved:
- Rollback drill result:
- 24-hour post-release review:
- 72-hour post-release review:

## Decision

- Release / hold:
- Decision maker(s):
- Date:
- Rationale and residual risks:
