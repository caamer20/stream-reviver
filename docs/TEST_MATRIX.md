# Test matrix

## Automated

`npm test` covers healthy/stalled/paused/offline/ended/error states, frame freezes, buffering, live/VOD classification, intentional rewind, access interruption, lifecycle resume, protocol failures, recovery policies, adaptive evidence thresholds, schema migration and clamping, unsafe keys, URL/selector validation, data-only profiles, local outcome baselines, and runtime message validation.

`npm run test:e2e` loads the real Chrome MV3 build in an isolated profile and checks:

1. healthy playback without reload;
2. primary selection over a muted preview;
3. rapid DOM churn;
4. SPA navigation and delayed injection;
5. same-origin iframe playback;
6. access interruption suppression;
7. player replacement and rediscovery;
8. configured retry with sustained success verification;
9. page-reload loop protection.

`npm run release:check` validates the generated manifests, permission surface, CSP, code-generation rules, and checksums.

## Manual cross-browser

Run the localhost fixture in current stable Chrome and Firefox, then test popup enable/disable, permission denial/revocation, first-run acknowledgement, options persistence, import/export, selector picking, countdown cancel/extend, snooze, maximize exit, user-gesture fullscreen fallback, Picture-in-Picture, event mode, page reload, and temporary-add-on restart.

Also test a representative permitted iframe, a sandboxed/cross-origin iframe, a background tab under the default visibility rule, offline/online transitions, a manually paused stream, a deliberately behind-live DVR stream, and a site with a sign-in/paywall modal. The expected result for inaccessible or ambiguous cases is a limitation/user-action state, never aggressive recovery.

## Release gate

A release is acceptable only when TypeScript, all unit tests, both builds, the real-browser suite, release checks, Firefox manifest validation, and a Firefox temporary launch pass. Browser console warnings unrelated to extension code should be distinguished from extension errors.
