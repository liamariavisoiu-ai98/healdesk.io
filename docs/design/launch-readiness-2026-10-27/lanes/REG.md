# Lane REG — make the registers and documents true (no behaviour change)
Model: Sonnet. Worktree `../healdesk-reg`, branch `lane/reg`. Read `_common.md` first.

Goal: remove wrong facts from handoff and registers. No behaviour change.

(a) `AGENTS.md` "Handoff snapshot" and "Last completed work package": the snapshot says VOICE-T20 / PR 60 is unmerged; it is merged as `0cc5fb87` and deployed (verify with `git log` and the deploy history in AGENTS.md). Remove the duplicated snapshot rows ("Last updated (UTC)", "Current task") that sit inside "Last completed work package". Rewrite the snapshot (field table) from the audit and Git: branch/HEAD of origin/main, current state of each item. Rewrite "Next actions" from `status.md` section 1 and 8, adding the owner's decisions of 27 Oct (below). Keep the top guidance unchanged. Do not invent progress.

Owner decisions of 27 Oct 2026 (in chat): launch WITH direct booking and deposits (so DB-1 and DEP-META proceed); Privacy/Terms support-email wording approved incl. a sentence that a drafted reply may be shown in the operator's Slack; `support@healdesk.io` may be printed (already decided earlier); `data-protection-agreement` may move to `on`; `never-say-meta` awaiting his answer (do not move); approval passcode NOT to be hardened (SEC-1 dropped); register stays platform-wide (per-channel blocking not changed).

(b) `apps/web/src/lib/admin/seo/launch.ts`: fix `left` text the code contradicts, citing the proving file:
- `direct-booking`: engine is wired into calls and web chat; the switch is refused by `infra/aws/locals.tf` `never_on_app_tasks` and `variables.tf` validation, so no route sets it today; left = addendum + a safe way to set the switch (DB-1 designs it).
- `data-protection-agreement`: migration 0104 is applied (22 Oct migration-state query read 112 applied; verify in `docs/`/AGENTS.md). Owner approved moving it to `on`: set status `on` and rewrite `left` accordingly (keep counsel's-review recommendation).
- `never-say-meta`: leave status `owner`; fix `left` to say qa:meta passed live 22 Oct (13/13) and the code is deployed; what remains is the owner's word.
- `no-audio`: agent code (`lib/voice/retell-agent.ts`) runs only from automatic provisioning, which is off (`voice_provision_enabled` false); say so.
Check `launch.ts` tests and `system-map.test.ts`.

(c) `docs/hipaa-compliance.md` vendor table and pre-launch list, and `docs/handover.md` "The rest of the BAA chain": mark Retell, Anthropic and the database as OWNER-REPORTED signed (not evidenced in the repo); RDS chosen and applied 14 Oct 2026 (`infra/aws/rds.tf`); PostHog opt-out since 23 Oct (verify in code); add Slack: no BAA, carries only drafted support replies, owner's decision 26 Oct (see CLAUDE.md). Fix "calendar not built yet" and "7-day outbox" style stale statements you find (verify each against code). Cite proof files.

(d) Do NOT edit `docs/v1-product-spec.md`. Write the proposed correction to the spec's "Where the chain is complete, and where it is not" table as a file `docs/design/launch-readiness-2026-10-27/spec-chain-table-proposal.md` (exact old and new rows).

(e) Do NOT edit `infra/aws/production.tfvars`. Write the proposed comment fix for `voice_desired` (comment says 2 survives a lost task; value is 1) into `docs/design/launch-readiness-2026-10-27/infra-comment-proposals.md` for the next infra batch.

Accept: `system-map.test.ts`, launch.ts tests, copy guard (`apps/web/src/lib/site-copy.test.ts`) and `node scripts/check-delivery-handoff.mjs` pass; every changed sentence cites the file that proves it.
