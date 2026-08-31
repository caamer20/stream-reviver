# Emergency rollback and roll-forward runbook

Browser stores commonly prevent publishing an older version number over a newer one. Treat rollback as an emergency **roll-forward** built from the last-known-good source with a new patch version unless the store explicitly supports pausing or reverting the staged cohort.

## Triggers

Pause rollout immediately for any confirmed false reload in a protected category, permission expansion, data leakage, unrecoverable settings loss, update/install failure, high-severity security finding, or material popup/options regression. Reliability-target misses without user harm should stop expansion while the current cohort is investigated.

## Containment

1. Pause or halt the staged store rollout where supported.
2. Record affected version, stores, rollout percentage, first report time, browser/OS, and evidence link.
3. Preserve the exact signed packages, checksums, release evidence, and voluntarily supplied redacted diagnostics.
4. Post a concise support notice without asking users for private URLs, screenshots, credentials, or stream content.
5. If the defect is in automatic recovery, prepare a patch whose default disables the affected action while keeping monitoring/manual controls available.

## Recovery package

1. Branch from the recorded last-known-good tag; never rebuild from an uncommitted workspace.
2. Increment the patch version and document the containment change.
3. Run the complete tagged release gate, relevant regression fixtures, signed-package install, and N-1 settings migration.
4. Have two people verify the source/tag/provenance/package hash chain and the store permission diff.
5. Submit the emergency version through the authorized store accounts and request expedited review if the store offers it.

## Verification and follow-up

- Smoke the signed update on Chrome Stable and Firefox Stable before expanding it.
- Confirm settings, exact-origin permissions, registration state, acknowledgement, and local data survive the update.
- Review at 1, 4, 24, and 72 hours; record cohort size, new reports, and recovery evidence.
- Publish a root-cause report with the failed invariant, why tests missed it, corrective tests, affected versions, and retained artifact hashes.
- Resume normal rollout only after the incident owner and independent reviewer close every high-severity action.
