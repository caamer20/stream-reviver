# Production validation plan

## Success definitions

- False automatic reload rate: below 0.1% of monitored healthy hours and zero reloads for manual pause, access interruption, normal VOD completion, or no-video pages.
- Recovery precision: at least 95% of user-rated automatic recovery cycles are appropriate.
- Soft-recovery share: at least 70% of successful recoveries avoid a full page reload on sites where a soft action is available.
- Crash/error-free monitored hours: at least 99.9% in the beta sample.
- No unbounded growth: history/models remain capped and 24-hour soak shows no monotonic extension-caused memory increase beyond the agreed browser baseline.

These are release targets, not a claimed universal success percentage.

## 24-hour soak

Run `npm run test:soak -- --hours 24` on a dedicated machine. Record commit, Node, OS, Chrome, Firefox, start/end memory, browser console errors, cycles, false reloads, and failures. The runner repeatedly exercises healthy playback, heavy DOM churn, player replacement, and forged protocol messages. Also keep one manually enabled Firefox fixture session open for lifecycle/discard observation.

## Private beta

Recruit at least 20 consenting users or collect 500 monitored hours across multiple operating systems, Chrome/Firefox, HTML5/MSE/WebRTC, top-level/iframe, DVR live, and long events. Collection is manual and opt-in: users export/redact diagnostics; the extension sends nothing. Track monitored hours, diagnosis, attempted action, verified outcome, false alarm rating, browser/site capability level, and configuration. Never collect credentials, stream content, DRM data, or private URLs without explicit redaction/consent.

## Exit and rollback

Stable release requires all checklist items, zero critical/high unresolved runtime findings, accepted beta thresholds, and signed-package smoke tests. Roll back by pausing the store rollout, publishing the last known-good package if store policy permits, documenting affected versions, and preserving the failing artifact/checksum for investigation.
