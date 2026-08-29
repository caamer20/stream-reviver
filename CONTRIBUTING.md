# Contributing

Stream Reviver favors conservative behavior, least privilege, explainable decisions, and user control. A change that raises recovery success by increasing false reloads is not acceptable.

## Development workflow

1. Use Node.js 20 or newer and run `npm ci`.
2. Create a branch. Codex-generated branches use the `codex/` prefix.
3. Add deterministic tests for behavior and failure boundaries.
4. Run `npm run verify`, `npm run test:coverage`, `npm run test:performance`, and `npm run test:accessibility`.
5. For runtime changes, run `npm run test:e2e` and `npm run test:firefox`.
6. Explain permission, privacy, migration, and false-positive implications in the pull request.

Do not add remote code, telemetry, hidden network calls, hardcoded streaming-site behavior, DRM/access-control bypasses, or automatic clicks that are not uniquely and safely identified. New permissions require an architecture/security update and reviewer justification.

Settings migrations must preserve existing user intent, clamp untrusted input, ignore unknown fields, and keep imported sites disabled until permission is granted. UI changes must remain keyboard operable, zoomable, readable in forced-color mode, and usable with reduced motion.
