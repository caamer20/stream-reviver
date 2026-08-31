# Test matrix

## Automated

`npm test` runs more than 500 deterministic examples and seeded property cases covering healthy/stalled/paused/offline/ended/error states, frame freezes, buffering, live/DVR/VOD classification, intentional rewind, access interruption, lifecycle resume, corroborated/untrusted protocol failures, open-shadow and embedded-origin discovery, every recovery policy, cross-navigation ledgers, adaptive evidence thresholds, split-storage migration/rollback and clamping, diagnostic redaction, unsafe keys, URL/selector validation, data-only profiles, local outcome baselines, Mission Control read models, sender authorization, and exact runtime-message schemas.

`npm run test:coverage` enforces at least 90% executable lines, 85% branches, and 90% functions. `npm run test:performance` enforces hot-path throughput budgets. `npm run test:accessibility` enforces the static semantic/localization/focus/contrast baseline.

`npm run test:e2e` loads the real Chrome MV3 build in one isolated profile and runs 20 scenarios against deterministic localhost media while using the production runtime-message, optional-permission, dynamic-registration, and background paths:

1. popup layout at 390×600, settings navigation, and Mission Control layout/live state;
2. healthy playback without reload;
3. disable/re-enable lifecycle reinjection without navigation;
4. primary selection over a muted preview;
5. rapid DOM churn without recovery;
6. SPA navigation and injection;
7. delayed injection after an initial no-video state;
8. open-shadow-root discovery;
9. same-origin iframe playback;
10. access-interruption suppression;
11. player replacement and rediscovery;
12. intentional-pause suppression;
13. normal finite-media completion;
14. two-level iframe discovery;
15. forged page-world signal suppression;
16. audio-only no-video behavior;
17. elapsed-time stall detection without premature recovery;
18. sensitive-dialog configured-control suppression;
19. configured retry with sustained-success verification and no reload;
20. page-reload loop protection.

The reload path additionally has deterministic unit coverage for exact route hashes, primary-frame leases, one-use action nonces, one nonterminal action per tab, settings/control races, content acknowledgement retries, countdown ownership, and fail-closed deadline expiry. The top-frame paint/continuity rule is exercised through the real extension countdown path; a background alarm is never treated as a second navigation executor.

`npm run lint:firefox` runs Mozilla's official add-on linter on the generated Firefox build. `npm run test:firefox` runs that lint and then verifies that Firefox can install the manifest as a temporary add-on in a headless smoke session. Full Firefox behavioral parity, action-popup behavior, signed-package upgrade, and long-lived playback remain human/beta gates because the Chrome CDP-specific scenario harness does not drive Firefox extension internals.

`npm run test:release-integrity` exercises clean/dirty/untracked repositories, version tags, unsafe symlinks, source-allowlist violations, archive paths, exact toolchain enforcement, deterministic ZIP modes/order/path guards, and 14 negative outbound-capability fixtures (including aliases). `npm run release:check` parses every generated script and rejects fetch/XHR/EventSource/WebSocket/beacon/image/form/dynamic-navigation egress, then validates stable manifests, current-commit provenance, permission surface, the deny-by-default CSP, localization, size budgets, output hashes, and checksums. `npm run package` emits deterministic browser/allowlisted-source archives and a CycloneDX 1.6 SBOM. `npm run verify:reproducible` rebuilds in two independent clean workspaces and compares every packaged artifact hash.

`npm run test:soak:smoke` runs the healthy/churn/replacement/protocol-spoof modes in one long-lived Chromium process, profile, extension worker, and fixture tab rather than restarting for each cycle. The same harness backs `npm run test:soak -- --hours 24` and writes a machine-readable report containing commit/browser/OS, completed cycles, per-scenario false-recovery assertions, page and service-worker heap after requested garbage collection, Chrome RSS, DOM/listener and target counts, storage-area bytes, bounded-history size, peaks, regression slopes, and monotonic-growth ratios. The short smoke validates the harness and candidate baseline; only a retained uninterrupted 24-hour report satisfies the extended-soak release gate.

## Manual cross-browser

Run the localhost fixture in current stable Chrome and Firefox, then test popup enable/disable, permission denial/revocation, first-run acknowledgement, options persistence, import/export, selector picking, countdown cancel/extend, snooze, maximize exit, user-gesture fullscreen fallback, Picture-in-Picture, event mode, page reload, and temporary-add-on restart.

Also test a representative permitted iframe, a sandboxed/cross-origin iframe, a background tab under the default visibility rule, offline/online transitions, a manually paused stream, a deliberately behind-live DVR stream, and a site with a sign-in/paywall modal. The expected result for inaccessible or ambiguous cases is a limitation/user-action state, never aggressive recovery.

## Release gate

A release candidate is acceptable only when TypeScript, unit/coverage/property tests, performance/accessibility gates, all channel builds, all 20 Chrome scenarios, release checks, Firefox manifest lint, and a Firefox temporary launch pass succeed for the same candidate. Stable publication additionally requires the retained 24-hour soak, beta evidence, independent review, signed-package/N-1 upgrade, and store gates in `docs/RELEASE_CHECKLIST.md`; none is implied by a local green run. Browser console warnings unrelated to extension code should be distinguished from extension errors.
