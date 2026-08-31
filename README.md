# Stream Reviver 3.1

Stream Reviver is a privacy-first Chrome and Firefox extension that detects, explains, and safely recovers live-stream failures. It is generic and opt-in: it has no hardcoded streaming sites, analytics, trackers, remote code, or external API calls. A site is monitored only after the user acknowledges the disclaimer, enables that exact origin, and grants that origin permission.

Version 3 moves beyond a simple stall timer. It keeps a rolling observation window, classifies the failure type, selects a failure-specific recovery policy, verifies that each action actually restored sustained playback, and opens a circuit breaker when safe actions are exhausted.

## What is implemented

- Dynamic HTML5 video discovery in top-level documents, open shadow roots, and permitted frames. When a large cross-origin embed cannot be inspected, the top page reports a non-actionable limited-visibility advisory containing only the embedded origin; the user must explicitly enable that origin before it can be monitored.
- Stable primary-player scoring using visible area, playback, audio, readiness, interaction, and preview/ad penalties.
- SPA navigation, delayed injection, DOM churn, player replacement, page lifecycle gaps, and browser-resume handling.
- Rolling observations for media time, presented frames, buffer growth, seekable/live edge, lag, readiness, errors, dropped frames, and waiting events.
- Live/DVR/VOD classification and protection for intentional rewind.
- Typed diagnoses: offline, access interruption, user pause, browser resume, starvation, underrun, live-edge drift, decode/render freeze, source error, missing source, unexpected live end, player replacement, and WebRTC failure.
- Failure-specific recovery plans with configurable limits, backoff, jitter, and a circuit breaker.
- Transactional recovery verification: an action counts as successful only after sustained healthy playback.
- Recovery from soft to disruptive: wait, prompt, play, jump live, rediscover, configured retry, media reload, iframe reload, top-page reload, and explicit backup handoff.
- Cancelable/extendable top-frame reload countdown plus persistent reload-loop protection in session storage. The continuously painted in-page countdown is the only automatic reload executor; a background alarm can only fail closed and cancel a stale deadline.
- State restoration for volume, mute, rate, captions, VOD position/live intent, scroll, CSS maximize, and a Picture-in-Picture prompt.
- Native fullscreen, a user-configured native control, reversible CSS maximize, and user-gesture prompts when browser policy blocks fullscreen.
- Optional, data-minimized MAIN-world bridge for aggregate MSE, hls.js, dash.js, and WebRTC health signals.
- Optional visual watchdog for top-level players. The privileged background crops and reduces an active-tab capture to a fixed 64-bit comparison hash, discards the capture, returns no image bytes to page-facing code, and never recovers from visual evidence alone.
- Event mode with faster healthy checks, screen wake lock when available, and best-effort tab discard protection.
- Local per-origin site models, outcome feedback, and adaptive reordering only after enough evidence. Nothing leaves the browser.
- Declarative, data-only site profiles with selectors, URL rules, recovery steps, player type, and backup URLs. Profiles cannot contain code and do not grant permissions.
- Popup status, diagnosis, evidence, buffer/live lag, event mode, manual controls, snooze, local feedback, recent events, and independent automatic-recovery/page-reload/maximize controls.
- Mission Control dashboard for configured origins, fresh active monitors, confidence/state, and recent recovery outcomes. It displays hostnames only, never page paths, queries, or fragments, and can focus only a fresh enabled monitor tab.
- Full options page with global/per-site settings, selector pickers, profiles, diagnostics, import/export, and reset.
- Required first-run acknowledgement and visible disclaimer in the popup and settings.
- Strict sender authorization and origin binding for every privileged runtime message.
- Granular local-data deletion, permission-revocation reconciliation, safe selector previews, and explicit visual-monitoring consent.
- English localization source, keyboard/focus/reduced-motion/forced-color support, deterministic release packages, SBOM, and CI/security gates.

## Project layout

