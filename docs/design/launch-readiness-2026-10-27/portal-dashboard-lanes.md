# Portal dashboard, ops bridge and support actions: lane contract (28 Oct 2026)

Owner decisions (28 Oct 2026, in chat) that every lane obeys:
- Simplicity rule (CLAUDE.md): clinic-facing copy is the simplest words, says what a switch does for the clinic, and when unavailable gives one short plain reason. Never mention senders, BAAs, registration, carriers, webhooks. Remove what is not needed.
- Payment-link text: optional, default off, clinic switch usable whenever phone is bought and Stripe is connected. A text can only go out where the tool layer says sending exists (not built; no sender chosen). No BAA for the sender (scoping, like Meta/Stripe). Copy says "designed to". Never build sending code in these lanes.
- Full payment ("What the assistant asks the patient to pay": Deposit only / Full payment) needs gateway + calendar + Auto-confirm on. Dropping any returns it to Deposit only in the same transaction, with an audit row, an in-portal notice AND an email to the clinic.
- Ops (healdesk) gets an email for every submitted change to a clinic's profile, from any source (clinic, operator, support action).
- Operators see a clinic's switches in /admin and can set them from our side through the signed ops envelope. Claude, answering a support@ request, may change a switch from a closed list itself and then drafts the confirmation reply, which a person still approves (existing rule). Never money, direct line, transfer number, urgent-help number, greetings/free text, languages, voice channel, coverage mode.

Shared pieces (already committed on lane/portal-dashboard):
- `apps/app/src/lib/portal/switch-rules.ts`: `switchRules(facts)` and `resetsAfter(facts, values)`. The ONLY place availability rules live. Do not duplicate them. Extend it only in lane A.

Contract names (all lanes code against these):
- Setting keys added to `SETTING_KEYS` in `apps/app/src/lib/portal/settings.ts`: `text_payment_link` (boolean) and `payment_ask` (`"deposit_only" | "full_payment"`). Channels: text_payment_link -> ["voice"]; payment_ask -> ["web","meta","voice"].
- DB: `clinic_settings.text_payment_link boolean not null default false`, `clinic_settings.payment_ask text not null default 'deposit_only'` (check constraint on the two values), new drizzle migration, RLS unchanged in shape.
- `SettingsView.payments` gains: `textPaymentLink: boolean`, `paymentAsk: "deposit_only" | "full_payment"`, `rules: ReturnType<typeof switchRules>`, `autoConfirm: boolean`, `calendarConnected: boolean` (type already declared in settings-view.ts with placeholder values; lane A fills real ones).
- Ops operations (apps/app `/api/ops`, signed): `getClinicSwitches {clinicId}` -> `{ switches: { key, label, kind: "switch"|"choice", value: boolean|string, enabled: boolean, reason: string|null, operatorMayChange: boolean }[] }`; `setClinicSwitch {clinicId, key, value}` -> `{ ok: true, toast: string, resets: {switch,notice}[] } | problem`. Both lanes C1 (app) and C2 (web) use exactly this.
- Change feed: every successful write to a switch records a clinic change (existing `clinic_changes` feed, `lib/ops/change-ops.ts`) and queues ONE email to ops (hello@ recipients as the existing alert path does) naming clinic, switch, before/after as closed words, actor kind. No patient data, no free text.

Lane ownership (no lane edits another's files; the lead merges):
- A (Opus): settings.ts, settings-view.ts, setup/settings.ts, billing/deposits.ts, db/schema.ts, drizzle migration, lib/email templates for the reset email, switch-rules.ts, their tests.
- B (Sonnet): `app/c/[slug]/settings/*` UI (SettingsCards.tsx, controls.tsx, new `SwitchExplainer` component and CSS in globals.css), setup wizard behaviour screens `app/c/[slug]/setup/screens/BehaviourScreens.tsx`, their tests. Codes against the contract; rendering only; reads `payments.rules`.
- C1 (Opus): `apps/app/src/lib/ops/*` operations above + ops change email.
- C2 (Sonnet): apps/web admin: `apps/web/src/lib/admin/ops-client.ts` wrappers and a "Clinic switches" panel on `/admin/clinics/[clinicId]/setup`, tests.
- Wave 2: D (Opus) support-drafter action tool + closed allowlist; E (Sonnet) docs: LAUNCH_PROMISES items, /admin/map, spec/hipaa tables, Terms/Privacy copy-guard notes.

Rules for every builder: work only in your own worktree and branch; commit after each piece with a message that explains why (Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com> and Claude-Session: https://claude.ai/code/session_018ShLPKchWc5r9u3gmSNZV2 trailers); never push; never touch AGENTS.md, launch.ts or system-map.ts (the lead / lane E does); no @vercel/* or edge in apps/app; apps/web has no database; deterministic tests; run your own vitest files, `npx tsc --noEmit -p .` in the app you touched, and lint for apps/web; database suites skip without TEST_APP_URL, so REPORT skip counts. Report: files changed, commits, tests run with counts and skips, anything you could not do.
