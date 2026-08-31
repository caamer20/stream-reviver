# Resumable development checkpoint

Date: 2026-08-30  
Version: 3.1.3  
State: locally working development candidate; intentionally not a stable/publication claim

## Safe stopping point

The current source is a coherent, runnable checkpoint. Chrome and Firefox development builds are present under `dist/chrome` and `dist/firefox`, the UI opens at its intended size, the local recovery fixture works, and the final source passed the automated browser gates listed below. No additional implementation is required to load and use the extension locally.

The complete checkpoint is intended to be preserved in Git before any signing build is produced. Stable provenance correctly rejects dirty or untracked source, so later edits must be committed and the full gate rerun before packaging. No permission expansion or public publication is implied by this checkpoint.

## Final local verification

The following checks passed against this checkpoint:

- `npm run check`
- `npm test` — 561/561 tests
- `npm run test:coverage` — 97.55% lines, 86.89% branches, 96.49% functions
- `npm run test:accessibility`
- `npm run test:performance`
- `npm run test:release-integrity`
- `npm run build` — Chrome, Firefox, and the local fixture
- `node scripts/release-check.mjs` — 60 generated development files validated
- `npm run lint:firefox` — 0 errors, 0 warnings, 0 notices
- `npm run test:firefox` — temporary add-on installed successfully in local Firefox
- `npm run test:e2e` — 20/20 real-Chrome extension scenarios
- `npm run test:soak:smoke` — 1 long-lived browser cycle, 4/4 scenarios; report at `artifacts/soak-report.json`
- `git diff --check`

## Recovery safety boundary at this checkpoint

- The elected player, exact top-level route (including query and fragment), recovery cycle, action, and one-use nonce bind every automatic page reload.
- Only a visible, continuously painted, responsive top-frame countdown can commit the reload at its exact coordinator deadline.
- Iframe countdowns and delayed background alarms cannot reload the top page. The alarm is watchdog-only and cancels stale work.
- Cross-origin embedded recovery requires both the top and child origins to be explicitly enabled and permitted.
- A tab can have only one nonterminal recovery action. Settings changes, disable/reset/snooze operations, worker restarts, frame-ID reuse, and content acknowledgement retries fail closed.
- Automatic maximize and playback-state restoration obey their current settings at context creation, claim, capture, delivery, and execution boundaries.
- Automatic iframe reload remains disabled until replacement-frame identity can be proven safely.

## Resume here

Start the next session by reading this file and running:

```bash
npm install
npm run build
npm run check
npm test
```

Then review `git status --short` and the diff before making further changes. The most useful next milestone is release-candidate preparation: run the clean-tree tagged/reproducibility gates and test the signed package upgrade path. Avoid adding more features before that baseline is preserved.

## Intentionally unfinished production gates

These are not needed for local use and are not claimed complete:

- a retained uninterrupted 24-hour soak;
- private-beta evidence across representative sites, browsers, players, and operating systems;
- independent security and privacy review;
- public privacy-policy hosting;
- clean tagged deterministic packaging and two-workspace reproducibility evidence;
- signed-package installation and N-1 settings/upgrade testing;
- current Chrome/Firefox store submission or approval evidence for this exact candidate;
- full Firefox behavioral automation and Firefox for Android validation.

See `docs/RELEASE_CHECKLIST.md`, `docs/VALIDATION_PLAN.md`, and `docs/RELEASE_EVIDENCE_TEMPLATE.md` before making any production-readiness claim.
