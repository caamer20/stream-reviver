# Native companion research boundary

A native companion could theoretically detect OS sleep/network changes, keep a device awake more reliably, or coordinate external players. It is intentionally not implemented in v3.

Shipping one would materially expand privileges, installation complexity, update risk, and the data boundary. It must not be used to bypass DRM, browser policy, CAPTCHA, paywalls, protected playback paths, or site controls.

Before implementation, require a separate threat model and user decision covering:

- explicit opt-in installation and mutually authenticated native messaging;
- a minimal allowlisted protocol with no arbitrary command or URL execution;
- signed, reproducible platform packages and an independent update process;
- no media capture, credential access, browser-profile reading, or traffic interception;
- a visible connection state and one-click revocation;
- Windows, macOS, and Linux sandbox/permission review;
- privacy disclosure, retention rules, and security response ownership;
- measurable benefits that browser-only APIs cannot safely provide.

The extension remains fully functional without a companion. This document is a gate, not a hidden roadmap commitment.
