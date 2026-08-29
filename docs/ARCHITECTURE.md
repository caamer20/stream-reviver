# Architecture

## Trust boundaries

The extension has four runtime contexts: extension pages/background, isolated content scripts, an optional MAIN-world observation bridge, and the untrusted website. The background owns settings, permission registration, loop state, profiles, local models, and privileged tab operations. Content scripts own DOM discovery, observations, diagnosis orchestration, in-page UI, and reversible player actions. The page bridge emits only a strictly bounded aggregate observation object; content treats it as untrusted supplemental evidence.

```text
Popup / Options / Welcome
          │ validated runtime messages
          ▼
Background ── storage + exact-origin registration + badge + privileged actions
          │
          ├── isolated content script in every permitted frame
          │       ├── candidate cache and frame coordinator
          │       ├── rolling observation window → typed diagnosis
          │       ├── policy plan → action → sustained verification
          │       └── closed-Shadow-DOM feedback/maximize/picker
          │
          └── optional MAIN-world bridge ← page/player APIs (untrusted)
```

## State flow

1. The popup requests an exact origin permission after explicit user enablement.
2. The background registers isolated scripts for that origin and an optional MAIN-world bridge.
3. Each permitted frame discovers visible videos incrementally and reports a scored status.
4. The background selects the most relevant frame using playback, size, visibility, and freshness.
5. A rolling observation window derives trends rather than reacting to a single event.
6. The classifier emits a typed diagnosis, confidence, evidence, recovery safety, and user-action requirement. Page-world hints require isolated media corroboration.
7. The policy engine filters diagnosis-specific actions through user settings and resource availability.
8. The monitor executes one action, then verifies sustained health. Failure advances the plan; success records a local outcome.
9. Reload intent and snapshots are written before navigation. Loop limits survive reload in session storage.
10. Exhausted plans or limits open a circuit and require a user reset.

## Invariants

- No video and no configured error means no automatic refresh.
- Visual evidence alone never authorizes recovery.
- Access interruption, manual pause, offline, browser resume, intentional rewind, and configured hidden-tab policy suppress automation.
- Profiles cannot execute code or grant permissions.
- A recovery action is not successful until verification completes.
- A top-page reload is always loop-limited and preceded by a cancelable countdown.
- Settings/profile/model data remain local and bounded.
- Privileged background messages are authorized by sender context and claimed origins are bound to the sender URL.
- Automatic configured-control clicks require one unambiguous safe target.
