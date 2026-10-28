# DB-1 — a safe route for the direct-booking switch

Design only, 28 October 2026. No code and no Terraform edited. Owner decision of 27 October: launch
WITH direct booking. The switch stays off in `infra/aws/production.tfvars` and cannot be turned on
before counsel's Direct booking addendum is released.

## Summary (read this, then decide)

- Today nothing can set `HEALDESK_DIRECT_BOOKING_ENABLED`: `never_on_app_tasks` (`locals.tf`) and the
  `app_environment` validation (`variables.tf`) refuse it everywhere. Proposal: two Terraform
  variables, `direct_booking_enabled` and `direct_booking_addendum_released`, both default false; the
  first is refused unless the second is true; `production.tfvars` keeps both false.
- The env var reaches the web task and the worker (shared or separate) and, if chosen, the voice task.
  Never the one-off tasks (destroy-due, patient-export, ops scripts, migrate, db-*).
- The app fails closed by itself: one new check needs the env var AND the released addendum in code
  AND a matching addendum version in a second env var. An env var alone never turns booking on.
- Switching on is two reviewed commits plus a deploy, never a console click. Rollback is one `false`.
- **Owner decisions:** (1) Does the phone (voice task) book directly at launch, or only web chat, with
  voice staying request-only until a quiet-hour roll? (2) Accept two release flags (catalog
  `approvedByCounsel`, Terraform `direct_booking_addendum_released`) kept equal by a test? (3) Accept
  the version-binding variable `HEALDESK_DIRECT_BOOKING_ADDENDUM`, so a revised addendum switches
  booking off until re-released?
- Effort: about 1.5 days (Terraform and tests 0.5, app 0.5, admin and docs 0.5), plus a money-lane review.

## 1. What exists today (verified in the repo)

| Fact | Where |
| --- | --- |
| Env read as the literal `"true"`, on every call, never cached | `apps/app/src/lib/env.ts:290` `directBookingEnabled` |
| Assistant tools offered only with env AND `currentDirectBookingAddendum().approvedByCounsel === true` | `apps/app/src/lib/assistant/booking-tools.ts:169` `directBookingToolsAllowed` |
| Booking mode (live or manual) reads the env only, as `killSwitchOn`, reason `kill_switch_off` | `apps/app/src/lib/booking/mode.ts:211`, `:262`; `apps/app/src/lib/ops/calendar-ops.ts:305` |
| The buy funnel and console read the env through the ops envelope | `apps/app/src/lib/ops/api.ts:1499` (`bookingSwitch`); `apps/web/src/lib/admin/ops-client.ts:2427` `directBookingOpen`, `:3503` |
| Addendum `direct-booking-addendum/1.0.0`, `approvedByCounsel: false` | `packages/catalog/src/direct-booking-addendum.ts:109-121` |
| The voice process uses the same tool layer, so it reads the env too | `apps/app/src/lib/voice/retell.ts` (imports booking tools) |
| `never_on_app_tasks` lists the name | `infra/aws/locals.tf:276-284` |
| Preconditions using it: web `ecs.tf:560`, shared worker `:567`, worker `:603`, voice `:643`, destroy-due `:738` | `infra/aws/ecs.tf` |
| `app_environment` refuses it (`variables.tf:541-546`) and anything in the list (`:569`) | `infra/aws/variables.tf` |
| Deploy-time shape check carries the same list as `NEVER_ON_APP_TASKS` | `.github/workflows/deploy-app.yml:723` |
| Tests pin the refusal | `infra/aws/tests/stack.tftest.hcl:464`, `:1459` (voice), `:1960` `refuses_the_booking_switch` |
| Text saying "never set" | `infra/aws/README.md:269-273`, `docs/handover.md:71`, `launch.ts` item `direct-booking`, `system-map.ts:926` |

Gap found: `mode.ts`, `calendar-ops.ts` and `bookingSwitch` ignore the addendum flag, so the portal and
buy page could say "live" while the tools stay off. One shared check (section 3) closes all three.

## 2. Terraform

### 2.1 Variables (`infra/aws/variables.tf`)

