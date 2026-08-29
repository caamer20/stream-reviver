# Store listing source

## Name

Stream Reviver

## Short description

Detect stalled live video, recover conservatively, and stop refresh loops—only on sites you explicitly enable.

## Detailed description

Stream Reviver is an opt-in safety net for live HTML5 streams. It watches sustained playback progress, buffering, errors, live-edge movement, and player changes. When evidence indicates a real failure, it starts with low-risk recovery actions and verifies the result. A page reload is a last resort with a visible cancelable countdown and persistent loop protection.

The extension works generically and supports optional per-site selectors. It protects manual pauses, offline/hidden tabs, normal VOD completion, access/sign-in/paywall/CAPTCHA interruptions, browser resume, and intentional behind-live viewing. Fullscreen falls back to a reversible page maximize when browser security requires a click.

Privacy is local by design: no analytics, tracking, advertising, external API, or remote code. Sites remain disabled until you grant one exact origin. Diagnostics and settings can be exported or deleted by category.

## Category and audience

Productivity / accessibility for users who legitimately watch long-running live video. Not intended to bypass DRM, access controls, site terms, or account restrictions.

## Screenshot plan

1. Popup showing a healthy stream and concise status.
2. Cancelable reload countdown on the local fixture.
3. Technical diagnosis/evidence expanded.
4. Per-site permission and recovery settings.
5. Privacy/data deletion controls.

Capture final screenshots from the signed stable candidate at store-required dimensions; do not use mockups or expose private sites/URLs.
