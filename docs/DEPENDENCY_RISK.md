# Dependency risk register

Runtime bundles contain no third-party runtime library and make no external calls. Build dependencies are pinned through `package-lock.json`.

As of 2026-08-29, `npm audit --omit=dev` reports zero shipped vulnerabilities. Full development audit reports high-severity denial-of-service advisories in `image-size`, reached only through Mozilla's `web-ext` → `addons-linter` tool. The upstream audit currently offers no safe fixed version and suggests an older breaking downgrade that remains in the affected range. The linter processes only repository-controlled extension images in CI/release work; it is not bundled or exposed to website/user input. Re-evaluate weekly through Dependabot and remove the exception immediately when upstream publishes a fix.
