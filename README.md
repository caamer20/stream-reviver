# Stream Reviver 3.1

Stream Reviver is a privacy-first Chrome and Firefox extension that detects, explains, and safely recovers live-stream failures. It is generic and opt-in: it has no hardcoded streaming sites, analytics, trackers, remote code, or external API calls. A site is monitored only after the user acknowledges the disclaimer, enables that exact origin, and grants that origin permission.

Version 3 moves beyond a simple stall timer. It keeps a rolling observation window, classifies the failure type, selects a failure-specific recovery policy, verifies that each action actually restored sustained playback, and opens a circuit breaker when safe actions are exhausted.

## What is implemented

- Dynamic HTML5 video discovery in top-level documents and permitted frames.
- Stable primary-player scoring using visible area, playback, audio, readiness, interaction, and preview/ad penalties.
- SPA navigation, delayed injection, DOM churn, player replacement, page lifecycle gaps, and browser-resume handling.
- Rolling observations for media time, presented frames, buffer growth, seekable/live edge, lag, readiness, errors, dropped frames, and waiting events.
- Live/DVR/VOD classification and protection for intentional rewind.
- Typed diagnoses: offline, access interruption, user pause, browser resume, starvation, underrun, live-edge drift, decode/render freeze, source error, missing source, unexpected live end, player replacement, and WebRTC failure.
- Failure-specific recovery plans with configurable limits, backoff, jitter, and a circuit breaker.
- Transactional recovery verification: an action counts as successful only after sustained healthy playback.
- Recovery from soft to disruptive: wait, prompt, play, jump live, rediscover, configured retry, media reload, iframe reload, top-page reload, and explicit backup handoff.
- Cancelable/extendable reload countdown plus persistent reload-loop protection in session storage.
- State restoration for volume, mute, rate, captions, VOD position/live intent, scroll, CSS maximize, and a Picture-in-Picture prompt.
- Native fullscreen, a user-configured native control, reversible CSS maximize, and user-gesture prompts when browser policy blocks fullscreen.
- Optional, data-minimized MAIN-world bridge for aggregate MSE, hls.js, dash.js, and WebRTC health signals.
- Optional visual watchdog for video/canvas/iframe players. It hashes an 8×8 crop in memory, stores no screenshot, and never reloads from visual evidence alone.
- Event mode with faster healthy checks, screen wake lock when available, and best-effort tab discard protection.
- Local per-origin site models, outcome feedback, and adaptive reordering only after enough evidence. Nothing leaves the browser.
- Declarative, data-only site profiles with selectors, URL rules, recovery steps, player type, and backup URLs. Profiles cannot contain code and do not grant permissions.
- Popup status, diagnosis, evidence, buffer/live lag, event mode, manual controls, snooze, local feedback, and recent events.
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
  content/frame-coordinator.ts   frame visibility/status coordination and iframe recovery
  content/ui.ts                  closed-Shadow-DOM countdowns, prompts, maximize, picker
  page-bridge/bridge.ts          optional aggregate MSE/player/WebRTC observations
  popup/                         current-tab controls and status
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
  soak.mjs                       repeatable browser soak runner (24-hour release mode)
  release-check.mjs              permission, CSP, network-code, size, and checksum checks
  package.mjs                    deterministic archives and CycloneDX SBOM
test/                            local HTML media simulator and iframe fixture
tests/                           health, diagnosis, policy, schema, profile, and security tests
docs/                            architecture, security, native-companion boundary, test matrix
dist/chrome/, dist/firefox/      development unpacked builds (legacy convenient layout)
dist/{development,beta,stable}/  isolated channel outputs
artifacts/                       generated release ZIPs, hashes, and SBOM (ignored)
```

Chrome uses an MV3 service worker. Firefox uses an MV3 non-persistent background script with the same bundle and Gecko metadata declaring no data collection. Firefox 140+ is targeted for the current manifest declaration.

## Build and verify

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run verify
npm run test:coverage
npm run test:performance
npm run test:accessibility
npm run test:e2e
npm run test:firefox
npm run release:check
npm run package
```

- `npm run check`: strict TypeScript check.
- `npm test`: deterministic unit/integration tests.
- `npm run build`: produces both browser builds and the fixture.
- `npm run test:e2e`: launches an isolated Chromium profile and exercises real extension APIs against localhost.
- `npm run build:channels`: produces isolated Development, Beta, and Stable Chrome/Firefox builds; stable and beta omit source maps.
- `npm run test:coverage`: enforces 90% lines, 85% branches, and 90% functions against executable test bundles.
- `npm run test:performance`: enforces conservative throughput budgets for hot-path pure logic.
- `npm run test:accessibility`: checks the localization, keyboard-focus, reduced-motion, forced-color, and semantic UI baseline.
- `npm run test:firefox`: runs Mozilla's linter and installs the build temporarily in headless Firefox.
- `npm run test:soak:smoke`: runs one repeated-browser soak cycle; `npm run test:soak -- --hours 24` is the long release gate.
- `npm run release:check`: checks stable permissions, localization, CSP, no dynamic/remote/network code, package size, and SHA-256 inventory.
- `npm run package`: creates deterministic Chrome, Firefox, and source ZIPs plus a CycloneDX SBOM in `artifacts/`.