```hcl
variable "direct_booking_addendum_released" {
  description = "Mirrors packages/catalog/src/direct-booking-addendum.ts approvedByCounsel; true only in the commit that releases the addendum (a test keeps the two equal). Does nothing by itself."
  type        = bool
  default     = false
}
variable "direct_booking_enabled" {
  description = "The owner's switch for AYA booking into the clinic's calendar: sets HEALDESK_DIRECT_BOOKING_ENABLED=true and HEALDESK_DIRECT_BOOKING_ADDENDUM on the web and worker tasks. Refused unless the addendum is released."
  type        = bool
  default     = false
  validation {
    condition     = !var.direct_booking_enabled || var.direct_booking_addendum_released
    error_message = "direct_booking_enabled needs direct_booking_addendum_released: counsel's Direct booking addendum must be released first."
  }
}
variable "direct_booking_on_voice" {            # only if the owner answers yes to decision 1
  type    = bool
  default = false
  validation {
    condition     = !var.direct_booking_on_voice || (var.direct_booking_enabled && var.enable_voice)
    error_message = "direct_booking_on_voice needs direct_booking_enabled and enable_voice."
  }
}
variable "direct_booking_addendum_version" {   # equals the catalog version (test 4.2)
  type    = string
  default = "direct-booking-addendum/1.0.0"
  validation {
    condition     = can(regex("^direct-booking-addendum/[0-9]+\\.[0-9]+\\.[0-9]+$", var.direct_booking_addendum_version))
    error_message = "direct_booking_addendum_version must look like direct-booking-addendum/1.0.0."
  }
}
```

`versions.tf:16` requires Terraform `~> 1.16`, so a validation may name another variable.
`production.tfvars` gets explicit `false` lines for the first two, so the flipping diff is visible.

### 2.2 `never_on_app_tasks`

The list keeps the name, and gains `HEALDESK_DIRECT_BOOKING_ADDENDUM`. Every task and `app_environment`
keep refusing both. The switch is carved out for three container sets only, by exact name, in `locals.tf`:

```hcl
direct_booking_names = ["HEALDESK_DIRECT_BOOKING_ENABLED", "HEALDESK_DIRECT_BOOKING_ADDENDUM"]
direct_booking_environment = var.direct_booking_enabled ? {
  HEALDESK_DIRECT_BOOKING_ENABLED  = "true"
  HEALDESK_DIRECT_BOOKING_ADDENDUM = var.direct_booking_addendum_version
} : {}
```

- Do not merge it into `app_environment_common` (`locals.tf:86`): the ops scripts use it (`ecs.tf:393`).
  Do not merge it into `web_environment` or `worker_environment` either: destroy-due reuses
  `worker_environment` (`ecs.tf:738`) and must keep refusing it.
- Merge only at the container definitions: web (`ecs.tf:107`), worker (`:183`) and, when
  `direct_booking_on_voice`, voice (`:229`): `merge(local.X_environment, local.direct_booking_environment)`.
- Preconditions at `ecs.tf:560`, `:567`, `:603`, `:643` use
  `setsubtract(local.never_on_app_tasks, local.direct_booking_names)`, and each gains one new
  precondition: the two names are present exactly when the switch (for voice, `direct_booking_on_voice`)
  says so, with the exact values. `:738` is unchanged.
- Parameter Store is not involved: both values are plain public settings; `ssm.tf` is untouched.

### 2.3 Deploy workflow shape check

`.github/workflows/deploy-app.yml:723` keeps its list. The loop at `:773` refuses any listed name on every
family except `migrate`, `db-bootstrap`, `db-query`, `db-apply`, so web and worker would fail it once the
switch is on. For labels `web`, `worker` and `voice` only, remove the two names from the refused set and
add a check that, if present, they equal `true` and a `direct-booking-addendum/x.y.z` string. All other
families still refuse both. `actionlint` stays green; `rollback` mode is unaffected.

## 3. App side: fail closed, no env var alone

New `apps/app/src/lib/booking/direct-switch.ts` (plain Node, no `@vercel/*`):

```ts
export function directBookingOpen(): boolean {
  const addendum = currentDirectBookingAddendum();
  return (
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED === "true" &&
    addendum.approvedByCounsel === true &&
    process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM === addendum.version
  );
}
```

- Use it in `mode.ts:262`, `calendar-ops.ts:305` and `api.ts:1499`, and make `directBookingToolsAllowed()`
  (`booking-tools.ts:169`) call it. Keep `env.directBookingEnabled()` as the raw value for the `/admin` ticks.
