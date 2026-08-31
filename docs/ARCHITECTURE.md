# Architecture

## Trust boundaries

The extension has four trust domains: extension pages/background, isolated content scripts, an optional MAIN-world observation bridge, and the untrusted website. The background owns settings, permission registration, the tab-wide primary-player lease, durable countdown/recovery state, profiles, local models, privileged tab operations, visual hashing, and the redacted Mission Control read model. Content scripts own DOM discovery, observations, diagnosis orchestration, in-page UI, and reversible player actions. The page bridge emits only a strictly bounded aggregate observation object; content treats it as untrusted supplemental evidence.

```text
Popup / Options / Welcome / Mission Control
          │ validated runtime messages
          ▼
Background ── split storage + exact-origin registration + badge + privileged actions
          │
          ├── isolated content script in every permitted frame
          │       ├── candidate cache, embedded-origin advisory, and frame coordinator
          │       ├── rolling observation window → typed diagnosis
          │       ├── policy plan → action → sustained verification
          │       └── closed-Shadow-DOM feedback/maximize/picker
          │
          └── optional MAIN-world bridge ← page/player APIs (untrusted)
```

## State flow

1. The popup requests an exact origin permission after explicit user enablement.
2. The background registers isolated scripts for that origin and an optional MAIN-world bridge.
3. Each permitted frame discovers visible videos incrementally, including videos in open shadow roots, and reports a scored status. A top page may separately report a large inaccessible cross-origin embed as `LIMITED_VISIBILITY`; that origin-only advisory cannot enable a site or start recovery.
4. The background elects one fresh tab-wide primary frame using playback, size, visibility, and freshness. Privileged actions and visual requests are bound to that primary identity and a short-lived one-use authorization.
5. A rolling observation window derives trends rather than reacting to a single event.
6. The classifier emits a typed diagnosis, confidence, evidence, recovery safety, and user-action requirement. Page-world hints require isolated media corroboration.
7. The policy engine filters diagnosis-specific actions through the separate `autoRecover` and `autoRefresh` controls, site settings, capability checks, action budgets, and resource availability.
8. The monitor executes one authorized action, then verifies sustained health. Exactly one terminal outcome is recorded for a recovery cycle/action; failure advances the plan and success records a local outcome.
9. Countdown, reload intent, action ledger, and restoration snapshots are written before navigation. Only the visible, continuously painted top-frame in-page countdown may commit its exact deadline. Session-backed state reconciles ownership and outcomes across navigation or MV3 worker suspension; a background alarm is a fail-closed watchdog that cancels a stale deadline and never performs the reload itself.
10. Exhausted plans or limits open a circuit and require a user reset. Sustained successful playback applies cooldown/reset behavior.

## Local data and read models

Compact global defaults are normalized into `storage.sync`. Per-site origins, selectors, URL rules, overrides, acknowledgements, bounded diagnostics, profiles, preferences, and learned outcomes stay in `storage.local`. Ephemeral status, leases, action ledgers, reload/circuit limits, and restoration snapshots use `storage.session` where available, with an expiring/pruned fallback. Split local/sync updates use a quota-aware transaction marker and rollback verification so a partial write does not become the active configuration.

Mission Control polls an extension-page-only background message for configured origins, fresh monitors, and recent recovery events. The background derives this read model from existing extension state, strips paths/queries/fragments, and returns only origins/hostnames plus bounded operational fields. Its focus action accepts only a fresh monitored tab that is still globally enabled, site-enabled, and permitted.

Diagnostic export is a separate explicit flow. Its default aliases origins and removes paths, selectors, browser details, unknown metadata, queries, and fragments. A preview is shown before download, and each less-redacted category requires a user-selected checkbox.

## Invariants

- No video and no configured error means no automatic refresh.
- An inaccessible embedded origin or other limited-visibility advisory never authorizes recovery or permission acquisition.
- Visual evidence alone never authorizes recovery.
- Access interruption, manual pause, offline, browser resume, intentional rewind, and configured hidden-tab policy suppress automation.
- Profiles cannot execute code or grant permissions.
- A recovery action is not successful until verification completes.
- A top-page reload is always loop-limited and preceded by a cancelable, continuously painted top-frame countdown bound to the exact route, recovery cycle, action, nonce, and monotonic deadline.
- A delayed, detached, hidden, unpainted, or unresponsive countdown cannot authorize navigation; the background deadline alarm can only cancel it.
- Settings/profile/model data remain local and bounded.
- Screenshot and data-URL bytes remain in the privileged background; only a fixed 64-bit visual comparison hash can cross to the requesting primary content script, and it is not persisted.
- Mission Control never exposes a monitored page path, query, or fragment.
- Privileged background messages are authorized by sender context and claimed origins are bound to the sender URL.
- Automatic configured-control clicks require one unambiguous safe target.
