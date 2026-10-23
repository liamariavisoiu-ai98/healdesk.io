> Design input, written 23 Oct 2026 by a read-only design agent from main at 2e258ae9. Not a decision: the plan in ../README.md decides what is built and in what order. Claims are from the code unless marked NOT VERIFIED; spot-checked by the session that commissioned it.

# E4. The clinic dashboard: closures (item 5, clinic half) and the roster (item 6)

Read at main 2e258ae9. Paths are under `apps/app/src/` unless said.

## 1. Current state (read from code)

**Both editors already exist, in the screens the spec names.**

| | Where | Writer | Checks today |
| --- | --- | --- | --- |
| Holidays and closures | Knowledge → Hours card (`app/c/[slug]/knowledge/page.tsx` L213, `KnowledgeForms.tsx` `HoursForm` L505, shared `HoursEditor` in `app/c/[slug]/editors.tsx`: "Days you're closed", "Add a closed day") | `lib/portal/knowledge.ts` `saveKnowledge("hours")` → `lib/setup/practice.ts` `saveHours` (same writer as wizard step 1.2, `lib/setup/save.ts` L199) | ISO date from the picker; today or later in the clinic's zone; ≤60; label ≤80, clinical screen; duplicates collapsed. Future closures are replaced (delete + insert), past ones kept. Audit row `clinic_hours {closures: n}`. Queues the practice questions (reason `knowledge`, section `hours`, 2-min debounce). No step-up. Toast: "Hours saved. AYA tells people when you're open, and phone follows them." |
| Providers and services | Settings → Calendar card, "Booking detail" (`settings/CalendarControls.tsx` L424+, `calendar-actions.ts` `loadProvidersAction`, `saveProvidersAction`, `sharedCalendarAction`) | `lib/connections/google-calendar.ts` `saveProviders` L1551, `setProviderServices` L1711 | Name 1–80; calendar must be owned by the connected account (asked of Google), one active provider per calendar, ≤MAX_PROVIDERS; a service key must be on the price list; holds on a calendar leaving use are released (`provider_removed`). Audited with counts. Offered only while the connection is healthy (`providersPossible`). No step-up (by design: "who a booking is with, not where calls or money go"). |

**What honours a closure:** booking availability (`lib/booking/availability.ts` L445–448; `checkSpan` L557 re-runs it at hold time, so a stale offer on a closed day is refused as busy); the voice answer gate, only in After-hours-only mode (`lib/billing/answering.ts` L574–586); the daily summary; requests-still-open. Staff confirming a request by hand deliberately skip hours (`DeskSpanCheck`). Retell holds no hours: everything AYA says comes over our socket per call (`lib/voice/provision.ts` L84–92), so there is nothing to "sync to Retell" for availability; forwarding is the carrier's.

**Gap (spec Knowledge §3: closures "drive the agent's answers"):** `lib/assistant/facts.ts` carries weekly `openingHours` only (L105 `hoursLines`); `turn.ts openNow` L186 and `meta/front-door.ts urgentLine` L276 use `isOpenAt` alone. On a closed day AYA on every channel may say the clinic is open, and the urgent reply offers the clinic's number "while open".

**Ops side: not found.** No event, no Slack, no indicator. `notifyOps` (`lib/ops/notify.ts`) emails ops with ids only, deduped in `ops_alerts`; Slack exists only on apps/web (`postInternalAlert`, `SLACK_WEBHOOK_URL`, Vercel). `clinic_settings_history` records seven sensitive fields, not hours or the roster. The ops list (`apps/web/src/app/admin/ops/OpsConsole.tsx`) shows `listClinics`, `listClinicCards`, `listClinicHealth`; nothing says "this clinic changed its availability". Ops can also write these three tables through R2 change files (`WRITABLE_TABLES`), silently.

**Locations:** `clinic_closures.location_id` exists but the key is `(clinic_id, closed_on)`; Knowledge's Hours is the main location's; a later location has hours (`clinic_locations.opening_hours`, Settings → Locations) and no closures of its own (schema L5048, "plan step 12").

## 2. Decisions

**Closures stay in Knowledge → Hours.** Spec "Portal map" §3 says exactly this ("Hours: including holiday closures"). "Direct calendar configuration" (spec, "What the portal does not have") means configuring Google or an EMR; a closure writes nothing to Google and tells AYA when not to offer time. No seventh screen, no Settings card, no spec change.