```text
src/
  background/background.ts       permissions, registration, state, badges, loop protection
  content/content.ts             observations, diagnosis orchestration, recovery, restoration
  content/candidates.ts          cached discovery and primary-player scoring
  content/embedded-visibility.ts conservative advisory for inaccessible cross-origin embeds
  content/frame-coordinator.ts   frame visibility/status coordination and iframe recovery
  content/ui.ts                  closed-Shadow-DOM countdowns, prompts, maximize, picker
  page-bridge/bridge.ts          optional aggregate MSE/player/WebRTC observations
  popup/                         current-tab controls and status
  dashboard/                     local-only multi-site Mission Control
  options/                       complete settings, profiles, diagnostics, import/export
  welcome/                       required first-run disclaimer
  shared/                        schema, migration, validation, policies, models, utilities
  _locales/                      browser localization messages
config/                          development, beta, and stable build channels
scripts/
  build.mjs                      channel-aware Chrome/Firefox MV3 builds and fixture
  test.mjs                       deterministic unit tests and executable coverage gate
  e2e.mjs                        real Chromium extension scenarios
  firefox-smoke.mjs              Mozilla lint and temporary-add-on installation
  performance-check.mjs          classifier/observation/settings performance budgets
  soak.mjs                       one-browser/profile resource soak (smoke or 24-hour mode)
  release-check.mjs              permission, CSP, AST no-egress, size, and checksum checks
  release-integrity.mjs          clean-tree, tag, toolchain, source, and provenance policy
  deterministic-zip.mjs          validated deterministic ZIP32 release writer
  no-egress.mjs                  generated-code outbound-capability policy
  package.mjs                    tracked-source archives and CycloneDX 1.6 SBOM
  reproducibility-check.mjs      two independent clean-workspace rebuilds
test/                            local HTML media simulator and iframe fixture
tests/                           health, diagnosis, policy, schema, profile, and security tests
docs/                            architecture, security, native-companion boundary, test matrix
dist/chrome/, dist/firefox/      development unpacked builds (legacy convenient layout)
dist/{development,beta,stable}/  isolated channel outputs
artifacts/                       generated release ZIPs, hashes, and SBOM (ignored)
```

Chrome uses an MV3 service worker. Firefox uses an MV3 non-persistent background script with the same bundle and Gecko metadata declaring no data collection. Firefox 142+ is the manifest floor because that is the first version where the no-data-collection declaration is understood on both desktop and Android. Automated behavior/install coverage remains desktop-only; do not select Firefox for Android in store compatibility metadata until a mobile test lane exists.

## Build and verify

Release toolchain: Node.js 24.2.0 and npm 11.4.2, pinned in `package.json` and `.node-version`. Development builds can run on another compatible toolchain, but stable build/package commands fail rather than silently producing incomparable release artifacts.

```bash
npm install
npm run verify
npm run test:coverage
npm run test:performance
npm run test:accessibility
npm run test:release-integrity
npm run test:e2e
npm run test:firefox
npm run release:check
npm run package
npm run verify:reproducible
```

- `npm run check`: strict TypeScript check.
- `npm test`: deterministic unit/integration tests.
- `npm run build`: produces both browser builds and the fixture.
- `npm run test:e2e`: launches an isolated Chrome profile and runs 20 deterministic real-extension scenarios, including popup/options/Mission Control layout and navigation, lifecycle reinjection, open-shadow and nested-frame discovery, elapsed-time stall detection, protected-state suppression, soft recovery, and reload-loop protection.
- `npm run build:channels`: produces isolated Development, Beta, and Stable Chrome/Firefox builds; stable and beta omit source maps.
- `npm run test:coverage`: enforces 90% lines, 85% branches, and 90% functions against executable test bundles.
- `npm run test:performance`: enforces conservative throughput budgets for hot-path pure logic.
- `npm run test:accessibility`: checks the localization, keyboard-focus, reduced-motion, forced-color, and semantic UI baseline.
- `npm run test:firefox`: runs Mozilla's linter and installs the build temporarily in headless Firefox.
- `npm run test:soak:smoke`: keeps one Chromium process, profile, extension service worker, and fixture tab alive across a short healthy/churn/replacement/spoof cycle. It records garbage-collected page/worker heap, DOM/listener counts, Chrome RSS, target count, extension storage, bounded-history growth, browser version, and commit in `artifacts/soak-report.json`. `npm run test:soak -- --hours 24` uses the same long-lived harness for the release gate; `--scenario-seconds`, `--scenarios`, `--report`, and `--max-heap-growth-mb-per-hour` tune an explicitly recorded run.
- `npm run release:check`: requires the pinned toolchain and a clean Git tree, then checks stable provenance, permissions, localization, a deny-by-default extension-page CSP, an AST-based no-egress policy with negative fixtures, package size, and SHA-256 inventory.
- `npm run package`: creates deterministic Chrome/Firefox ZIPs, a source ZIP made only from explicitly allowlisted Git-tracked regular files, a CycloneDX 1.6 SBOM, and release metadata in `artifacts/`.
- `npm run verify:reproducible`: clones the current commit into two independent temporary workspaces, installs from the lockfile, rebuilds/packages both, and requires every artifact hash to match the normal package.

Development and beta provenance records the current tree as clean or dirty. Stable builds and all packaging reject tracked modifications, untracked files, symlinks, submodules, unsafe archive paths, source-allowlist violations, toolchain drift, stale build metadata, and inconsistent version tags. The release workflow additionally requires an existing `vX.Y.Z` tag matching `package.json` at `HEAD`.

The E2E and soak tests temporarily add only their random localhost origin to a copied manifest because headless Chrome cannot accept an extension permission prompt. They still use production dynamic content-script registration. Release manifests remain optional-permission-only.