The E2E test temporarily adds only its random localhost origin to a copied manifest. Release manifests remain optional-permission-only.

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

## Permission model

- `storage`: settings, acknowledgement, bounded history, preferences, profiles, local models, and session recovery state.
- `activeTab`: user-initiated controls and active-visible-tab visual sampling.
- `scripting`: register/inject scripts after an exact origin is enabled.
- Optional `notifications`: requested only if notifications are enabled.
- Optional `<all_urls>` capability: allows the extension to request one exact origin chosen by the user. It is not a standing all-sites grant. Enabling `https://example.com` requests `https://example.com/*`; disabling it unregisters scripts and revokes that origin.

There is no `tabs` permission, no broad `host_permissions`, no remote code, and no network service. Some browser methods expose non-sensitive tab fields once an origin or `activeTab` is granted; the extension uses only what is needed for the enabled tab.

## Detection and recovery behavior

The default detection is deliberately conservative: 15-second load grace, three-second checks, 12-second stall timeout, three confirming checks, and a confidence threshold. Buffering alone is insufficient. Explicit errors are strongest; user pause, access/CAPTCHA/paywall/sign-in interruption, offline state, hidden-tab policy, ad transitions, browser resume, and intentional behind-live viewing suppress or delay automation.

Policies differ by diagnosis. Live-edge drift seeks live first. Buffer starvation waits and retries before reload. Source errors prioritize a configured retry. Access interruptions never recover automatically. Disruptive actions are capped and page reload requires a visible countdown. After an action, the extension requires sustained healthy playback before recording success; otherwise it escalates. When actions or reload limits are exhausted, the circuit opens and requires the user to retry/reset.

Adaptive behavior is local and bounded. It activates only after at least three sessions and 20 samples, can reorder safe actions using smoothed success rates, and never invents selectors, grants access, weakens safety suppressions, or silently expands the disruptive action set.

## Profiles and advanced player signals

Profiles are versioned JSON data. They may contain selectors, URL patterns, declared player type, recovery actions, and HTTPS backup URLs. Import validation strips unknown fields, rejects executable URL schemes, limits sizes, and never interprets code. Applying a profile changes settings only; the user must separately enable and grant the site.

The advanced bridge is off by default. When enabled per site, a data-minimized page-world script observes aggregate MSE append age/errors, hls.js/dash.js presence/errors, and WebRTC decoded/rendered/packet deltas. It does not read media payloads, network addresses, candidates, keys, credentials, or audio/video content. The website can forge MAIN-world messages, so bridge signals are treated as untrusted hints and cannot authorize recovery without independent media-element evidence.

The visual watchdog is also off by default. It is limited to the active visible tab, reduces a crop to a 64-bit-style perceptual pattern in memory, and discards the screenshot immediately. A static picture can be legitimate, so visual evidence alone never authorizes automatic recovery.

## Privacy and diagnostics

All settings, history, profiles, measurements, and learned outcomes stay in extension storage. There is no telemetry endpoint. Diagnostic history is bounded and can be disabled or cleared. The settings page can independently delete history, models, preferences, profiles, session state, or everything—including registered site scripts and acknowledgement state. Exports can contain page URLs and user-defined selectors; review them before sharing.

The extension cannot honestly promise a universal success percentage. Its popup and diagnostics report observed local action outcomes and user-rated false alarms so effectiveness can be measured on the actual sites and players used. See [Security](docs/SECURITY.md) and [Test matrix](docs/TEST_MATRIX.md).

## Known browser/site limits

- Fullscreen and Picture-in-Picture normally require a user gesture.
- Cross-origin or sandboxed frames are controllable only when permission and frame policy allow it.
- DRM/CDM internals, protected media payloads, native apps, closed shadow roots, remote-cast targets, and inaccessible player state cannot be inspected.
- A site may replace controls or reject synthetic clicks. Custom selectors improve reliability but are never guaranteed.
- Browsers may still discard, throttle, suspend, or terminate tabs/backgrounds despite best-effort protection.
- Visual monitoring is probabilistic and deliberately non-authoritative.
- Backup URLs are user-configured handoffs; the extension does not discover mirrors or bypass site controls.

Stream Reviver does not bypass DRM, CAPTCHAs, paywalls, access controls, anti-bot systems, or terms of service. The optional native-companion concept is intentionally not shipped; its security boundary is documented in [Native companion](docs/NATIVE_COMPANION.md).

## Production status

The repository now contains the complete local release-candidate implementation and enforceable build/test/package pipeline. Stable publication still depends on real-world evidence and third parties: the 24-hour soak, private beta target, independent security/privacy review, public privacy-policy hosting, authorized store signing, and Chrome/Firefox store approval. These are tracked in [Release checklist](docs/RELEASE_CHECKLIST.md), [Validation plan](docs/VALIDATION_PLAN.md), and [Roadmap](ROADMAP.md). They cannot be truthfully marked complete by a local code run.

## Disclaimer

> Disclaimer: This extension automatically reloads web pages and may affect playback behavior. Use it only on websites you have the right to access and in accordance with each site’s terms of service. Automatic refresh and fullscreen may not work on all websites due to browser security restrictions or site design. For a better viewing experience, we recommend using an ad blocker such as uBlock Origin and/or AdGuard. This extension does not guarantee stream availability and is not responsible for interrupted playback, site errors, or account actions taken by websites.