**The roster stays in Settings → Calendar, edited by the clinic.** Spec "Provider-level booking": the mapping is "collected in the wizard and editable in the portal"; principle 7, "Nothing hidden behind support". The owner's "monitored through the admin page" is monitoring, not ownership. Ops' R2 change file remains the exception for a clinic that asks by phone, and must emit the same event (§3).

**Step-up:** none for either (CLAUDE.md portal rules: only where calls and money go). The actor label (device, or "the clinic's sign-in") goes on the event.

## 3. What to build

**A. The event (new table, tenant plane, no PHI):** `clinic_change_events` — `id`, `clinic_id`, `location_id`, `kind` (`hours` | `closures` | `providers` | `provider_services`), `source` (`portal` | `wizard` | `ops_console` | `change_file` | `direct`), `actor_label` (device label, sign-in label, or `ops`), `summary` jsonb of counts and dates only (`{weeklyChanged, closuresAdded: ["2026-11-27"], closuresRemoved: [], providersActive, servicesMapped, holdsReleased}`), `changed_at`, and the columns the audit agent owns (`audit_status` queued/running/passed/attention, `audit_run_id`, `ops_acknowledged_at`). Dates and counts are business data; never a patient id, a name or a calendar id. Listed in `READONLY_TABLES`; not writable by R2.

Written inside the save's own transaction by a helper `lib/clinic/change-events.ts recordClinicChange(tx, …)` from `saveHours`, `saveProviders`, `setProviderServices`, so a rolled-back save emits nothing. A statement-level trigger on the three tables is the safety net: it inserts a count-only row with `source = 'direct'` unless the transaction set `app.change_emitted`, so an R2 change file or a psql edit never goes unseen.

**B. Ops alert:** new `OPS_EVENTS` name `clinic_availability_changed`, raised after commit with `{clinicId, kind, source, added, removed, providers}`; dedupe one hour per clinic and kind, so six edits in an evening are one mail. Slack is the alerting agent's transport; the payload it gets from this row is: *"Availability changed · {clinic name} · closed days +2 (27 Nov, 28 Nov) −0 · by the clinic ({device}) · check: queued · /admin/ops/{id}/care#availability"*. Transport recommendation: `SLACK_WEBHOOK_URL` as a new `__unset__` SSM parameter on the host (Terraform, `/admin/map` KEYS, `key-presence.ts`), not polling from apps/web.

**C. Ops operations (R3):** `listClinicChanges({clinicId?, since?})` and `acknowledgeClinicChange(id)` in `lib/ops/api.ts` and `ops-client.ts`. The clinic list shows one line per clinic with an unacknowledged row: "Availability changed 2 h ago · checking" / "· checked" / "· needs a look", and the care page gains an "Availability" section listing the rows with the audit agent's status and its "Check again" button.

**D. Clinic copy (short changes to what exists):**
- Hours card, under the title: *"When you're open, and the days you're closed. AYA tells people, offers no appointments on a closed day, and phone follows these hours."*
- Closed-day row: date, then *"What for (optional)"*, placeholder *Thanksgiving*. Button *"Add a closed day"*. Refusals unchanged ("A closed day has to be today or later." etc.).
- Toast: *"Hours saved. AYA offers nothing on a closed day and tells people when you're open."* + existing `appliesWhen`. When AYA bookings already sit on a newly closed date: *"2 bookings already sit on those days. They stay in your calendar; they're listed in Bookings."* (count of `appointments.scheduled_for` on those local dates, in the tenant; link `bookings`).
- Status line on the Hours card and under "Booking detail": *"In use since 2:14 pm."* when the latest change row's practice run passed or none is pending; *"We're checking your change. AYA keeps answering meanwhile."* while queued; the existing Home item *"We're double-checking your change to Hours."* when it failed and ops is reviewing.
- Booking detail, one line under the heading: *"Takes effect on the next booking. Today's bookings stay as they are."*

**E. Downstream, made true:** closures reach `assistantFacts` (next 60 closed days as "Closed: 27 Nov (Thanksgiving)") and `openNow`/`urgentLine` honour them; live holds on a newly closed date are released (`releaseLiveHolds` gains a `dates` filter, reason `closure_added`); the practice questions' hours case asks about a closed day.

