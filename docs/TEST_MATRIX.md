# Test matrix

## Automated

`npm test` runs more than 300 deterministic examples and seeded property cases covering healthy/stalled/paused/offline/ended/error states, frame freezes, buffering, live/VOD classification, intentional rewind, access interruption, lifecycle resume, corroborated/untrusted protocol failures, every recovery policy, adaptive evidence thresholds, schema migration and clamping, unsafe keys, URL/selector validation, data-only profiles, local outcome baselines, sender authorization, and every runtime-message schema.

`npm run test:coverage` enforces at least 90% executable lines, 85% branches, and 90% functions. `npm run test:performance` enforces hot-path throughput budgets. `npm run test:accessibility` enforces the static semantic/localization/focus/contrast baseline.

`npm run test:e2e` loads the real Chrome MV3 build in an isolated profile and checks:

1. healthy playback without reload;
2. primary selection over a muted preview;
3. rapid DOM churn;
4. SPA navigation and delayed injection;
5. same-origin iframe playback;
6. access interruption suppression;
7. player replacement and rediscovery;
8. configured retry with sustained success verification;
9. page-reload loop protection;
10. intentional pause suppression;
11. normal finite-media completion;
12. two-level iframe discovery;
13. forged page-world signal suppression;
14. audio-only no-video behavior;
15. sensitive-dialog control suppression.

`npm run test:firefox` uses Mozilla's official linter and verifies that Firefox installs the generated manifest as a temporary add-on. Full Firefox behavioral parity remains a human/beta gate because Chrome CDP-specific automation cannot drive Firefox extension internals.

`npm run release:check` validates the stable generated manifests, permission surface, CSP, localization, no dynamic/remote/network code, size budgets, and checksums. `npm run package` emits deterministic browser/source archives and a CycloneDX SBOM.

## Manual cross-browser

Run the localhost fixture in current stable Chrome and Firefox, then test popup enable/disable, permission denial/revocation, first-run acknowledgement, options persistence, import/export, selector picking, countdown cancel/extend, snooze, maximize exit, user-gesture fullscreen fallback, Picture-in-Picture, event mode, page reload, and temporary-add-on restart.

Also test a representative permitted iframe, a sandboxed/cross-origin iframe, a background tab under the default visibility rule, offline/online transitions, a manually paused stream, a deliberately behind-live DVR stream, and a site with a sign-in/paywall modal. The expected result for inaccessible or ambiguous cases is a limitation/user-action state, never aggressive recovery.

## Release gate

A release candidate is acceptable only when TypeScript, unit/coverage/property tests, performance/accessibility gates, all channel builds, Chromium behavior, release checks, Firefox manifest validation, and a Firefox temporary launch pass. Stable publication additionally requires the soak/beta/reviewer/store gates in `docs/RELEASE_CHECKLIST.md`. Browser console warnings unrelated to extension code should be distinguished from extension errors.
