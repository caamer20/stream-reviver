# Firefox Add-ons submission — 3.2.0

## Version notes

Settings backups are validated before import. The review dialog shows the replacement, missing defaults, affected configurations, and sites that will be disabled. Applying an import checks each site deactivation before saving; failed operations report their partial result and reload saved state. Imported sites require individual re-enablement and access approval.

Mission Control adds hostname search, site-coverage and stream-status filters, visible matching counts, and expandable scrollable lists. Keyboard focus remains usable through live updates, hidden pages pause status polling, and stale status disables tab actions until a successful update.

Permissions, telemetry behavior, and conservative playback-recovery policy are unchanged. Build-tool maintenance removes the unused Android/ADB dependency chain and retains direct Mozilla lint plus real geckodriver install/behavior checks. Desktop Firefox only; Firefox for Android remains unselected.

## Reviewer build instructions

The matching source ZIP contains tracked source, the dependency lockfile, and generated `SOURCE_BUILD.json`. Use Node.js 24.2.0 and npm 11.4.2, extract the ZIP, then run:

```bash
npm ci
npm run build:source
```

Output: `dist/source-archive/firefox`. Source inventory and hashes validate before compilation. `npm run verify:source` in the tagged Git checkout verifies reconstruction of both submitted browser packages without relying on a private repository.

## Functional review

1. Load the build in a disposable Firefox profile, acknowledge the disclaimer, enable a localhost fixture origin, and confirm healthy and manually paused playback never recover automatically.
2. Open Mission Control, search by hostname, filter coverage/status, and confirm displayed labels omit paths, queries, and fragments. Keyboard focus must survive status updates; unavailable targets must reject tab-focus actions.
3. In Settings, choose a valid settings export. Inspect the replacement review and cancel: saved settings and grants must be unchanged. Apply a reviewed backup: imported values must persist and each imported site must remain disabled.
4. An unrelated JSON document or unsupported future schema must be rejected before replacing preferences or changing site access.
5. Preview a default support bundle and confirm origins, paths, selectors, browser details, unknown metadata, and legacy player/selector text remain redacted.

The stable manifest retains the same optional origin access and declares no data collection. No remote code or automatic external transmission is introduced. Store approval and signed upgrade verification are recorded separately from the GitHub engineering release.
