# Firefox Add-ons submission — 3.1.5

## Version notes

Fixes monitoring on sites using custom ports in Firefox. Site monitoring remains opt-in per exact origin, while Firefox's underlying browser permission covers the chosen scheme and hostname across ports. Disabling one origin preserves a shared grant needed by another enabled origin; disabling the last removes the grant.

The optional advanced player bridge now initializes only in an authorized frame and re-checks its origin at execution time. It may miss player objects created before initialization; ordinary media monitoring remains available. Enable changes to this advanced option take effect on the next page load.

This release also updates development dependencies, adds real Firefox regression tests, and preserves verification reports and previous archives during release packaging. Fullscreen-after-refresh remains on by default and respects global/per-site opt-outs.

## Reviewer notes

The matching source archive is attached because the extension bundles TypeScript. It contains the complete tracked source, dependency lockfile, and build scripts; no private framework is required.

Build with Node.js 24.2.0 and npm 11.4.2:

```bash
npm ci
npm run build:stable
```

The output is `dist/stable/firefox`. No source maps or development permissions are shipped. The add-on makes no external API calls and transmits no data. Optional host access is requested only after the user enables a site; the manifest has no persistent host permissions. Firefox host grants span ports, but monitoring, recovery authorization, and optional bridge initialization remain scoped to explicitly enabled origins. The `alarms` permission is a fail-closed deadline watchdog, never a delayed-reload trigger.

Functional review:

1. Run `npm run build` and serve `dist/test-page` over HTTP, for example `python3 -m http.server 8080 --directory dist/test-page`.
2. Load `dist/firefox/manifest.json`, acknowledge the disclaimer, and enable `http://127.0.0.1:8080`.
3. Healthy playback and a manually paused video must not trigger recovery.
4. Use the error fixture to check the cancelable reload countdown and post-refresh fullscreen fallback. Repeat with Fullscreen after refresh disabled.
5. Serve the same fixture on port 9090: it must not be monitored until separately enabled. With both ports enabled, disabling one must leave the other functional; disabling the last must remove the shared host grant.

Automated equivalent: install geckodriver 0.37.1, set `FIREFOX_BIN` if necessary, and run `npm run test:firefox:e2e`. The headless harness seeds only a localhost optional grant in a disposable profile; it does not simulate human permission-prompt coverage.

Desktop Firefox only. Firefox for Android is not claimed or selected. Users with a previously ineffective custom-port grant may need to disable and re-enable that site to approve Firefox's corrected host pattern; no new grant is requested silently.
