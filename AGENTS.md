# Agent instructions

This repository's working instructions live in **[CLAUDE.md](./CLAUDE.md)**.
Read it before adding any surface — it is short, and the first section decides
where new code is allowed to go.

What the product is and does is decided by
**[docs/v1-product-spec.md](./docs/v1-product-spec.md)**. Since 22 October 2026
it is the source of truth itself: edit it directly. The live task list is the
"Launch plan" tab of the old source doc. Where any other doc disagrees with the spec about what the
product does, the spec wins.

The one rule to carry even if you read nothing else:

> **`apps/web` handles NO patient data and has no database client.**
> **`apps/app` handles PHI and must stay portable off Vercel.**
> If it needs the database, it goes in `apps/app`.
> Clinics DO sign in, to the clinic portal in `apps/app`. `/admin` is ours.

`docs/hipaa-compliance.md` is authoritative for what counts as PHI.

---

# Continuously maintained session handoff

**Purpose:** This is a concise, persistent resume pointer, **not** a second product specification or a claim that a previous session succeeded. Read [CLAUDE.md](./CLAUDE.md), [product spec](./docs/v1-product-spec.md), [master delivery plan](./HEALDESK_CLAUDE_CODE_LAUNCH_EXECUTION_PLAN.md), and [session-start protocol](./docs/claude-session-start.md) first. Keep this section brief (ideally under 100 lines); link to PRs, issues and CI rather than copying lengthy logs.

**Rules:** Verify this snapshot against Git, actual code and CI on every restart. Never store credentials, tokens, PHI, signed agreements or sensitive production logs. Do not overwrite unrelated uncommitted work. Separate `CODE`, `TESTED`, `DEPLOYED`, `LIVE VERIFIED` and `OWNER APPROVED`.

## Handoff snapshot
| Field | Current value |
| --- | --- |
| Last updated (UTC) | 2026-10-22 |
| Current task | Launch-readiness handover H0 to H8 ([docs/design/launch-readiness-handover-2026-10-21.md](./docs/design/launch-readiness-handover-2026-10-21.md)) plus the owner's 22 Oct additions (Spanish voice, Stripe quantity check, location confirm screen, Meta front-door rebuild, live Retell checks) |
| Status | CODE complete and TESTED locally on every package; the combined branch was verified green at 854b6af1, but five later merges (spanish-voice, retell-Sloane default, Retell 404 fix, no-audio copy H3, Meta front-door fix) have NOT been re-verified together. Nothing is pushed to `main`; only `check/*` branches exist on origin from earlier work |
| Branch / HEAD | Combined branch `integ/launch-ready` (worktree `/Users/liamariavisoiu/projects/healdesk-launch-ready`), content head 3ca17c67; this handoff is the next commit. `main` is still 9f00d088 |
| Worktree | Main checkout clean. Many `../healdesk-*` worktrees hold package branches (see below); remove with `git worktree remove` once landed |
| Approved scope | Owner (22 Oct, in chat) approved: merge everything to `main`, SEC-02 "go", locations rollout wording, `enable_voice` via Terraform after the code is deployed. See "Owner rulings (2026-10-22)" |
| Next action | Verify `integ/launch-ready` as a whole at its final head (migrations 0000 to 0110 from zero plus the upgrade path, full `apps/app` suite, catalog, web, tsc, lint, gitleaks, `scripts/check-delivery-handoff.mjs`), push `check/launch-ready`, read its CI once, then merge to `main` and deploy |
| Blocker | CI result not yet seen; `voice_real_calls` held until a Spanish/English test call passes; Anthropic key org must be the HIPAA one (owner to confirm) |