**What the clinic can never see:** the ops audit's probes and findings, Slack, ops alerts, health flags, acknowledgements, other clinics, the change-file runs. The audit writes no clinic-facing words; if it finds something the clinic must do (calendar broken), that already surfaces as an existing Home attention item.

## 4. Reuse vs new, by rail

| Piece | Reuse | Rail |
| --- | --- | --- |
| Editors, validation, practice re-run, audit rows | all existing | — |
| `notifyOps` dedupe, `ops_alerts` | existing | — |
| `clinic_change_events`, helper, trigger | new | written by the app; read by R1 (listed) |
| `listClinicChanges`, `acknowledgeClinicChange` | new | R3 |
| R2 change files on the three tables | existing; now emit via the trigger | R2 |

## 5. Guardrails and conflicts

- PHI: the row holds dates, counts, a device label. Clinic name appears only in Slack composed on apps/web or by the alerting agent's sender, as `postInternalAlert` already does; `notifyOps` fields stay ids.
- Must-never-grow: nothing added to the six screens; no per-channel behaviour; no calendar configuration.
- Outbound: nothing here contacts a patient.
- **OWNER DECISION 1:** keep ops' R2 writes to these tables now that the clinic has both editors? Recommend yes, as the exception for a clinic that asks, since the trigger makes them visible.
- **OWNER DECISION 2:** a Slack key on the AWS host (new parameter, map entry) versus posting from apps/web. Recommend the host key.
- No spec change needed. Spec Email §: "The internal health flags stay internal" is kept.

## 6. Build order

| Step | Size | Proves | Files |
| --- | --- | --- | --- |
| 1. Table, migration, helper, emit from the three writers, `READONLY_TABLES` | S | `knowledge-screen.test.ts`: a saved closure adds one row `{kind: closures, source: portal, actor: device, added: [D]}`; a refused save adds none. `calendar-providers.test.ts`: roster save adds one row with counts | `db/schema.ts`, `drizzle/00xx`, `scripts/readonly-tables.ts`, `lib/clinic/change-events.ts`, `lib/setup/practice.ts`, `lib/connections/google-calendar.ts` |
| 2. `clinic_availability_changed` in `notifyOps`, after commit, 1-h dedupe | S | notify test: one `ops_alerts` row for six saves in an hour, ids only | `lib/ops/notify.ts`, the helper |
| 3. Ops ops + list line + care section | S | ops-api test: rows per clinic, acknowledge flips the line | `lib/ops/api.ts`, new `lib/ops/change-ops.ts`, `apps/web/src/lib/admin/ops-client.ts`, `OpsConsole.tsx`, `[clinicId]/care/CarePanel.tsx` |
| 4. **The proof the owner asked for:** a clinic with a fake calendar all free gets slots on D; the portal saves D closed; `availableSlotsFor` returns none on D and slots on D+1; `checkSpan(D 10:00)` says busy; a hold placed on D before the save is released | M | new `closure-blocks-bookings.test.ts` (DB-backed) | `lib/booking/holds.ts` (`dates` filter), `lib/setup/practice.ts`, test |
| 5. Closures into `assistantFacts`, `openNow`, `urgentLine`, the practice hours case | M | facts test: on D `openNow` is false and the urgent reply omits the clinic's number | `lib/assistant/facts.ts`, `turn.ts`, `meta/front-door.ts`, `engine/practice/cases.ts` |
| 6. Copy: card lines, bookings-on-closed-days toast, status line | S | copy test and toast assertion | `knowledge/page.tsx`, `KnowledgeForms.tsx`, `CalendarControls.tsx`, `lib/portal/knowledge.ts` |
| 7. Safety-net trigger (`source = 'direct'`) | S | `db-apply.test.ts`: a change file on `clinic_closures` leaves one row | migration, `tests/db-apply.test.ts` |
| 8. Slack key on the host | owner | key present in `/admin/map` | `infra/aws/ssm.tf`, `system-map.ts`, `key-presence.ts` |

## 7. Open questions

1. Keep R2 change files on these three tables (decision 1)?
2. Slack key on the host, or posting from apps/web (decision 2)?
3. Closures per extra location (plan step 12): build now, or when a second-location clinic exists? Recommend wait; the audit must not read the main location's closures as another's.
4. Should "bookings already sit on those days" also email the clinic a pointer? Recommend no; the toast and Bookings suffice.
5. Confirm: the ops audit tells the clinic nothing beyond existing Home attention items.
