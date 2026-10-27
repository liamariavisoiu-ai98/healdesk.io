# Lane NOAUDIO-2 — prove the no-audio promise without depending on provisioning
Model: Opus. Worktree `../healdesk-noaudio`, branch `lane/noaudio-2`. Read `_common.md` first.

Context: promise `no-audio` (`launch.ts`): healdesk keeps no call audio and the voice provider holds a call a day at most. Agent-writing code `apps/app/src/lib/voice/retell-agent.ts` sets `data_storage_setting` and `data_storage_retention_days 1`, but runs only from automatic provisioning (off; `voice_provision_enabled` false). Today agents are made by hand.

Do:
1. Find how an existing (hand-made) clinic agent's storage settings are verified: `lib/voice/provision.ts` `verifyVoiceAgent`, `lib/ops/audit-ops.ts`, `lib/voice/backstop.ts`, `lib/voice/recording-alerts.ts`, the Retell client in `lib/voice/retell.ts`. Determine from the code whether an agent with the wrong `data_storage_setting` or retention would raise an alert today.
2. If not, add that check to the existing audit and recordings alert path (reusing its alert event names/dedupe; add to OPS_EVENTS only if required and follow the repo's alert conventions, `docs/` runbook entries, and the `fix-ops-alert` skill expectations). Read-only against Retell (GET agent) — no writes to Retell. Tests with a faked Retell client: a mis-set agent (wrong storage setting; retention over one day or unset) raises the alert; a correct agent does not; dedupe holds.
3. Write the owner's test-call run sheet `docs/design/launch-readiness-2026-10-27/no-audio-run-sheet.md` for the deletion check, reusing `docs/design/live-checks-checklist-2026-10-21.md` steps D to G (read it; on branch `pkg/live-checks` results may exist: `git show origin/pkg/live-checks:...` if present). Each step: exact action, what to see, pass/fail, how to clean up. The owner does it; you do not call Retell.
4. Update the `no-audio` register `left`/`evidence` text only if the code you add changes what is true (do not set `on`).
Accept: a test showing a mis-set agent raises the alert; run sheet present; verify passes.
