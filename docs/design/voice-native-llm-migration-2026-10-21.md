# Voice on Retell's native LLM: assessment and staged plan (2026-10-21)

> **UPDATE (owner, 21 October 2026, later the same day): the product voice agent
> STAYS on the custom-LLM WebSocket endpoint. Native is not being pursued now.**
> This document is kept as the assessment and the plan if native is revisited
> (for example as a second track behind the per-clinic engine switch). The
> decision above it, and every "the owner amends the spec and CLAUDE.md" line,
> is superseded: the spec and `CLAUDE.md` voice sections are NOT being changed
> for native. The engine-independent work stays: the Retell transcript-then-delete
> flow, automated voice provisioning (engine field defaults to `custom`), the
> ended-early flag and redial recognition.


**Decision (owner, 21 October 2026):** the product voice agent moves from the
custom-LLM WebSocket (`apps/app/src/voice/server.ts`) to Retell's native LLM
(`response_engine.type = "retell-llm"`), for demo and product agents alike. This
overrides the assessment's own recommendation (keep custom for the product). The
owner amends `docs/v1-product-spec.md` (through its source doc) and `CLAUDE.md`.
Until a stage below says otherwise, **production still runs the custom
endpoint**; nothing here is deployed, switched on or verified. Retell facts below
come from Retell's documentation through Context7 on 21 October 2026; anything
not confirmed there is marked UNCONFIRMED.

## What "native" means for what we build

The agent is created and configured inside Retell, but never by hand: a clinic's
agent is generated from its facts through Retell's API (create Retell LLM, create
agent). What we still build, all in `apps/app` (PHI side):

1. **Tool endpoints.** Retell's LLM calls our HTTPS endpoints (custom functions,
   signed with `X-Retell-Signature`): availability, hold, book, flag a deposit,
   escalate/alert, knowledge lookup. Holds, idempotency (`retell:<call>:1`) and the
   deposit flag stay server-side. Per-call tool state moves from memory to a
   database row keyed by call id.
2. **Inbound-call webhook.** Runs before the call connects: the answer gate (demo
   clinic only until `voice_real_calls`, vendor coverage, paused clinic -> direct
   line), the clinic's facts as dynamic variables, redial recognition.
3. **Agent writer.** Per clinic: the Retell LLM (`general_prompt` generated from
   clinic facts, never-say list, price list, tools), the agent (`begin_message`
   with the AI + transcription line, `guardrail_config`, `handbook_config`,
   storage and retention, webhook).
4. **Post-call ingest.** The `call_ended` / `call_analyzed` webhook becomes the
   primary path: transcript -> sealed outbox -> delete at Retell; abrupt endings
   flagged to the clinic from `disconnection_reason`; the crash backstop reshaped.
5. **Monitoring in place of pre-model checks.** Near-real-time audit of
   `transcript_updated` for urgent symptoms (alert the clinic at once), and a
   post-call audit of every transcript with `guard.ts`'s rules.
6. **Compliance plumbing.** `vendor-coverage.ts`, `/admin/compliance`, subprocessor
   notice and agreement text name Retell's LLM providers.
7. **Custom endpoint kept, dormant (owner, 21 October 2026).** Nothing of the
   custom-LLM build is deleted: the WebSocket server, `RetellCallSession`, its
   tests, the voice ECS service, target group, `/llm-websocket/*` rule and the
   `enable_voice` variable stay in the repo and in Terraform, off by default, so
   a clinic can go back to it with the per-clinic engine switch (`custom`) and
   `enable_voice = true`. Only the dead weight in the hot path is switched off.
8. **AWS.** Native adds public, signed routes for Retell's tool calls, inbound
   webhook and post-call webhooks on the public host, and needs the web tier,
   not a voice service, to carry call-time traffic: see "AWS" below.

## Rules that change (from the assessment)