- Anything but all three true is false: empty, `"1"`, `"TRUE"`, a missing or mismatched version, or
  `approvedByCounsel: false`. Read on every call, never cached, as today.
- A revised addendum (a new entry at `DIRECT_BOOKING_ADDENDUMS[0]`) changes `version`, so the env value
  stops matching and booking falls back to staff requests until Terraform sets the new version and a
  deploy rolls. A safe default for a legal document.
- The degradation path is the existing manual mode: every channel takes a request for staff, so a false
  never strands a patient. `lib/booking/elections.ts` and the agreements are not touched.

## 4. Tests

### 4.1 `infra/aws/tests/stack.tftest.hcl` (every refusal pinned; plans on mocked providers)

Keep `refuses_the_booking_switch` (`:1960`): `app_environment` still refuses the name. Add:

| Run | Variables | Expectation |
| --- | --- | --- |
| `refuses_booking_switch_unreleased` | `direct_booking_enabled = true` | `expect_failures = [var.direct_booking_enabled]` |
| `refuses_booking_on_voice_without_switch` | `direct_booking_on_voice = true` | `expect_failures = [var.direct_booking_on_voice]` |
| `refuses_booking_on_voice_without_voice` | released, enabled, on_voice, `enable_voice = false` | `expect_failures = [var.direct_booking_on_voice]` |
| `refuses_addendum_version_shape` | `direct_booking_addendum_version = "1.0.0"` | `expect_failures = [var.direct_booking_addendum_version]` |
| `refuses_addendum_name_in_app_environment` | `app_environment = { HEALDESK_DIRECT_BOOKING_ADDENDUM = "x" }` | `expect_failures = [var.app_environment]` |
| `production_defaults` (extend) | none | no definition (web, worker, voice, destroy-due, every one-off) contains either name |
| `booking_on_web_and_worker` | released, enabled | web and worker carry both names with the right values; destroy-due, patient-export, every `ops_script[*]`, migrate, db-bootstrap and voice carry neither |
| `booking_on_voice` | plus `enable_voice`, `direct_booking_on_voice` | voice carries both |
| `booking_on_separate_worker` | plus `worker_placement = "separate"` | the worker service task and web carry both |

The all-tasks assertions at `:464` and `:1459` stay for the one-off tasks; for web, worker and voice split
the list so the intent stays readable. Assert with `strcontains(...container_definitions, "\"NAME\"")`.

### 4.2 Release-flag equality test

`apps/app/tests/direct-booking-switch-infra.test.ts` (the style of `one-off-tasks.test.ts`, which already
reads `infra/aws`): reads `variables.tf` and `production.tfvars` and asserts (a)
`direct_booking_addendum_released` equals `currentDirectBookingAddendum().approvedByCounsel`; (b) the
version variable's default equals the catalog version; (c) `production.tfvars` sets
`direct_booking_enabled = true` only if (a) is true. Releasing the addendum then needs both edits in one commit.

### 4.3 App unit tests

- New `apps/app/tests/direct-booking-switch.test.ts`: a table over (env value, version env, approved);
  only the all-true row is true.
- Extend `booking-mode.test.ts`, `booking-tools.test.ts`, `ops-booking-switch.test.ts` and
  `apps/web/src/lib/admin/ops-client.test.ts`: env on with the addendum unreleased gives
  `kill_switch_off`, no tools and `bookingSwitch.directBooking` false.

### 4.4 Real-database suites (money lane)

`bash scripts/verify-local.sh` on the exact tree, with skip counts reported and explained for
`booking-tools`, `booking-engine`, `slot-holds`, `direct-booking`, `closure-blocks-bookings`,
`booking-transitions`, `booking-tools-calendar-failure`, `booking-deposit-line`. Then one synthetic web
chat booking locally with `HEALDESK_DIRECT_BOOKING_ENABLED=true` and
`HEALDESK_DIRECT_BOOKING_ADDENDUM=direct-booking-addendum/1.0.0`, the addendum flag flipped in the working
tree only and never committed. A retried request must return the original booking, and the slot hold
must last 60 seconds before anything confirming is said.

## 5. Owner-facing runbook and `/admin` screen