## Last verified / reported evidence
- **Owner-reported:** Retell and Anthropic agreements signed, database coverage confirmed, Retell secrets and `RESEND_API_KEY` in AWS Parameter Store, counsel review of the amended BAA/DPA "done and approved" (the owner's ruling, not a counsel sign-off Claude saw).
- **Tests (local, isolated Postgres, 21-22 Oct):** H0 reviews of 8 branches (fixes on `review/*`, merged); round 2 at 854b6af1: migrations 111 apply from zero and via the 108-to-110 upgrade path, `apps/app` 266 files 6288+ passed (1 timing flake passes alone), catalog 1980, web touched tests 218, tsc and lint clean, gitleaks clean, handoff check passes. Since then: H3 targeted web 2424, app 674, catalog 1980; Meta fix 10 suites 1235; Spanish voice 20+ files green.
- **LIVE VERIFIED (22 Oct, demo-safe throwaways only; results in `docs/design/live-checks-results-2026-10-22.md` on `pkg/live-checks`):** Retell `custom-llm` field names, storage values, `["en-US","es-419"]`, delete-call route (a missing call is JSON 404, a wrong route is an HTML 404; code now counts only the JSON one as gone); `qa:meta` 13/13 on the second run (one sample). Anthropic `restart_only` deploy run 39733503467 succeeded (services re-read parameters).
- **Not verified:** a real call reaching `src/voice/server.ts`; Spanish speech quality and the mixed `en-US`/`es-419` agent; `/admin/map` live; production behaviour of 0105 to 0110; the Retell workspace holding the owner's agent ids (the key in `~/.healdesk-live-checks.env` sees only 3 marketing demo agents); the three live demo agents store transcripts 30 days (`everything_except_pii`) while code and Privacy say none.

## Last completed work package
Launch-readiness H0 to H8 on local branches (none pushed to `main`): `pkg/voice-provisioning` (0106), `pkg/ended-early-redial` (0107), `pkg/locations-land` (0108), `pkg/location-confirm` (0109), `pkg/location-stripe-qty` (0110), `pkg/test-debt`, `pkg/voice-eval` (dry-run only; first paid run is the owner's), `pkg/live-checks`, `pkg/urgent-spanish`, `pkg/spanish-guard`, `pkg/spanish-voice`, `pkg/no-audio-copy`, `pkg/meta-frontdoor-fix`, `pkg/security-hygiene` (SEC-01), `pkg/deps-security` (SEC-02); review fixes on `review/alert-noaudio`, `review/book-deposit`, `review/guard`, `review/screen-turn`, `review/deposit-gap`. `pkg/retell-404-fix` is superseded by 4c7f1704 (another session's version). Earlier: DPA 1.0.0 release is on `main`; the epic branch `claude/epic-babbage-n9g119` was NOT updated (fdbbd696).

## Next actions — ordered
1. **Claude Code:** final whole-branch verification, then push `check/launch-ready` (allowed), read CI once; fix only what it shows.
2. **Claude Code, with the owner's 22 Oct approval:** merge to `main`; `apps/web` auto-deploys on Vercel, so dispatch `deploy-app.yml` straight after (hash-check hazard: the old app image rejects signed agreements while web carries the amended text); then set `enable_voice` in `infra/aws/production.tfvars` and dispatch `infra.yml`; add a `voice_provision` Terraform variable (HEALDESK_VOICE_PROVISION_ENABLED is not delivered by `infra/aws` today).
3. **Hold:** `voice_real_calls` until a test call passes and the owner says go. Do not set `HEALDESK_DIRECT_BOOKING_ENABLED`.
4. **Owner:** switch on `billing-notices` (also `daily-summary`, `weekly-recap`) in `/admin/ops`, set alert recipients; confirm the Anthropic key in AWS is the HIPAA org's; decide the three live demo agents' storage; the spec (`docs/v1-product-spec.md`) is now edited in place and is the source of truth (owner, 22 Oct): lines 724, 769 and 791 say Retell holds a call's transcript and recording until healdesk has the transcript and for no more than a day; the old Claude Doc is stale for the spec text (its Launch plan tab is still the task list); native-speaker and counsel review of the Spanish lines; give the Retell key of the workspace that holds the product agent; add Anthropic credit as needed; run the first paid voice-eval; GitHub security settings and branch protection (SEC-01 list); vendor attestations on `/admin/compliance`.
5. **Open owner questions:** do messages in a language AYA does not answer in raise a clinic alert (built: no)? Does the practice runner count other-language urgent hits (built: yes)? Which packages go in `LOCATIONS_READY_PACKAGES` (still empty)?

## Owner approvals and restrictions

### Owner rulings (2026-10-21)
- **Window-gated replies to a patient's open request are allowed** (a Meta reply deciding or rescheduling a booking request, sent by `sendMetaReply` inside the 24-hour window). `CLAUDE.md` "Inbound only" now says so. The spec's "Outbound" rows are unchanged; the source doc may need the same clarification before the next re-export.
- **ALERT-01:** `urgent-alert` stays `on` in the launch register. The owner is adding `RESEND_API_KEY` in AWS Parameter Store and will switch on `billing-notices`; the code must make the "I've told the team" claim depend on them.
- **NOAUDIO-01:** create or update Retell agents with call-data storage restricted in code. No fail-closed check on real calls; instead an admin-console alert when a call was recorded, with a button that deletes that recording through the Retell API from `apps/app`.

### Owner rulings (2026-10-22)
- Accepted: pale/white/grey lip or skin stays urgent even in laser questions; a bare "Socorro" (a name) is not urgent.
- Locations: keep the "confirm its address, hours and phone numbers" toast and build the screen (done: `pkg/location-confirm`); build the hourly Stripe-quantity check (done: `pkg/location-stripe-qty`, switched off by default); release the acknowledgement wording; the rollout switch waits.
- SEC-02 "go" (lands with the rest). Merge everything to `main`. `enable_voice` through Terraform after deploy; `voice_real_calls` is held for a test call.
- Spanish voice: opener by caller language (English line first, Spanish disclosure said once when Spanish is detected), Retell locale `["en-US","es-419"]`.

### Hard stops
No merge, push, production deploy, Terraform apply, live vendor changes, real patient traffic, compliance attestation or final go-live without specific Owner approval. Preserve existing code and report any dirty worktree.

## End-of-session update contract
Before stopping, replace stale values above with **actual** task ID/status, UTC time, branch/HEAD, dirty paths, changed files, exact tests/results (including skips), evidence links, blockers, Owner decisions and **one next executable step**. Keep stable architectural guidance at the top unchanged. If interrupted, reconstruct state from Git and CI; do not invent a checkpoint.
