# Privacy policy

Effective: 2026-08-29

Stream Reviver has no analytics, advertising, tracking, telemetry endpoint, or external API. Extension code does not sell, share, or transmit user data.

## Data processed locally

- Synced extension storage: compact global preferences only, such as default detection and recovery behavior. Site origins, selectors, URL rules, backup URLs, and per-site overrides are excluded from the synced record.
- Local extension storage: per-site origins and rules, disclaimer/privacy acknowledgements, bounded diagnostic history, player preferences, declarative profiles, and locally learned recovery outcomes. This information stays in the current browser profile unless the user explicitly exports it.
- Session extension storage: current status, reload/circuit limits, expiring restoration snapshots, and session-visit markers when the browser supports it.
- Optional visual watchdog: after separate consent, the privileged extension background may capture the active visible top-level tab for an enabled, exactly permitted site. It validates that the request belongs to the elected primary player, crops and downsamples the selected player to 8×8, derives a fixed 64-bit comparison hash, and immediately releases the capture. Screenshot/data-URL bytes never enter the content script, storage, diagnostics, logs, or any network path. The bounded hash is returned only to the requesting extension content script for same-session comparison; it is never persisted or transmitted externally. Nested-frame sampling is disabled until its coordinates can be verified safely, and unsupported bitmap/canvas environments simply report the feature unavailable.
- Optional advanced bridge: aggregate player/library states and counters only. It does not read media bytes, keys, credentials, WebRTC candidates, SDP, IP addresses, or content.
- Embedded-player visibility: when the top page contains a large visible cross-origin frame that cannot be inspected, the extension may derive an origin-only `LIMITED_VISIBILITY` advisory from the frame element. It excludes hidden/small/same-origin/opaque/non-HTTP and sensitive-looking embeds, does not inspect the embedded document, does not request its permission, and never uses the advisory to authorize recovery.
- Mission Control: reads configured origins, fresh monitor summaries, and recent recovery outcomes already held by the extension. It displays hostnames only; page paths, queries, and fragments are removed by the background before the dashboard receives them. It sends no dashboard data anywhere.

Users choose each site origin and approve the browser permission prompt. Firefox host grants cover all ports on the selected scheme and hostname, but Stream Reviver authorizes monitoring and its optional player bridge only for explicitly enabled origins. Disabling a site stops its monitor and unregisters its scripts. A shared host grant is retained while another enabled origin needs it; disabling the last such origin requests removal of the grant. The settings page can delete history, models, preferences, profiles, session state, or all extension data. Import never grants site access.

Diagnostic support exports are redacted by default. Exact origins are replaced with stable per-export aliases, URL paths are removed, selectors are replaced with a redaction marker, browser details are omitted, metadata uses a small allowlist, and queries/fragments are never exported. The extension shows a preview before download. A user may deliberately include an exact origin, path, selector, or browser user agent by selecting its separate export option; those less-redacted files should be reviewed before sharing. Stream content, screenshots, cookies, credentials, and visual hashes are not included.

Global-preference sync, when enabled by the browser, is operated by the browser vendor under the user's browser account and policies. Stream Reviver has no independent access to that service. A one-time upgrade migrates older combined settings: it copies per-site rules into local storage, replaces the active synced record with global preferences only, and keeps a local migration backup so an interrupted write can be restored. Browser-vendor retention of earlier synchronized data is governed by that vendor's policies.

Settings updates are normalized, checked against the browser's available storage quota, and verified after writing. A short-lived local transaction record lets Stream Reviver restore the previous complete settings if one half of a split local/sync update fails. Chromium browsers are also asked, where supported, to restrict local storage access to trusted extension contexts. Firefox safely ignores that unsupported hardening call.

The extension does not bypass DRM, CAPTCHAs, paywalls, authentication, anti-bot controls, or site terms. This policy must be published at a stable HTTPS URL before store submission.