- The `direct-booking` item in Compliance › Launch (`launch.ts`) and the booking card show three live
  ticks: switch in the task environment, addendum released in the running build, version matches. There
  is no button; the sentence says "set in Terraform, `direct_booking_enabled`". The `bookingSwitch`
  reply (`api.ts:1499`) becomes `{ directBooking, env, released, versionMatches }`, a projection of three
  booleans with no clinic data; the `ops-client.ts` parser and its test change with it.
- `system-map.ts`: rewrite the `HEALDESK_DIRECT_BOOKING_ENABLED` words (`:926`); add
  `HEALDESK_DIRECT_BOOKING_ADDENDUM` to `KEYS` (a plain setting, changed by the Terraform variable) and to
  `apps/app/src/lib/ops/key-presence.ts` if the map reads it, since `system-map.test.ts` fails otherwise;
  update the booking bridge words and `buildNote` (`:1517`). `launch.ts`: `direct-booking` stays
  `building` until the switch is on; only its `left` text changes to the new route.
- Runbook, added to `infra/aws/README.md` (beside `:269`) and `docs/handover.md:71`, in the owner's order:
  1. Counsel approves the addendum. One commit flips `approvedByCounsel` and
     `direct_booking_addendum_released`; CI (4.2) proves they agree.
  2. Land it on your yes; `deploy-app.yml` deploys the code. The switch is still off.
  3. Confirm a clinic with a live calendar and Stripe Connect are in place (synthetic data until the BAA chain is complete).
  4. A second commit sets `direct_booking_enabled = true` (and `direct_booking_on_voice` if chosen).
     `infra.yml` plans a task-definition change only; you approve the apply.
  5. `deploy-app.yml` rolls web and worker. A voice roll only with your word that no call is running or planned.
  6. Read the three ticks, then place one synthetic booking in web chat on the demo clinic.

## 6. Rollback

Set `direct_booking_enabled = false`, apply, deploy. Faster and without Terraform: `deploy-app.yml`
`rollback` to the previous task-definition revision, which carries no switch. A booking made while it was
on stays a booking; nothing is deleted and queued requests are untouched. Reverting `approvedByCounsel`
also closes the gate at the next deploy by the code check alone.

## 7. Interactions

- **`host.yml` standby**: standby keeps parameters and images and removes services; the switch lives in
  Terraform-owned task definitions, so `active` restores exactly what `production.tfvars` says.
  `host.yml` passes variables with `-var` (its header); the new variables default to false, so a missed
  pass-through fails closed. The builder confirms by reading the workflow.
- **Voice task**: reads the switch too. If decision 1 is no, calls take requests for staff while web chat
  books, and the register item says so. Adding voice rolls `healdesk-production-voice` (target group
  deregistration delay is an hour): deploy only with the owner's word. `voice_real_calls` stays
  independent of it.
- **Meta**: unchanged; the front door books nothing.

## 8. Risks

1. The two release flags drift: mitigated by 4.2, and a miss fails closed.
2. A name smuggled in through `app_environment` or a hand-registered revision: Terraform refuses the
   first; the shape check refuses a one-off family or an unexpected value; a hand-registered web revision
   still needs the version env and the code flag.
3. The carve-out is a hole in the "never" contract if written loosely: it is by exact name and exact
   container set, and destroy-due and the ops scripts keep refusing.
4. A revised addendum quietly turns booking off until Terraform and a deploy follow: intended; the
   runbook and the ticks say so.
5. Money: the second review covers idempotency and hold timing, with 4.4 actually run, not skipped.

## 9. Files to change (for the builder)

Terraform: `infra/aws/variables.tf`, `locals.tf`, `ecs.tf`, `production.tfvars`, `tests/stack.tftest.hcl`,
`README.md`. Workflow: `.github/workflows/deploy-app.yml`. App: new `apps/app/src/lib/booking/direct-switch.ts`;
edits to `booking/mode.ts`, `assistant/booking-tools.ts`, `ops/calendar-ops.ts`, `ops/api.ts`,
`ops/key-presence.ts`; tests in section 4. Web: `apps/web/src/lib/admin/ops-client.ts` (+ test),
`lib/admin/system-map.ts`, `lib/admin/seo/launch.ts`. Docs: `docs/handover.md`, `AGENTS.md`.
