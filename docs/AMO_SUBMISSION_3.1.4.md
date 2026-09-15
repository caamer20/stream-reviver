# Firefox Add-ons submission — 3.1.4

## Version notes

Stream Reviver 3.1.4 adds reliable, default-on fullscreen restoration after an automatic page refresh. Users can disable the behavior globally or per site. The extension attempts native player fullscreen first and falls back to a reversible viewport-filling layout or a user-click prompt when Firefox requires a user gesture.

This release also keeps the maximize request bound to the recovery cycle that performed the reload, retries transient startup/primary-election races only during a bounded two-minute window, and ensures saved layout preferences cannot bypass the user’s opt-out.

## Reviewer notes

The extension contains bundled TypeScript output, so the matching source archive is attached. The source is complete and does not rely on a private framework.

Build environment:

- Node.js 24.2.0
- npm 11.4.2
- macOS for the submitted artifact; the build is also designed for Ubuntu with the pinned Node/npm toolchain

Rebuild commands:

```bash
npm ci
npm run build:stable
```

The Firefox output is written to `dist/stable/firefox`. `npm run package` runs the complete clean-tree release gate and creates deterministic browser/source archives, a CycloneDX SBOM, checksums, and provenance under `artifacts/`.

Functional review:

1. Run `npm run build`.
2. Serve `dist/test-page` using `python3 -m http.server 8080 --directory dist/test-page`.
3. Temporarily load `dist/firefox/manifest.json`.
4. Acknowledge the disclaimer and enable `http://127.0.0.1:8080`.
5. Select the error scenario and allow the cancelable reload countdown to finish.
6. After reload, Stream Reviver attempts fullscreen; Firefox may require a click, in which case the reversible CSS fallback fills the viewport.
7. Turn off **Fullscreen after refresh** in Settings and repeat to confirm the refreshed page remains unchanged.

The add-on makes no external API calls and transmits no data. Site access is optional and requested one exact origin at a time. The `alarms` permission is used only as a fail-closed deadline watchdog and never performs a delayed reload.
