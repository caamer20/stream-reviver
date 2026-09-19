# Firefox Add-ons submission — 3.1.6

## Version notes

Fixes identifying text in manually exported diagnostic support bundles: old selector-save history and page-derived player labels are now redacted, and new history no longer records those raw values. The selector opt-in still includes current configured selectors, but not obsolete historical values. The extension sends no data automatically.

This patch also makes generated icon files byte-identical across build platforms without changing their pixels. New browser tests verify the actual preview/download redaction, Mission Control privacy, and rejection of focus requests for disabled or closed tabs.

## Reviewer build instructions

The matching source ZIP includes complete tracked source, the dependency lockfile, and generated SOURCE_BUILD.json metadata. No private Git checkout or private framework is needed. Use Node.js 24.2.0 and npm 11.4.2 on macOS or Linux, extract the ZIP, then run:

```bash
npm ci
npm run build:source
```

Output: `dist/source-archive/firefox`. The build validates the source inventory and hashes before compilation. `npm run verify:source` in the original Git checkout verifies that the actual extracted archive reconstructs both submitted browser packages. Normal stable release/tag enforcement remains intact.

## Functional review

1. Serve `dist/source-archive/test-page` over localhost HTTP and load the Firefox build in a disposable profile.
2. Acknowledge the disclaimer and enable the fixture origin. Healthy and paused playback must not recover. The error scenario exercises the cancelable reload countdown and fullscreen fallback; the setting's opt-out must remain effective.
3. Save a custom selector, open Settings → Diagnostics → Preview support bundle, and leave all identifying-detail checkboxes off. The preview and downloaded JSON must omit exact site origins, URL paths/queries/fragments, selector values, player labels, and exact browser details. Current selectors appear only after explicit selector opt-in. Legacy selector-save/player-selection events are summarized rather than revealing their old values.
4. Mission Control must not show page paths, queries, or fragments, and must reject focusing a disabled or closed target.

From a Git checkout, `npm run test:firefox:e2e` uses geckodriver 0.37.1 with a disposable profile and synthetic localhost data. It seeds a localhost optional grant, so it does not claim human permission-prompt coverage. `--capture-reviewer-video` additionally requires FFmpeg and records sampled real-browser screenshots of the synthetic error/refresh fixture, not real user streams.

The stable manifest's permissions are unchanged. No telemetry, external API calls, remote code, or automatic transmission is introduced. Desktop Firefox only; Firefox for Android remains unselected. The extension does not bypass site access controls.
