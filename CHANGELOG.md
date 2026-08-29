# Changelog

All notable changes follow Keep a Changelog conventions. Versions use semantic versioning.

## [Unreleased]

- External beta, long-duration soak, independent security review, and browser-store review remain release gates.

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
