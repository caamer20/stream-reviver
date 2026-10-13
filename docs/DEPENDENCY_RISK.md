# Dependency risk register

Runtime bundles contain no third-party runtime library and make no external calls. Build dependencies are pinned through `package-lock.json`.

As of 2026-10-12, both runtime and full development dependency audits report zero vulnerabilities for the 3.2.0 candidate. CI and release packaging enforce `npm run audit:dependencies` at high severity, including development tooling.

The build now uses Mozilla `addons-linter` 10.13.0 directly, with warnings treated as failures. Firefox temporary installation is verified through Mozilla geckodriver in an explicit disposable profile. Removing `web-ext` removes its unused Android/ADB dependency chain, including the unpatched `node-forge` signature-verification finding; it also removes the former Firefox launcher and shell-quoting chain. The audit gate is not suppressed.

Compatible overrides select patched `fast-uri` 3.1.8, `source-map-js` 1.2.2, and `undici` 7.30.0 for the linter's dependency tree. The pinned linter retains patched `image-size` 2.0.4. Mozilla lint rejects invalid and warning-only fixtures; Firefox installation and behavioral tests verify the replacement tooling. Review and remove these overrides when their parents adopt the patched versions.

Keep Node typings on the Node 24 release line. TypeScript 7 is not compatible with the compiler API used by the release no-egress scanner; upgrading it requires migrating that scanner and retaining all negative security fixtures. A passing type check alone does not validate that upgrade.
