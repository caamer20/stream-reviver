# Production validation plan

## Success definitions

- False automatic reload rate: below 0.1% of monitored healthy hours and zero reloads for manual pause, access interruption, normal VOD completion, or no-video pages.
- Recovery precision: at least 95% of user-rated automatic recovery cycles are appropriate.
- Soft-recovery share: at least 70% of successful recoveries avoid a full page reload on sites where a soft action is available.
- Crash/error-free monitored hours: at least 99.9% in the beta sample.
- No unbounded growth: history/models remain capped and 24-hour soak shows no monotonic extension-caused memory increase beyond the agreed browser baseline.

These are release targets, not a claimed universal success percentage.

Before beginning field validation, retain a green candidate log for the full automated gate: the unit/property/coverage/performance/accessibility/security suite, all 20 real-Chrome scenarios, Mozilla lint plus Firefox temporary-install smoke, deterministic packages/reproducibility, and the short one-browser/profile soak. These establish that the candidate and evidence harnesses work; they do not satisfy the 24-hour or beta gates below.

## 24-hour soak

Run `npm run test:soak -- --hours 24` on a dedicated machine. The harness keeps one Chromium process, profile, extension worker, and fixture tab alive while repeatedly navigating healthy playback, heavy DOM churn, player replacement, and forged protocol-message modes. It fails any false recovery/reload and writes `artifacts/soak-report.json` with commit, Node/OS/browser, duration/cycles, garbage-collected page and worker heap, Chrome RSS, DOM/listener/target counts, storage bytes/history size, peaks, regression slopes, monotonic-growth ratios, and any failure stack. Archive that report with the candidate. Adjust only explicit CLI thresholds and record the command; never replace the long run with repeated fresh-browser E2E sessions. Also keep one manually enabled Firefox fixture session open for lifecycle/discard observation because the Chromium CDP harness does not establish Firefox longevity.

## Private beta

Recruit at least 20 consenting users or collect 500 monitored hours across multiple operating systems, Chrome/Firefox, HTML5/MSE/WebRTC, top-level/permitted-iframe/limited-visibility embed, DVR live, and long events. Collection is manual and opt-in: users preview and export a diagnostic bundle that aliases origins and removes paths/selectors/browser details by default; the extension sends nothing. Track monitored hours, diagnosis, attempted action, verified outcome, false alarm rating, browser/site capability level, and configuration. Never collect credentials, stream content, DRM data, screenshots, visual hashes, or private origins/paths/selectors without explicit redaction choice and consent.

## Exit and rollback

Stable release requires all checklist items, zero critical/high unresolved runtime findings, accepted beta thresholds, and signed-package smoke tests. Roll back by pausing the store rollout, publishing the last known-good package if store policy permits, documenting affected versions, and preserving the failing artifact/checksum for investigation.

This plan records required future evidence. It does not assert that the 24-hour run, beta sample, independent review, signed-package upgrade, or store rollout has been completed.
