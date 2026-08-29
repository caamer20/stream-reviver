# Browser-store reviewer guide

Stream Reviver monitors live HTML5 video only on origins a user explicitly enables. On first run, acknowledge the disclaimer. Open the local fixture or any permitted HTML5 video page, open the popup, and enable that exact site. The browser permission prompt should name only that origin.

Use the fixture scenarios to review healthy playback, stall/error countdown, cancel, retry recovery, iframe discovery, manual pause suppression, access-interruption suppression, loop protection, and CSS maximize fallback. Settings include independent data deletion and permission removal.

`storage` retains preferences and bounded local state. `activeTab` supports explicit controls and optional active-visible-tab visual sampling. `scripting` dynamically registers isolated content scripts after permission. `notifications` is optional. `<all_urls>` is only an optional capability used to request one user-selected exact origin; it is never granted or requested as a standing all-sites permission.

There is no remote code, telemetry, analytics, advertising, external API, DRM/access-control bypass, or persistent broad host access. The optional MAIN-world bridge is disabled by default; its page messages are untrusted and cannot authorize recovery without independent media evidence.