## Load in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select `dist/chrome`.
5. Acknowledge the first-run disclaimer.
6. Open a stream, open the popup, and enable **Monitor this site**.

## Load in Firefox

1. Run `npm run build`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on…** and select `dist/firefox/manifest.json`.
4. Acknowledge the disclaimer, then enable the exact stream origin in the popup.

Temporary Firefox add-ons disappear when Firefox exits. Load the manifest again after rebuilding or restarting.

## Local test page

Serve `dist/test-page` over HTTP; extension host permissions do not transfer automatically between `file:` and `http:` origins.

```bash
python3 -m http.server 8080 --directory dist/test-page
```

Open `http://127.0.0.1:8080/test-page.html`, enable that origin, then select scenarios for healthy playback, no video/audio-only, stall, media error, delayed injection, retry recovery, multiple videos, rapid DOM churn, SPA navigation, same-origin/nested/sandboxed frames, manual pause, finite-media completion, canvas-only visibility, forged page-world signals, sensitive-control guards, access interruption, or player replacement.

Expected checks:

1. Healthy playback reaches **Healthy** and never reloads.
2. Stall/error reaches a typed diagnosis only after grace and confirmation.
3. The countdown can be canceled or extended.
4. A configured retry button restores playback without page reload.
5. Persistent error reloads only up to the configured limit.
6. Manual pause, hidden-tab policy, offline state, and access interruptions suppress automation.
7. Player replacement is rediscovered without a false reload.
8. Fullscreen failure offers a click prompt or reversible CSS maximize.

Open **Mission Control** from the popup or settings to see all configured sites, fresh active monitors, and recent recovery outcomes in one local dashboard. Mission Control intentionally shows hostnames rather than full page URLs.

## Permission model

- `storage`: compact global defaults in browser-managed sync storage; per-site origins/selectors/rules, acknowledgements, bounded history, profiles, and outcome models in local storage; and expiring recovery/status state in session storage when supported. Per-site data is never placed in the synced settings record.
- `activeTab`: user-initiated controls and active-visible-tab visual sampling.
- `scripting`: register/inject scripts after an exact origin is enabled.
- `alarms`: watches one-shot recovery/countdown deadlines across service-worker suspension. It never performs a delayed reload; if the visible top-frame countdown stops painting or misses its deadline, the alarm fails closed and cancels the stale action. It is not used for browsing, tracking, or periodic site access.
- Optional `notifications`: requested only if notifications are enabled.
- Optional `<all_urls>` capability: allows the extension to request one exact origin chosen by the user. It is not a standing all-sites grant. Enabling `https://example.com` requests `https://example.com/*`; disabling it unregisters scripts and revokes that origin.

There is no `tabs` permission, no broad `host_permissions`, no remote code, and no network service. Some browser methods expose non-sensitive tab fields once an origin or `activeTab` is granted; the extension uses only what is needed for the enabled tab.

## Detection and recovery behavior

The default detection is deliberately conservative: 15-second load grace, three-second checks, 12-second stall timeout, three confirming checks, and a confidence threshold. Buffering alone is insufficient. Explicit errors are strongest; user pause, access/CAPTCHA/paywall/sign-in interruption, offline state, hidden-tab policy, ad transitions, browser resume, and intentional behind-live viewing suppress or delay automation.

Policies differ by diagnosis. Live-edge drift seeks live first. Buffer starvation waits and retries before reload. Source errors prioritize a configured retry. Access interruptions never recover automatically. Disruptive actions are capped and page reload requires a visible, continuously painted top-frame countdown. The countdown must remain responsive through its exact coordinator deadline; hidden, detached, delayed, or unpainted UI fails closed. After an action, the extension requires sustained healthy playback before recording success; otherwise it escalates. When actions or reload limits are exhausted, the circuit opens and requires the user to retry/reset.

Automatic recovery (`autoRecover`) and automatic page refresh (`autoRefresh`) are separate controls. Turning off automatic recovery leaves health monitoring and manual controls available but prevents every automatic step. Turning off only automatic page refresh still permits configured soft recovery (for example wait, play, rediscovery, and a configured retry control), while `PAGE_RELOAD` is removed from the plan and rejected again at authorization and commit time.

Adaptive behavior is local and bounded. It activates only after at least three sessions and 20 samples, can reorder safe actions using smoothed success rates, and never invents selectors, grants access, weakens safety suppressions, or silently expands the disruptive action set.

## Profiles and advanced player signals

Profiles are versioned JSON data. They may contain selectors, URL patterns, declared player type, recovery actions, and HTTPS backup URLs. Import validation strips unknown fields, rejects executable URL schemes, limits sizes, and never interprets code. Applying a profile changes settings only; the user must separately enable and grant the site.

