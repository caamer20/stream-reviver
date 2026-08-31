# Browser-store reviewer guide

Stream Reviver monitors live HTML5 video only on origins a user explicitly enables. On first run, acknowledge the disclaimer. Open the local fixture or any permitted HTML5 video page, open the popup, and enable that exact site. The browser permission prompt should name only that origin.

Use the fixture scenarios to review healthy playback, stall/error countdown, cancel, retry recovery, open-shadow and permitted-iframe discovery, manual pause suppression, access-interruption suppression, loop protection, and CSS maximize fallback. Automatic recovery (`autoRecover`) and automatic page reload (`autoRefresh`) are separate controls: disabling recovery stops every automatic step, while disabling page reload still permits configured safe/soft steps. Settings include independent data deletion and permission removal.

Open **Mission Control** from the popup or settings. It should show configured sites, fresh active monitors, and recent recovery outcomes using hostnames only. No page path, query, or fragment should appear. Focusing a monitor must fail safely if its status is stale or the site is no longer enabled/permitted.

For an unpermitted large cross-origin player frame, the top page may show a limited-visibility advisory containing only the frame's origin. It must not request that origin automatically or start recovery. Enable the embedded origin separately if review of that frame is required.

`storage` retains preferences and bounded local state. `activeTab` supports explicit controls and the separately acknowledged optional visual watchdog. A visual request is accepted only from the elected primary player in the active visible top-level tab on an enabled, exactly permitted origin; the background crops/downsamples/hashes the capture and returns no image bytes. `scripting` dynamically registers isolated content scripts after permission. `alarms` preserves one-shot recovery/countdown deadlines when the MV3 background is suspended; it does not grant site or browsing access and is not used for tracking. `notifications` is optional. `<all_urls>` is only an optional capability used to request one user-selected exact origin; it is never granted or requested as a standing all-sites permission.

There is no remote code, telemetry, analytics, advertising, external API, DRM/access-control bypass, or persistent broad host access. The optional MAIN-world bridge is disabled by default; its page messages are untrusted and cannot authorize recovery without independent media evidence.

The diagnostic-support dialog defaults to aliases/redactions for origins, URL paths, selectors, and browser details, never includes query strings/fragments or screenshot/hash data, and previews the exact bundle before download. Exact fields appear only when the reviewer deliberately enables their individual options.
