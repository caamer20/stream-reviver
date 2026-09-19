# Dependency risk register

Runtime bundles contain no third-party runtime library and make no external calls. Build dependencies are pinned through `package-lock.json`.

As of 2026-09-19, both runtime and full development dependency audits report zero vulnerabilities. CI and release packaging enforce `npm run audit:dependencies` at high severity, including development tooling.

The previous `image-size` exception is closed: the narrowly scoped `web-ext` override selects `addons-linter` 10.13.0, which uses patched `image-size` 2.0.4. Remove the override when `web-ext` itself adopts a fixed linter. The lockfile also updates `adm-zip` to 0.6.1 within `firefox-profile`'s supported range, addressing archive extraction and allocation findings. Mozilla lint and Firefox installation tests verify compatibility with these tooling changes.

Keep Node typings on the Node 24 release line. TypeScript 7 is not compatible with the compiler API used by the release no-egress scanner; upgrading it requires migrating that scanner and retaining all negative security fixtures. A passing type check alone does not validate that upgrade.