The advanced bridge is off by default. When enabled per site, a data-minimized page-world script observes aggregate MSE append age/errors, hls.js/dash.js presence/errors, and WebRTC decoded/rendered/packet deltas. It does not read media payloads, network addresses, candidates, keys, credentials, or audio/video content. The website can forge MAIN-world messages, so bridge signals are treated as untrusted hints and cannot authorize recovery without independent media-element evidence.

The visual watchdog is also off by default and requires its own privacy acknowledgement. It is limited to the enabled site, its exact host permission, the elected primary player in the active visible top-level tab, and a minimum five-second sampling interval. Cropping, 8×8 downsampling, and fixed 64-bit hashing happen only in the privileged extension background; page-facing code receives the hash, never screenshot or data-URL bytes. Nested-frame sampling fails closed until trustworthy cross-frame coordinate transforms are available. A static picture can be legitimate, so visual evidence alone never authorizes automatic recovery. Browsers without background `createImageBitmap`/`OffscreenCanvas` support report the watchdog as unavailable and continue using media signals.

## Privacy and diagnostics

All settings, history, profiles, measurements, and learned outcomes stay in extension storage. Compact global defaults may be synchronized by the browser vendor under the user's browser account; per-site origins, selectors, URL rules, overrides, history, and models stay in the current browser profile. Stream Reviver has no telemetry endpoint or access to the browser vendor's sync service. Diagnostic history is bounded and can be disabled or cleared. The settings page can independently delete history, models, preferences, profiles, session state, or everything—including registered site scripts and acknowledgement state.

Diagnostic support bundles are redacted by default: origins become stable aliases, URL paths are removed, custom selectors are replaced, browser details are omitted, queries/fragments are never included, and metadata is allowlisted. The review dialog previews the exact bundle before download. Exact origins, paths, selectors, or browser details appear only if the user deliberately enables the corresponding export option; review any less-redacted bundle before sharing.

The extension cannot honestly promise a universal success percentage. Its popup and diagnostics report observed local action outcomes and user-rated false alarms so effectiveness can be measured on the actual sites and players used. See [Security](docs/SECURITY.md) and [Test matrix](docs/TEST_MATRIX.md).

## Known browser/site limits

- Fullscreen and Picture-in-Picture normally require a user gesture.
- Automatic player-iframe reload is temporarily disabled. Reloading destroys the authorizing frame identity, and the extension will fail closed until it can bind the replacement frame to the recovery ledger and verify sustained health under a new primary lease; configured safer actions and the loop-protected top-page reload fallback remain available.
- Cross-origin or sandboxed frames are controllable only when their exact origin is separately enabled and frame policy allows it. A large inaccessible embed can produce a limited-visibility advisory, but that advisory never requests permission or authorizes recovery.
- DRM/CDM internals, protected media payloads, native apps, closed shadow roots, remote-cast targets, and inaccessible player state cannot be inspected.
- A site may replace controls or reject synthetic clicks. Custom selectors improve reliability but are never guaranteed.
- Browsers may still discard, throttle, suspend, or terminate tabs/backgrounds despite best-effort protection.
- Visual monitoring is probabilistic and deliberately non-authoritative.
- Backup URLs are user-configured handoffs; the extension does not discover mirrors or bypass site controls.

Stream Reviver does not bypass DRM, CAPTCHAs, paywalls, access controls, anti-bot systems, or terms of service. The optional native-companion concept is intentionally not shipped; its security boundary is documented in [Native companion](docs/NATIVE_COMPANION.md).

## Production status

The repository now contains the complete local release-candidate implementation and enforceable build/test/package pipeline. The short single-browser soak harness, 20-scenario Chrome E2E lane, and Firefox lint/temporary-install smoke are local candidate gates; they are not substitutes for field evidence. Stable publication still depends on real-world evidence and third parties: a retained 24-hour continuous-soak report, the private-beta target, independent security/privacy review, public privacy-policy hosting, signed-package and N-1 upgrade tests, authorized store signing, and Chrome/Firefox store approval. These are tracked in [Release checklist](docs/RELEASE_CHECKLIST.md), [Validation plan](docs/VALIDATION_PLAN.md), and [Roadmap](ROADMAP.md). None of those external gates is claimed complete by this repository or by a local code run.

The current resumable development checkpoint, including its exact green local gates and intentionally unfinished external release work, is recorded in [Checkpoint](docs/CHECKPOINT.md).

## Disclaimer

> Disclaimer: This extension automatically reloads web pages and may affect playback behavior. Use it only on websites you have the right to access and in accordance with each site’s terms of service. Automatic refresh and fullscreen may not work on all websites due to browser security restrictions or site design. For a better viewing experience, we recommend using an ad blocker such as uBlock Origin and/or AdGuard. This extension does not guarantee stream availability and is not responsible for interrupted playback, site errors, or account actions taken by websites.
