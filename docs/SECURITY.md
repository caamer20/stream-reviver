# Security and privacy model

## Protected assets

Stream Reviver protects browsing intent, visited stream URLs, local selectors/profiles, playback preferences, diagnostic history, and the ability to reload or control an enabled page.

## Main threats and controls

- **Malicious page/extension messages:** every message uses a per-type exact schema, contains no prototype-pollution keys, stays within depth/item limits, and serializes below 128 KB. The background authorizes each type for a content or extension-page sender and binds claimed origins/URLs to the sender. MAIN-world bridge data is separately reconstructed, freshness/rate limited, and cannot authorize recovery without independent media evidence.
- **Remote-code injection and unintended egress:** extension pages use a deny-by-default CSP: scripts/styles stay self-hosted, connect/media/frame/form/object access is denied, and base/ancestor injection is blocked. Build output contains no `eval`, `new Function`, or remote script reference. An AST-based release gate rejects direct or aliased `fetch`, XHR, EventSource, WebSocket, beacon, dynamic image/form, and navigation egress. Its only reviewed navigation exception is the user-clicked, user-configured backup handoff. Visual captures are decoded directly from a bounded local data URL in the privileged background without an image element or network primitive. Profiles are data-only and unknown fields are removed.
- **Permission creep:** the release manifest has no persistent host permissions. The user enables each exact origin; Firefox's browser grant covers its scheme/hostname across ports. Unenabled sibling origins cannot initialize monitors or create model/session records. The optional MAIN-world player bridge is injected into an authorized frame only and checks the expected origin again at execution time. Disabling a site unregisters its scripts; the shared grant is removed when no other enabled origin needs it.
- **Unsafe synthetic controls:** configured controls must resolve to exactly one visible, enabled, meaningfully sized target outside login/paywall/CAPTCHA modal contexts. Settings provide a live match/risk preview.
- **Refresh loops:** page/iframe actions have time-window limits, backoff, verification, pre-navigation state, and a circuit breaker.
- **False recovery:** multi-signal confirmation, confidence thresholds, page grace, pause/access/offline/lifecycle suppression, and diagnosis-specific policies reduce single-signal reactions.
- **Inaccessible embedded players:** a top page can report only a bounded origin-only advisory for a large visible cross-origin frame. Same-origin, hidden, small, opaque, credential-bearing/non-HTTP, ad/auth, and other sensitive-looking frames are excluded. The advisory is non-actionable: it cannot request permission, elect a player, or authorize recovery. A permitted healthy child frame takes precedence.
- **Sensitive screenshots:** visual sampling requires both acknowledgements, global/site/feature enablement, the exact origin permission, fresh elected-primary ownership, and the active visible top-level tab. Requests are bounded, single-flight, and rate limited. The privileged background alone crops/downsamples and hashes the capture; only a fixed 64-bit hash crosses to the content script, no image or data-URL bytes leave the background, nothing is stored, nested frames fail closed, and visual evidence cannot trigger recovery by itself.
- **Dashboard and support-data disclosure:** Mission Control is callable only by extension pages and receives an origin/hostname-only, bounded, fresh read model. It never receives page paths, queries, or fragments, and its focus command is re-authorized against the current enabled/permission/freshness state. Diagnostic exports alias origins and remove paths, selectors, browser details, and unknown metadata by default; a preview and individual opt-in switches guard every less-redacted category.
- **Sensitive WebRTC/media data:** the bridge emits aggregate counters and state only—never candidates, IPs, SDP, keys, media bytes, or content.
- **Unbounded local data:** histories, profiles, models, and snapshots are capped or expired.

## Data inventory

`storage.sync` holds only compact global preferences. `storage.local` holds every per-site origin, selector, URL rule, backup URL, and override, plus acknowledgement, bounded history, preferences, profiles, local outcome models, and a recoverable settings-migration backup. A short-lived local transaction marker makes split local/sync settings writes rollback-safe; Chromium is asked to expose local storage only to trusted extension contexts when that API is available. `storage.session` holds reload/circuit state, current status, session visits, and expiring restoration snapshots when supported; local fallback is pruned. No data is transmitted by extension code.

## Release checks

Run `npm run release:check`. It enforces test coverage, performance, accessibility, stable Manifest V3 builds, the exact permission set, optional-only host capability, the exact hardened extension CSP, absence of broad `host_permissions`, AST-based generated-code no-egress fixtures, size budgets, localization assets, and SHA-256 checksums. The deterministic ZIP policy also rejects duplicate/unsafe paths and modes, ZIP32 overflow, symlinks, and nondeterministic entry order while preserving Unix regular/executable modes. The full dependency audit includes development tools; the former Mozilla-linter exception is closed in `docs/DEPENDENCY_RISK.md`.

## Reporting and scope

This repository is currently a local/private project. The default diagnostic bundle is redacted, but review its preview before download and review any deliberately less-redacted export before sharing because exact origins, paths, selectors, or browser details may be identifying. Browser/platform vulnerabilities and site-origin security issues are outside the extension's boundary.