| Rule | Under native |
| --- | --- |
| AI line and "transcribed" | Kept: `begin_message`, a fixed line our code writes. The re-say when the caller talks over it is lost |
| Urgent screen BEFORE the model | **Cannot be enforced.** No pre-model hook; Retell's only input guardrail is `platform_integrity_jailbreaking`. Replaced by prompt instruction + near-real-time transcript audit + alert. A fixed 911 line is not guaranteed |
| Output guard (never-say, off-list price, clinical, "you're booked") | **Not enforceable in code.** Retell's output topics are its own classifier (`regulated_professional_advice` etc.); custom topics not documented. Prompt + post-call audit only |
| Bookings only by the fixed tool layer | Server-side holds/idempotency kept. Lost: the tool's fixed line instead of the model's words (Retell hands tool output to the LLM); the model can say "booked" without calling the tool |
| Card numbers kept from the model | **Lost before the model**; Retell `pii_config` runs post-call |
| Voice sends no link, flags deposit | Kept (no SMS tool configured; endpoint flags the deposit) |
| Failure goes to the direct line | Weaker: `transfer_call` is model-triggered; `fallback_number` covers only concurrency overflow. Answer gate can move to the inbound webhook (reject / override agent). Webhook-timeout behaviour UNCONFIRMED |
| No outbound contact | Kept (no `outbound_agents`; ingest refuses outbound) |
| Model choice | Retell's list (Claude 4.5/4.6/5 Sonnet, 4.5 Haiku, GPT, Gemini); `claude-sonnet-5-5` is not on it |
| Vendor chain | Call content goes to Retell, then to a model provider under Retell's arrangements. Anthropic's BAA leaves the voice path (stays for chat) |

Biggest risk: a caller describing an urgent symptom gets the model's improvised
answer, not the fixed 911 line, through a model provider the BAA chain has not
confirmed. The mitigations in stage 5 reduce but do not remove it.

## Stages (each ends in code + tests; cutover gates are the owner's)

| # | Stage | Who | Gate |
| --- | --- | --- | --- |
| S0 | Retell's written answers on LLM subprocessors, BAA scope, retention (`retell-written-terms-request-2026-10-21.md`); counsel review; attestation on `/admin/compliance` | Owner | Required before ANY real call on native; not before building |
| S1 | Tool endpoints + persisted per-call tool state (engine-independent; custom keeps working) | Claude | none |
| S2 | Inbound-call webhook gate + dynamic variables + redial recognition | Claude | S1 |
| S3 | Agent writer for `retell-llm` (LLM + agent), per-clinic engine switch, default `custom` | Claude | S1, S2 |
| S4 | Post-call ingest from webhooks, ended-early flag, backstop reshaped, transcript storage setting | Claude | S3; Retell storage behaviour confirmed (S0) |
| S5 | Monitoring: `transcript_updated` urgent audit + alert (investigate whether Retell's API can cut in, UNCONFIRMED), post-call guard audit | Claude | S4 |
| S6 | Tests: safety cases re-aimed at tool endpoints; live `qa:voice` probes against real Retell test calls | Claude + Owner (key) | S3 |
| S7 | Cutover per clinic: demo clinic first, test calls, then `voice_real_calls` | Owner | S0, S5, S6 |
| S8 | Disable (not delete) the custom endpoint: engine switch default `native`, `enable_voice` stays false, tests kept and kept passing as the way back | Claude | S7 stable |

Estimate: roughly 9 to 11 builder sessions plus counsel and vendor time.

## UNCONFIRMED (check with Retell before relying)

Which model providers process voice calls and under whose BAA, their retention;
whether webhooks carry a transcript under `basic_attributes_only`; whether the
output-guardrail placeholder text can be set; what Retell does when the inbound
webhook times out; inbound-webhook latency budget; whether `transcript_updated`
latency allows an in-call alert; whether a live call can be redirected or
transferred through the API.

## AWS

To be filled by the infra review of `infra/aws` (listener rules, task sizing,
standby behaviour, alarms, SSM keys, workflows). Constraints already decided:
no `terraform apply`, no workflow run and no live change without the owner; the
voice service resources stay defined and dormant; every change gets a
`terraform test` case.
