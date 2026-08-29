# Security and privacy model

## Protected assets

Stream Reviver protects browsing intent, visited stream URLs, local selectors/profiles, playback preferences, diagnostic history, and the ability to reload or control an enabled page.

## Main threats and controls

- **Malicious page messages:** runtime messages must use a known type, contain no prototype-pollution keys, stay within depth/item limits, and serialize below 128 KB. MAIN-world bridge data is separately reconstructed field-by-field.
- **Remote-code injection:** extension CSP permits scripts from self only. Build output contains no `eval`, `new Function`, or remote script reference. Profiles are data-only and unknown fields are removed.
- **Permission creep:** the release manifest has no persistent host permissions. The user grants an exact origin through the browser permission prompt. Disabling a site unregisters scripts and requests permission removal.
- **Unsafe synthetic controls:** configured controls must be visible, enabled, meaningfully sized, and outside login/paywall/CAPTCHA modal contexts.
- **Refresh loops:** page/iframe actions have time-window limits, backoff, verification, pre-navigation state, and a circuit breaker.
- **False recovery:** multi-signal confirmation, confidence thresholds, page grace, pause/access/offline/lifecycle suppression, and diagnosis-specific policies reduce single-signal reactions.
- **Sensitive screenshots:** visual sampling requires the active visible tab, is opt-in, hashes an 8×8 crop in memory, stores no image, and cannot trigger recovery by itself.
- **Sensitive WebRTC/media data:** the bridge emits aggregate counters and state only—never candidates, IPs, SDP, keys, media bytes, or content.
- **Unbounded local data:** histories, profiles, models, and snapshots are capped or expired.

## Data inventory

`storage.sync` holds settings and per-site rules. `storage.local` holds acknowledgement, bounded history, preferences, profiles, and local outcome models. `storage.session` holds reload/circuit state, current status, session visits, and expiring restoration snapshots when supported; local fallback is pruned. No data is transmitted by extension code.

## Release checks

Run `npm run release:check`. It rebuilds, validates Manifest V3, the exact permission set, optional-only host capability, extension CSP, absence of broad `host_permissions`, absence of common dynamic/remote-code constructs, and creates SHA-256 checksums.

## Reporting and scope

This repository is currently a local/private project. Review exported diagnostics before sharing because URLs and custom selectors may be identifying. Browser/platform vulnerabilities and site-origin security issues are outside the extension's boundary.
