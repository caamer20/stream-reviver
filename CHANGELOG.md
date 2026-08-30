# Changelog

All notable changes follow Keep a Changelog conventions. Versions use semantic versioning.

## [Unreleased]

- External beta, long-duration soak, independent security review, and browser-store review remain release gates.

## [3.1.3] - 2026-08-30

### Changed

- Replace the jagged ring icon with a supersampled blue/violet product mark featuring a crisp play glyph and mint recovery loop.
- Share the new product mark across the toolbar, popup, options, and first-run experience for consistent branding.
- Add release validation for every required PNG size, RGBA transparency, manifest mapping, and non-empty rendered output.

## [3.1.2] - 2026-08-30

### Fixed

- Prevent Firefox from collapsing the action popup to its minimum dimensions by replacing viewport-relative root sizing with an explicit 390 × 600 CSS-pixel panel.
- Keep dense popup content scrollable inside the fixed panel while preserving an always-visible Settings and Disclaimer footer.
- Add release checks that reject viewport-relative popup roots and exercise the popup at Firefox's maximum supported panel height.

## [3.1.1] - 2026-08-29

### Fixed

- Keep the popup within Firefox and Chromium panel-height limits using compact, collapsible secondary sections and an always-visible footer.
- Await the browser settings-page request before closing the popup, preventing Firefox from canceling the request.
- Bind popup navigation controls before tab/status initialization so Settings remains available during recoverable API startup failures.
- Hide monitoring controls until the first-run disclaimer is acknowledged instead of showing an inert oversized panel.

## [3.1.0] - 2026-08-29

### Added

- Development, beta, and stable build channels with isolated Firefox IDs and deterministic build metadata.
- Strict per-message schema validation, sender authorization, origin binding, data deletion controls, and permission-revocation reconciliation.
- Explicit visual-watchdog privacy consent, selector safety previews, circuit verification states, localization scaffolding, and accessibility gates.
- 300+ deterministic unit/property cases, executable coverage thresholds, performance budgets, expanded browser fixtures, Chromium E2E, Firefox lint/install smoke, and parameterized soak testing.
- Deterministic Chrome/Firefox/source packages, SHA-256 release manifest, CycloneDX SBOM, CI, CodeQL, dependency checks, and release documentation.

### Security

- Page-world protocol signals are now untrusted hints and cannot authorize recovery without independent media evidence.
- Automatic configured-control clicks require one visible, enabled, unambiguous target outside sensitive dialogs, login, paywall, or CAPTCHA contexts.
- Normal finite-media completion is no longer escalated through the legacy live-stream fallback.

## [3.0.0]

- Introduced typed diagnosis, failure-specific recovery, verification, circuit breaking, local models, profiles, advanced bridge signals, and visual watchdog support.
