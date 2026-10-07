# The remaining Stripe launch work: design (5 October 2026)

> **Built, 7 October 2026.** B, C, D and E's ops billing panel are built and
> reviewed. What was built, and how to switch it on, is in
> `docs/design/stripe-bcd-as-built-2026-10-07.md`, which wins over this design
> wherever the two differ.

> **Superseded in part, 6 October 2026.** The owner approved the funnel,
> onboarding and portal plan (`docs/design/funnel-onboarding-portal-2026-10-06.md`).
> It supersedes A1, A2 and E's portal screens below. B, C and D are built to
> `docs/design/funnel-portal-contracts-2026-10-06.md`, which wins wherever it
> and this design differ. The changes that matter most here:
> - **No Stripe trial.** Billing starts the day AYA first answers a patient,
>   through a $0 monthly line swapped for the package price at the first
>   answer, with no subscription schedule and no backstop date (contracts §2,
>   as amended on 6 October). Visa's
>   trial rules apply only to free trials and introductory promotions, and
>   Stripe would print "TRIAL OVER" on a trial's first charge.
> - **One email address and one sign-in per clinic.** §6's roles are deferred,
>   and one Stripe billing-portal configuration is enough.
> - **The plan builds the email sender.** Package C supplies kinds, payloads and
>   templates (contracts §3 and §4).
> - **The portal has Settings, not Behaviour.**

> **Status, 5 October 2026.** Package **F0 (foundation) is built and on main**
> (commits 27fad5c, 385e2a8 and 1fc4494):
> migration `0043_stripe_launch` (checkout intents, sign-in links, clinic settings,
> the usage ledger, chat threads, Meta message dedupe, the billing-notice outbox,
> annual overage invoices, deposit payments and the Connect ledgers), the shared
> helpers listed in §5.1, the five billing jobs (seeded off; only housekeeping is
> built, the rest are stubs) and the Better Auth rate-limiter fix. Packages
> **A1, A2, B, C, D and E are designed below but paused by the owner** until the
> sales and onboarding funnel and minimal customer dashboard plan (a separate
> session, launch steps 2.6-2.8) is confirmed; they will then be built to match
> that plan. Where this design and the confirmed funnel/dashboard plan disagree,
> the plan wins, after `docs/v1-product-spec.md`, which wins over both.
>
> **Where F0 deviated from the text below** (the code is right):
> - `stripe_connect_states` stores the clinic as column `target_clinic_id`
>   (Drizzle property `clinicId`): a `clinic_id` column would force a tenant
>   policy that hides the row from the OAuth callback, which has no tenant yet.
> - `expectedMeteredKeys()` returns `string[] | null`: null for a plan not in the
>   catalog (callers skip reconciliation), and `[]` while
>   `OVERAGE_RATES_PROVISIONAL` is true, matching checkout.
> - `updateClinicSettings()` takes `aiPaused: boolean` (it stamps who and when
>   itself) and writes and audits only the fields that change.
> - `usage_events` cannot be updated after insert apart from the three Stripe
>   reporting columns, so `recordUsage` (package B) must lock the billing
>   clinic's entitlements row, compute `used_before`, `included` and
>   `over_allowance`, insert the complete row with `ON CONFLICT DO NOTHING`, and
>   increment the counter only if the insert happened.
> - `sign_in_links.redirect_to` also refuses backslashes and control characters;
>   the sign-in code must still validate any `?next=` value itself.
> - The billing-notice kinds and sign-in-link purposes are single lists in
>   `schema.ts` (`BILLING_NOTICE_KINDS`, `SIGN_IN_LINK_PURPOSES`) that build the
>   database CHECKs too.
>
> **The chat packages were split on main the same day (commit 94a6708).**
> "Web OR Meta Chatbot" and "Web OR Meta + Voice" are now four packages
> (`chat-web`, `chat-meta`, `web-voice`, `meta-voice`) beside `voice`,
> `chat-dual` and `complete`; the package id alone decides the channels and the
> `chat_channel_choice` column is gone (migration 0042). Everything below that
> mentions `chatChannelChoice`, `chat-single` or `chat-voice` as a package
> means the matching new ids; the pricing page still shows five cards, and
> checkout's chat-channel question now picks the package. Plan changes still go
> through healdesk (D13): Stripe's Customer Portal cannot update a monthly
> subscription that carries metered prices, so its plan switch stays off.
>
> The founder's own Stripe steps (Dashboard settings, webhooks, keys, Connect)
> are in the "Stripe launch: your steps" doc
> (https://claude.ai/code/artifact/53c7b203-694a-4d48-9837-be24a0285074).
>
> **The calendar build's seams, 7 October 2026.** The owner let the Google Calendar
> build take the voice booking path below B's gate, `insertAppointment`,
> `notifyDesk`, `decideBookingRequest`, provisioning and the console's booking and
> calendar cards (5 October). What B, C, D and E keep, and what they get from it,
> is in `docs/design/google-calendar-2026-10-05.md` §6, and what is still to be
> settled with them in its §9.

> The section and finding references below ("the billing-core map F5", "the
> web-checkout map §5(d)" and so on) point at seven read-only engineering maps of
> the code made on 5 October 2026 for this design. They are not in the repo; every
> fact this design depends on is restated here or carries a file reference.

## 0. Owner decisions (binding, 5 October 2026)

1. Overage rates and allowances: already on main (commit f612d40). $0.80/voice minute;
   chat $0.40 on `chat-single`, $0.30 elsewhere. Three metered prices on two meters,
   keys `healdesk_meter_voice_minutes_80`, `healdesk_meter_chat_conversations_40|30`
   (catalog `planMeteredPrices`, `meteredPriceLookupKey`).
2. Extra locations: each additional location pays the package's monthly (or annual)
   price again on the SAME subscription and renewal date (prorated), PLUS the package's
   setup fee once. Included minutes/conversations ADD UP across locations (pooled:
   included × locations).
3. A chat conversation = one person's thread on one channel, from their first message
   until 24 hours pass with no message from them (resets on each inbound message). Same
   24 h as Meta's window.
4. A voice minute: each call's length rounded UP to the next whole minute
   (61 s = 2 minutes). Calls are metered per call, never by summing seconds.
5. Deposits gateway: Stripe Connect only (OAuth, Standard accounts — keeps the clinic's
   existing Stripe account). Clinics without it: front desk collects (pending_front_desk).

## 1. Orchestrator design decisions (binding)

D1  Checkout intents. apps/web stores nothing; before creating a Stripe Checkout Session
    it POSTs the validated purchase form to apps/app `POST /api/checkout/intents`, which
    validates it exactly like provisioning would and stores it, returning an opaque
    `ref` (uuid). Stripe Session metadata and `subscription_data.metadata` become
    `{ app: "healdesk", ref }` only; `client_reference_id = ref`. This removes every
    "paid but provisioning refused" case (the web-checkout map H1-H4) and the PII in Stripe
    metadata. Keep the legacy full-metadata path in the webhook for sessions created
    before the deploy.
D2  Account creation on the FIRST PAID INVOICE. apps/web's platform webhook stops
    provisioning on `checkout.session.completed`. On `invoice.paid` with
    `billing_reason === "subscription_create"` and the healdesk marker, apps/web reads
    `ref` (or legacy fields) from the invoice's subscription metadata snapshot
    (`invoice.parent.subscription_details.metadata`, legacy
    `invoice.subscription_details.metadata`), relays `/api/provision` with
    `idempotencyKey = <subscription id>`, and ONLY THEN forwards the event to
    `/api/billing/events` (which moves provisioning -> active). Provision 5xx/unreachable
    -> route 500 and do NOT forward (Stripe retries). Provision 4xx -> loud log, still
    forward (event parks, auto-replays if an operator later provisions).
    Cutover safety in apps/app: if a clinic already exists for the subscription/customer
    (`clinicIdForStripe`), return it as a replay instead of provisioning twice. The replay
    path also runs `replayParkedBillingEvents` (the billing-core map F5).
D3  Identity at provisioning. Inside the provisioning transaction: find-or-create
    `"user"` by lower(contactEmail) (name = contactName, email_verified false; insert
    directly through the Drizzle auth schema so Better Auth's invite-only create hook is
    not involved), insert `member` (organization, user, role "owner") unless one exists,
    insert `clinic_memberships (clinic_id, user_id, role 'owner')`, and
    `recordSecurityEvent(tx, { event: "role_granted", ... })`. Never put the email in
    audit/security metadata (only `actorLabel`).
D4  Sign-in is by single-use links only, one mechanism: table `sign_in_links` (§3.2).
    Purposes and TTLs: `checkout` 10 min, `sign_in` 15 min, `welcome` 7 days,
    `invite` 7 days. The emailed/handed-off URL is `publicUrl("/link/<token>")`. GET
    `/link/[token]` resolves without consuming and renders a single "Continue" POST
    button (scanner-safe; for purpose `checkout` the page may auto-submit with a tiny
    client script because it is the paying browser). The server action consumes the
    link and creates the Better Auth session through a SERVER-ONLY Better Auth endpoint
    (`createAuthEndpoint.serverOnly`, local plugin, before `nextCookies()`), which calls
    `internalAdapter.createSession` + `setSessionCookie` (the auth-portal map §17). Then
    redirect (outside try) to the link's `redirect_to` or `/`. The Better Auth
    magic-link plugin is NOT used.
    `/sign-in`: email field -> server action -> our own rate limit -> if the email
    belongs to a user with at least one active grant, issue a `sign_in` link and email
    it; ALWAYS answer the same "check your email" state. `/sign-in/help`: the spec's
    "I cannot get in" route — a short form (email, clinic name, what happened) that
    emails `HEALDESK_ADMIN_EMAIL` (phiClass "none"); no lookup is revealed to the user.
D5  Better Auth rate limiter: switch `rateLimit.storage` to `"memory"` (the database
    model does not exist and every `/api/auth/*` HTTP request currently throws). Add a
    test that `auth.handler(new Request(base + "/api/auth/get-session"))` resolves.
D6  Roles: spec owner -> clinic_role 'owner'; manager -> 'admin'; billing contact ->
    'billing'. Other enum values get no portal access. Capability matrix in §6.
D7  Portal routes (apps/app): `/c/[clinicSlug]` (Home), `/c/[clinicSlug]/billing`,
    `/c/[clinicSlug]/behaviour` (deposits + direct line + Stripe Connect + Pause AI).
    `/` redirects to the user's most recent clinic or `/sign-in`. Data access goes
    through `lib/portal/access.ts` `requirePortal(slug, capability)` on EVERY page and
    server action (never trust a clinicId from a form). Grants are listed by a new
    SECURITY DEFINER tenant-walk function `app_user_clinic_grants(user_id)`.
D8  Second factor before transcripts: OUT OF SCOPE (no transcript screen is built here).
    Do not add twoFactor.
D9  New tenant table `clinic_settings` for per-clinic switches (deposits, Pause AI,
    direct line) so edits never clear agent approval and need no clinics column grants.
    Billing switches live on `entitlements`.
D10 Usage. `usage_events` ledger (source of truth) + entitlements counters.
    Voice: per call `ceil(durationSeconds / 60)` minutes, from Synthflow's documented
    `duration` (seconds) or endedAt - startedAt; neither -> do not meter, log warn.
    Chat: `chat_threads` per (clinic, channel, party_ref); a new conversation starts
    when no row exists or `last_inbound_at < sentAt - 24h`; counted once, when the
    assistant is allowed to answer it. Allowance is pooled: included × locations.
D11 Answer gate `assistantMayAnswer` (§5.4). Answer when billing status is active,
    past_due (inside grace) or canceling (paid period), or there is no entitlements row
    (synthetic/dev/demo). Refuse on provisioning, suspended, paused, canceled, purged,
    Pause AI, or hard cap reached for a NEW call/conversation. Fallback: voice -> pass
    through to `clinic_settings.direct_line_e164`; Meta -> no reply (DM left for staff);
    web chat -> contact form (future API). A direct line becomes a go-live precondition.
D12 Billing notices outbox `billing_notices` (§3.6). Stripe-event handlers, the sweep
    and jobs INSERT notices inside their tenant transaction (dedupe key); a sender
    delivers them outside any transaction to the owner(s) and billing contact(s) of the
    BILLING clinic, never report_recipients (fallback to the provisioning recipient
    only when a clinic has no owner/billing membership — legacy rows).
D13 Plan changes, extra locations, auto-renew and Stripe portal sessions are healdesk
    actions in apps/app (`lib/billing/stripe-actions.ts`), because Stripe's portal cannot
    update a subscription that carries metered prices. The Stripe portal is used only
    for invoices, payment method and cancel-at-period-end (two API-created
    configurations: `owner` with cancel, `billing` without).
D14 Deposits live entirely in apps/app: `deposit_payments`, direct Checkout Sessions on
    the clinic's connected account, a Connect webhook terminating in apps/app
    (`/api/webhooks/stripe-connect`, its own secret), OAuth state single-use, no account
    overwrite, callback redirects to a clinic-facing apps/app page (never `/admin`).
D15 apps/app holds a Stripe secret key (already true for Connect). Read it through
    `env.ts` + `lib/billing/stripe-client.ts`. Move `stripe` from devDependencies to
    dependencies in apps/app/package.json.
D16 Every clinic-facing URL is built by `lib/public-url.ts` `publicUrl(path)` from
    `BETTER_AUTH_URL` (throws in production when unset). Route the existing copies
    through it.

---------------------------------------------------------------------------------------
## 2. Conventions every agent must follow (from the maps; violations fail review)

- Tenancy: patient/tenant data only through `withTenant({ clinicId, actor, request? })`
  (`apps/app/src/lib/tenant.ts`). `unsafeDb` only for identity-plane tables and the
  definer-function lookups. Never accept a clinicId from a browser.
- Billing status changes only through `transition()`; history-only rows through
  `recordBillingNote()`. Entitlements writers take `(db: Transaction, clinicId)`, never
  write status, and use `updateOrThrow` (or return null where a missing row is normal).
- Audit: `tx.audit.record({ action, resourceType, resourceId?, metadata? })`.
  `assertNoPhi` rejects keys: phone, phonenumber, email, fullname, firstname, lastname,
  name, dob, ssn, address, transcript, recording*, notes, note, treatment, diagnosis,
  medication, symptom, message, content, body — and email/phone-shaped VALUES (digit runs
  >= 10). Use neutral keys (`remark`, `reason`, `field`), booleans and enums. Hash ids
  (sha256 hex is stripped by the guard) — never raw vendor ids that are digit-heavy.
- Security events: `recordSecurityEvent(db, { event, actorLabel, userId?, organizationId?,
  metadata })`; email only in `actorLabel`.
- Logging: only `log.info|warn|error(message, fields)` with keys from `ALLOWED_LOG_KEYS`
  (`apps/app/src/lib/log.ts`); any other key THROWS. Never log emails, tokens, URLs that
  are credentials, payloads. apps/app has a no-console test.
- Emails: `lib/reporting/deliver.ts` `getTransport(message.phiClass)`, `phiClass: "none"`,
  render pure `{subject, text, html}` (html may be ""), links in the body never the
  subject, never throw from a sender (return sent|skipped|failed), redact URLs from
  reasons, give every sender a `transport?` seam for tests. Copy rules: CLAUDE.md "Claims
  and copy" (no "revenue"/"collected", rates are provisional, BAA phrasing, per-channel
  set-up promise). No patient data in any email.
- Stripe calls never inside a database transaction (commit, call, then a new tx).
  Every money-moving call carries an idempotency key. Read Stripe payloads
  structurally (`prop/asString/refId` helpers as in events.ts) to tolerate API shapes;
  the SDK is stripe 22.6.1, default API version 2026-08-26.dahlia — CHECK every field
  path against `node_modules/stripe/cjs/resources/**/*.d.ts` before using it.
- Migrations: only work package F0 edits `apps/app/src/db/schema.ts` and writes
  `drizzle/0043_*`. If another package discovers it truly needs a schema change, it
  must STOP and report it in its final message instead of editing schema/migrations.
- Next 16: `params`/`searchParams` are Promises; `cookies()`/`headers()` async; only
  route handlers and server actions set cookies; `redirect()` OUTSIDE try/catch.
  Route handlers: `export const runtime = "nodejs"; export const dynamic = "force-dynamic";`.
- Style: long prose comments explaining WHY and naming the failure prevented; British
  spelling; no emojis. Prettier has no config: format touched files with
  `npx prettier --print-width 100 --write <files>` only if the file was already
  formatted that way (check git diff noise); never reformat untouched files.
- Tests: vitest. apps/app DB suites use `const describeDb = hasTestDatabase ? describe :
  describe.skip`, `runMigrations()`, `truncateAll()`, `closePools()`, seed with
  `tests/setup/factories.ts` (`seedClinic`, `inTenant`), pinned `now` (never the wall
  clock for date logic). apps/web tests: `src/**/*.test.ts` only (no .tsx), route
  handlers imported and called with `new Request(...)`, `vi.stubEnv`, `vi.stubGlobal("fetch")`,
  Stripe webhook signatures via `Stripe.webhooks.generateTestHeaderString`.
- Commit nothing. The orchestrator commits. Do not run `git stash`, `git add`,
  `git commit`, `git push`, or touch other worktrees.

---------------------------------------------------------------------------------------
## 3. Schema: migration 0043 (work package F0 wrote all of it)

Generate with `npm run db:generate -w @healdesk/app` after editing schema.ts (or
`db:generate:custom` for SQL-only parts), then hand-append RLS/grants/functions/comments
below the generated SQL with a banner, following `drizzle/0041_inbound_only.sql`.
New tenant tables: ENABLE + FORCE RLS, policy
`<table>_tenant_isolation FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id())`,
add to `TENANT_SCOPED_TABLES`, and REVOKE what the runtime role must not have (default
privileges grant SELECT/INSERT/UPDATE/DELETE). Must pass `tests/rls-drift.test.ts`,
`tests/database-audit.test.ts` (pinned search_path on definer functions; BAA-gate list;
clinics column grants) and `tests/tenant-isolation.test.ts`.

### 3.1 `checkout_intents` (identity plane; business contact data, no clinic_id, no RLS)
- `ref uuid PK default gen_random_uuid()`
- `payload jsonb NOT NULL` — the validated purchase: clinicName, specialty, platform,
  plan, billingInterval, chatChannelChoice?, contactName, contactEmail (lowercased),
  contactTitle?, phoneSystemType, callRouting, agreementId
- `agreement_id uuid NOT NULL`, `contact_email text NOT NULL`, `plan text NOT NULL`,
  `billing_interval text NOT NULL CHECK (billing_interval IN ('month','year'))`
- `created_at timestamptz NOT NULL default now()`, `expires_at timestamptz NOT NULL`
  (now() + 14 days, set by the app with the DB clock)
- `stripe_subscription_id text NULL UNIQUE`, `consumed_at timestamptz NULL`,
  `provisioned_clinic_id uuid NULL`, `handoff_issued_at timestamptz NULL`
- Runtime grants: SELECT, INSERT, UPDATE, DELETE (the housekeeping job purges).
- COMMENT: business contact data of a clinic buyer, held until provisioning; not PHI.

### 3.2 `sign_in_links` (identity plane)
- `id uuid PK default gen_random_uuid()`
- `user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE`
- `token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32)`
- `purpose text NOT NULL CHECK (purpose IN ('checkout','welcome','sign_in','invite'))`
- `source_ref text NULL` — e.g. sha256 hex of the checkout intent ref; UNIQUE index on
  `(purpose, source_ref) WHERE source_ref IS NOT NULL`
- `redirect_to text NULL CHECK (redirect_to IS NULL OR (redirect_to LIKE '/%' AND redirect_to NOT LIKE '//%'))`
- `created_at timestamptz NOT NULL default now()`,
  `expires_at timestamptz NOT NULL CHECK (expires_at > created_at)`
- `used_at timestamptz NULL`, `consumed_ip inet NULL CHECK (consumed_ip IS NULL OR used_at IS NOT NULL)`,
  `issued_by text NULL`
- Grants: REVOKE DELETE, REVOKE UPDATE, then `GRANT UPDATE (used_at, consumed_ip)`.
- No-rewrite trigger copied from `app_connection_link_no_rewrite` (drizzle/0024): once
  `used_at` is set it cannot change. (Housekeeping deletes old rows as the migrator? NO —
  the runtime role cannot DELETE; old links simply expire. Leave them.)

### 3.3 `clinic_settings` (tenant)
- `clinic_id uuid PK REFERENCES clinics(id) ON DELETE CASCADE`
- `deposits_enabled boolean NOT NULL default false`
- `book_voice_without_deposit boolean NOT NULL default true`
- `book_chat_without_deposit boolean NOT NULL default false`
- `deposit_uncollectable text NOT NULL default 'book_and_flag' CHECK (deposit_uncollectable IN ('book_and_flag','hold_and_alert','decline_and_alert'))`
- `deposit_hold_minutes integer NOT NULL default 60 CHECK (deposit_hold_minutes BETWEEN 30 AND 1440)`
- `ai_paused_at timestamptz NULL`, `ai_paused_by_label text NULL`
- `direct_line_e164 text NULL CHECK (direct_line_e164 IS NULL OR direct_line_e164 ~ '^\+[1-9][0-9]{6,14}$')`,
  `direct_line_set_at timestamptz NULL`
- `updated_at timestamptz NOT NULL default now()`
- Grants: SELECT, INSERT, UPDATE; REVOKE DELETE.
- A missing row means defaults (library returns defaults; writers upsert).

### 3.4 `usage_events` (tenant; tenant = the BILLING clinic whose allowance was used)
- `id uuid PK default gen_random_uuid()`
- `clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE` (billing clinic)
- `location_clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE`
- `meter text NOT NULL CHECK (meter IN ('voice_minutes','chat_conversations'))`
- `source text NOT NULL CHECK (source IN ('voice_call','meta','web_chat'))`
- `source_ref text NOT NULL` (sha256 hex of the call id or the chat conversation id)
- `quantity integer NOT NULL CHECK (quantity > 0)`
- `occurred_at timestamptz NOT NULL`, `window_start timestamptz NULL`
- `included integer NOT NULL`, `used_before integer NOT NULL`
- `over_allowance integer NOT NULL default 0 CHECK (over_allowance >= 0)`
- `stripe_reported_at timestamptz NULL`, `stripe_report_attempts integer NOT NULL default 0`,
  `stripe_report_error text NULL`
- `created_at timestamptz NOT NULL default now()`
- UNIQUE `(clinic_id, meter, source, source_ref)`; index `(clinic_id, window_start)`;
  partial index `(clinic_id, occurred_at) WHERE over_allowance > 0 AND stripe_reported_at IS NULL`
- Grants: SELECT, INSERT, `UPDATE (stripe_reported_at, stripe_report_attempts, stripe_report_error)`; REVOKE DELETE.

### 3.5 `chat_threads` (tenant)
- `clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE`
- `channel text NOT NULL CHECK (channel IN ('messenger','instagram','whatsapp','web_chat'))`
- `party_ref text NOT NULL` (sha256 hex of the platform sender id)
- `conversation_id uuid NOT NULL` (regenerated when a new conversation starts)
- `conversation_started_at timestamptz NOT NULL`, `last_inbound_at timestamptz NOT NULL`
- `conversations_count integer NOT NULL default 1`
- PRIMARY KEY `(clinic_id, channel, party_ref)`
- Grants: SELECT, INSERT, UPDATE, DELETE.

### 3.6 `meta_inbound_messages` (tenant; dedupe of Meta redeliveries)
- `clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE`
- `platform text NOT NULL CHECK (platform IN ('messenger','instagram','whatsapp'))`
- `message_ref text NOT NULL` (sha256 hex of the Meta message id)
- `received_at timestamptz NOT NULL default now()`
- PRIMARY KEY `(clinic_id, platform, message_ref)`; index on `received_at`
- Grants: SELECT, INSERT, DELETE (housekeeping purges after 7 days); REVOKE UPDATE.

### 3.7 `billing_notices` (tenant; tenant = the billing clinic)
- `id uuid PK default gen_random_uuid()`
- `clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE`
- `kind text NOT NULL CHECK (kind IN ('payment_failed','payment_action_required','grace_ending','suspended','restored','cancel_scheduled','cancel_reversed','canceled','renewal_upcoming','usage_80','usage_100','overage_invoiced','plan_changed','location_added','connect_disconnected','welcome_resend'))`
- `dedupe_key text NOT NULL`
- `payload jsonb NOT NULL default '{}'` (no PHI: amounts in cents, ISO dates, Stripe-hosted
  invoice URLs, plan ids, meter names, location counts)
- `created_at timestamptz NOT NULL default now()`, `send_after timestamptz NOT NULL default now()`
- `sent_at timestamptz NULL`, `attempts integer NOT NULL default 0`, `last_error text NULL`,
  `recipients_count integer NULL`
- UNIQUE `(clinic_id, kind, dedupe_key)`; partial index `(send_after) WHERE sent_at IS NULL`
- Grants: SELECT, INSERT, `UPDATE (send_after, sent_at, attempts, last_error, recipients_count)`; REVOKE DELETE.

### 3.8 `overage_invoices` (tenant; annual plans only)
- `id uuid PK default gen_random_uuid()`, `clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE`
- `window_start timestamptz NOT NULL`, `window_end timestamptz NOT NULL`
- `voice_units integer NOT NULL default 0`, `chat_units integer NOT NULL default 0`
- `voice_rate_cents integer NOT NULL default 0`, `chat_rate_cents integer NOT NULL default 0`
- `amount_cents integer NOT NULL default 0`
- `status text NOT NULL CHECK (status IN ('pending','invoiced','failed','skipped'))`
- `stripe_invoice_id text NULL`, `error text NULL`
- `created_at timestamptz NOT NULL default now()`, `invoiced_at timestamptz NULL`
- UNIQUE `(clinic_id, window_start)`
- Grants: SELECT, INSERT, UPDATE; REVOKE DELETE.

### 3.9 `deposit_payments` (tenant; carries the BAA gate trigger)
- `id uuid PK default gen_random_uuid()` — THE opaque reference sent to Stripe
- `clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE`
- `appointment_id uuid NULL REFERENCES appointments(id) ON DELETE SET NULL`
- `channel text NOT NULL CHECK (channel IN ('web','meta'))`
- `amount_cents integer NOT NULL CHECK (amount_cents > 0)`, `currency text NOT NULL default 'usd'`
- `stripe_account_id text NOT NULL`, `checkout_session_id text NULL UNIQUE`
- `status text NOT NULL CHECK (status IN ('creating','open','paid','expired','failed','cancelled','refunded'))`
- `expires_at timestamptz NULL`, `paid_at timestamptz NULL`, `last_event_id text NULL`
- `created_at timestamptz NOT NULL default now()`, `updated_at timestamptz NOT NULL default now()`
- `BEFORE INSERT OR UPDATE ... EXECUTE FUNCTION app_enforce_baa_gate()` trigger and the
  table name added to the exact list in `tests/database-audit.test.ts`.
- Grants: SELECT, INSERT, UPDATE; REVOKE DELETE.

### 3.10 `stripe_connect_events` (identity plane; NO payload — Connect events carry payer details)
- `stripe_event_id text PK`, `type text NOT NULL`, `account text NOT NULL`
- `received_at timestamptz NOT NULL default now()`, `processed_at timestamptz NULL`
- `outcome text NULL CHECK (outcome IS NULL OR outcome IN ('processed','ignored','failed','dead_letter'))`
- `failures integer NOT NULL default 0`, `error text NULL`, `resolved_clinic_id uuid NULL`
- Grants: SELECT, INSERT, UPDATE; REVOKE DELETE.

### 3.11 `stripe_connect_states` (identity plane; single-use OAuth state)
- `state_hash bytea PK CHECK (octet_length(state_hash) = 32)`
- `clinic_id uuid NOT NULL`, `user_id text NULL`
- `return_to text NOT NULL CHECK (return_to IN ('portal','ops'))`
- `created_at timestamptz NOT NULL default now()`, `expires_at timestamptz NOT NULL`, `used_at timestamptz NULL`
- Grants: SELECT, INSERT, UPDATE, DELETE.

### 3.12 New columns
`entitlements` (table-level UPDATE already granted):
- `usage_alerts_enabled boolean NOT NULL default true`
- `locations integer NOT NULL default 1 CHECK (locations >= 1)`
- `first_paid_at timestamptz NULL` (first invoice paid; refund windows)
- `paid_through timestamptz NULL` (end of the paid licensed period; renewal reminders)
- `last_paid_invoice_id text NULL` (stale payment_failed guard, the billing-core map F3)
- `open_invoice_id text NULL`, `open_invoice_url text NULL` (Stripe-hosted pay link of the unpaid invoice)
- `metered_price_keys text[] NOT NULL default '{}'` (snapshot of the subscription's metered item lookup keys)
- `cancel_at timestamptz NULL`
- `setup_fee_refunded_at timestamptz NULL`, `setup_fee_refunded_usd numeric(12,2) NULL`
- `first_period_refunded_at timestamptz NULL`

`clinics` (each new column needs `GRANT UPDATE (col) ON clinics TO healdesk_app`, and
`app_clinics_overview()` must be DROPped and re-CREATEd to expose them; update
`lib/ops/clinics.ts` `ClinicOverview` + `listClinics` mapping and the exact key list in
`tests/ops.test.ts`):
- `billing_clinic_id uuid NULL REFERENCES clinics(id) ON DELETE RESTRICT` (a location
  points at the clinic that holds the subscription; NULL = it is its own billing clinic)
- `stripe_connect_disconnected_at timestamptz NULL`

### 3.13 Definer functions (pinned `search_path = public, pg_temp`, `REVOKE ALL FROM PUBLIC`,
`GRANT EXECUTE TO healdesk_app`)
- `app_user_clinic_grants(target_user text) RETURNS TABLE (clinic_id uuid, slug text, name text, role clinic_role, last_seen_at timestamptz)`
  — tenant walk exactly as the auth-portal map §16 (loop over clinics in the user's
  organizations via `member`, set app.clinic_id per clinic, read clinic_memberships
  active rows, restore the previous setting).
- `app_clinics_for_stripe_account(acct text) RETURNS SETOF uuid` — `SELECT id FROM clinics
  WHERE stripe_connect_account_id = acct` (clinics is not FORCEd, so a definer select works).
- `app_location_clinics(billing_clinic uuid) RETURNS SETOF uuid` — the billing clinic
  plus every clinic whose `billing_clinic_id = billing_clinic`.

### 3.14 Scheduled jobs (seeded OFF, `ON CONFLICT (name) DO NOTHING`)
- `usage-meter-report` — "Hourly; reports overage on monthly plans to Stripe's meters"
- `annual-overage-invoice` — "Daily at 05 UTC; invoices annual plans' overage per closed month"
- `usage-alerts` — "Hourly; queues the 80% and 100% allowance emails"
- `billing-notices` — "Hourly backstop; sends queued billing emails to owners and billing contacts"
- `billing-housekeeping` — "Daily at 06 UTC; purges expired checkout intents and Meta message refs"
Also add each to the reseed list in `tests/setup/db.ts` and to the tick wiring.

---------------------------------------------------------------------------------------
## 4. HTTP contracts between apps/web and apps/app (all HMAC-signed with
`HEALDESK_PROVISION_SECRET`, `sign/verify` from @healdesk/catalog, verify BEFORE parse,
bounded body, `Cache-Control: no-store`)

### 4.1 `POST {HEALDESK_APP_URL}/api/checkout/intents`
Request JSON: `{ clinicName, specialty, platform, contactName, contactEmail, contactTitle?,
phoneSystemType, callRouting, agreementId, plan, billingInterval, chatChannelChoice? }`
- Validate like `validateProvisionRequest` (minus idempotencyKey, Stripe ids and the
  attribution fields): clinicName 1..120, specialty valid, platform valid, plan valid,
  billingInterval month|year, chatChannelChoice only for choice plans (default "web"),
  contactName required (<=120), contactEmail sendable (<=254), contactTitle <=120,
  callRouting/phoneSystemType enums, agreementId uuid. Then the agreement must exist,
  be UNBOUND (no organization yet), and have been signed by this contactEmail
  (case-insensitive).
- 201 `{ ref, expiresAt }` | 422 `{ error, field }` | 401 | 413 | 503 | 500.

### 4.2 `POST {HEALDESK_APP_URL}/api/provision`
Accept EITHER the legacy full ProvisionRequest (unchanged behaviour) OR the new
`{ ref, idempotencyKey, stripeCustomerId, stripeSubscriptionId }`.
- ref path: load the intent; it must exist and be unexpired, or already consumed BY THIS
  SUBSCRIPTION (then return the replay). Build the ProvisionRequest from the payload with
  `attributionMode: "estimated"` and no averageTreatmentValueUsd (make both optional in
  `validateProvisionRequest`; provisioning stores the defaults). Provision with
  `idempotencyKey = subscription id`. On genuine creation: create the owner identity
  (D3) in the same transaction, mark the intent consumed (`consumed_at`,
  `stripe_subscription_id`, `provisioned_clinic_id`), and after commit send the welcome
  email (purpose `welcome` sign-in link + the existing setup link) — never throw.
- Unapproved BAA template becomes a ProvisioningError (422), not a plain Error (F13).
- Response adds `{ plan, billingInterval }` (for apps/web's lead conversion MRR).

### 4.3 `POST {HEALDESK_APP_URL}/api/checkout/handoff`
Request `{ ref }`. Response 200 with exactly one of:
`{ status: "pending" }` (intent not yet consumed), `{ status: "ready", url, expiresAt }`
(first call within 24 h of consumption; issues a `checkout` sign-in link for the owner,
`source_ref = sha256(ref)`, sets `handoff_issued_at`), `{ status: "use_email" }`
(already issued, or consumed more than 24 h ago). 404 `{ status: "unknown" }` for an
unknown ref. Nothing else is ever returned. Actor `{ type: "service", serviceName: "checkout-handoff" }`.

### 4.4 apps/web `GET /api/checkout/status?session_id=cs_...` (apps/web only)
Cookie `hd_checkout` (HttpOnly, SameSite=Lax — it must survive the top-level navigation
back from checkout.stripe.com — Secure in production, Path `/api/checkout`, 2 h) holds a
token bound to the Checkout Session id (copy the `agreement-download.ts` token shape, new
KEY_PURPOSE `healdesk.checkout-handoff.v1`, key from `HEALDESK_GATE_SECRET`). Steps:
verify the cookie token FIRST (401 `{status:"unknown"}` for every failure shape, no env
read, no upstream call) -> shape-check `cs_(test|live)_...` -> rate limit -> retrieve the
Session from Stripe -> if `metadata.app !== "healdesk"` or no `metadata.ref` ->
`{status:"problem"}`; if `status !== "complete"` -> `{status:"pending"}`; if
`payment_status === "unpaid"` (delayed method) -> `{status:"processing"}`; else call 4.3
and map. On ready/use_email/problem/processing clear the cookie. The done page polls
this (1 s backing off to 5 s, give up ~90 s) and does `window.location.replace(url)` on
ready.

### 4.5 Stripe Connect webhook
Stripe -> `{BETTER_AUTH_URL}/api/webhooks/stripe-connect` on apps/app directly (never via
apps/web). Its own secret `STRIPE_CONNECT_WEBHOOK_SECRET` (apps/app env).

---------------------------------------------------------------------------------------
## 5. Module contracts (apps/app unless stated). F0 creates every file marked STUB with
the exact exported signature and a minimal safe body, so parallel packages compile
against it; the owning package replaces the body.

### 5.1 F0-owned shared helpers (real implementations)
- `lib/public-url.ts`: `publicUrl(path: string): string`.
- `lib/billing/stripe-client.ts`: `getStripe(): Stripe` (throws `StripeNotConfiguredError`
  when no key), `stripeConfigured(): boolean`, `__setStripeForTests(fake: unknown | null)`.
- `lib/billing/billing-clinic.ts`:
  `resolveBillingClinicId(tx: TenantTx): Promise<string>` (reads `clinics.billing_clinic_id`
  of tx.clinicId inside the current tenant; returns tx.clinicId when null) and
  `withBillingTenant<T>(clinicId: string, actor: ActorContext, fn: (tx: TenantTx) => Promise<T>): Promise<T>`
  (opens withTenant on the location to resolve, then withTenant on the billing clinic).
- `lib/billing/recipients.ts`: `billingRecipients(tx: TenantTx): Promise<{ email: string; role: "owner" | "billing"; userId: string | null }[]>`
  — active clinic_memberships with role owner/billing joined to `"user".email` on the
  billing clinic; when none, the provisioning report recipient (added_by 'provisioning').
- `lib/billing/settings.ts`: `ClinicSettings` type, `DEFAULT_CLINIC_SETTINGS`,
  `getClinicSettings(tx): Promise<ClinicSettings>` (defaults when no row),
  `updateClinicSettings(tx, patch: Partial<...>, actorLabel: string): Promise<ClinicSettings>`
  (upsert, validates E.164 direct line != published/synthflow numbers, audits booleans/enums
  only — `directLineSet: boolean`, never the number).
- `lib/billing/notices.ts` (F0 writes the TYPES and `enqueueNotice`, STUB the sender):
  `type BillingNoticeKind` (the CHECK list), `type NoticePayloads` (§7),
  `enqueueNotice(tx: TenantTx, kind, dedupeKey: string, payload, options?: { sendAfter?: Date }): Promise<boolean>`
  (INSERT ... ON CONFLICT DO NOTHING; returns whether inserted),
  STUB `sendPendingNotices(options?: { clinicId?: string; now?: Date; transport?: EmailTransport; limit?: number }): Promise<{ sent: number; failed: number; skipped: number }>`,
  STUB `runBillingNoticesJob(options?)`.
- catalog: move `parseLookupKey` + `ParsedLookupKey` to `packages/catalog/src/plans.ts`
  (apps/app `entitlements.ts` re-exports it so imports keep working); add
  `CHAT_CONVERSATION_SILENCE_MS = 24 * 60 * 60 * 1000`;
  `billableVoiceMinutes(durationSeconds: number): number` (ceil to whole minutes, 0 for
  <= 0, NaN-safe); `additionalLocationChargeUsd(plan, interval)` returning
  `{ recurringUsd, setupFeeUsd }`; `SETUP_FEE_REFUND_NOT_LIVE_DAYS = 30` and
  `FIRST_PERIOD_REFUND_DAYS = 14` (apps/web `legal.ts` POLICY reads these two from the
  catalog so the numbers live once). Tests for all of it in `plans.test.ts`.
- env.ts accessors (optional in dev, documented): `stripeSecretKey()`,
  `stripeConnectClientId()`, `stripeConnectWebhookSecret()`, `adminEmail()` exists.
- `lib/scheduler/jobs.ts` constants `JOB_USAGE_METER_REPORT`, `JOB_ANNUAL_OVERAGE_INVOICE`,
  `JOB_USAGE_ALERTS`, `JOB_BILLING_NOTICES`, `JOB_BILLING_HOUSEKEEPING`; `tick.ts` wiring
  (hourly: usage-meter-report, usage-alerts, billing-notices; 05 UTC annual-overage-invoice;
  06 UTC billing-housekeeping). STUB modules: `lib/billing/usage-report.ts`
  (`runUsageMeterReportJob`), `lib/billing/annual-overage.ts` (`runAnnualOverageJob`),
  `lib/billing/usage-alerts.ts` (`runUsageAlertsJob`), `lib/billing/housekeeping.ts`
  (`runBillingHousekeepingJob` — F0 implements it fully: delete intents expired and not
  consumed, consumed intents older than 90 days, meta_inbound_messages older than 7 days,
  connect states older than 1 day).
- STUB `lib/billing/metered-items.ts`:
  `expectedMeteredKeys(planId: string, interval: BillingInterval): string[]` (real) and
  `reconcileMeteredItems(clinicId: string, options?: { stripe?: Stripe }): Promise<{ status: "ok" | "fixed" | "skipped" | "failed"; reason?: string }>` (STUB returns skipped).
- `log.ts` ALLOWED_LOG_KEYS: add `meter`, `kind`, `purpose`, `decision`, `outcome`,
  `attempt`, `units`, `noticeId`, `windowStart`, `job` (if missing), `phase`, `channel`,
  `field` — only keys that are not already present; each carries no PHI.
- `tests/setup/factories.ts`: `seedClinic` also inserts a `member` row (role 'owner') for
  its staff user so `app_user_clinic_grants` works; add `seedEntitled(clinicId, opts)`
  helper (seedEntitlements + optional recordFirstInvoice + transition to active) and
  `seedPortalUser(clinicId, role)` returning `{ userId, email }`.
- Fix `rateLimit.storage` -> "memory" in `lib/auth.ts` (D5) with the handler test.
- `apps/app/package.json`: `stripe` -> dependencies.

### 5.2 Package A1 (accounts, sign-in, portal shell, purchase backend) — real
- `lib/auth/sign-in-links.ts`:
  `issueSignInLink(input: { userId: string; purpose: "checkout"|"welcome"|"sign_in"|"invite"; sourceRef?: string; redirectTo?: string; issuedBy: string }): Promise<{ token: string; url: string; expiresAt: Date }>`;
  `resolveSignInLink(token: string): Promise<{ purpose; expiresAt } | null>` (no consume);
  `consumeSignInLink(token: string, ip: string | null): Promise<{ userId; purpose; redirectTo: string | null } | null>`
  (single conditional UPDATE). Security events `sign_in_link_issued` / `sign_in` (no token, no URL).
- `lib/auth.ts`: local plugin with server-only `redeemSignInLink` endpoint (D4).
- `lib/portal/session.ts`, `lib/portal/roles.ts` (capability matrix §6),
  `lib/portal/access.ts` (`requirePortal(slug, capability)`, `listMyClinics(userId)`),
  `safeRequestMeta()`.
- Pages: `app/page.tsx`, `app/sign-in/**`, `app/sign-in/help/**`, `app/link/[token]/**`,
  `app/link/invalid`, `app/(portal)/layout.tsx` (chrome: nav Home / Billing / Behaviour
  filtered by role, sign out), `app/(portal)/c/[clinicSlug]/page.tsx` (Home: billing
  status line, setup checklist from `clinics.onboarding`, links). Billing and Behaviour
  pages are package E.
- `lib/checkout/intents.ts` + `app/api/checkout/intents/route.ts` (4.1);
  `app/api/checkout/handoff/route.ts` (4.3); provisioning changes (4.2, D2, D3);
  `lib/email/welcome.ts`, `lib/email/sign-in-link.ts`; fix `lib/access.ts`
  (`acceptInvitationFor`) or delete dead code with a note; fix/replace dead `lib/session.ts`.
- `lib/billing/locations.ts` is package C (it reuses A1's identity helpers; A1 exports
  `grantClinicAccess(tx, { userId, role, grantedBy? })`).

### 5.3 Package A2 (apps/web purchase flow) — real
- `lib/checkout-handoff.ts` (token + cookie options), `lib/checkout-intents-client.ts`
  (signed POST to 4.1, 8 s timeout, `redirect: "manual"`), `lib/stripe-relay.ts`
  (relayTo moved out of the webhook route, with timeout and manual redirects).
- `app/api/checkout/route.ts`: explicit allowlist payload + validation (422 with field
  BEFORE any upstream call), create intent, `createCheckout({ plan, interval, contactEmail, ref, offer })`,
  set `hd_checkout`, return `{ checkoutUrl }`; lead calls in `after()` or wrapped;
  `findLeadById` failures never break checkout.
- `lib/billing.ts`: metadata `{ app, ref }` on Session and subscription_data,
  `client_reference_id = ref`, `branding_settings.display_name = "healdesk"`,
  `automatic_tax: { enabled: true }` only when `STRIPE_AUTOMATIC_TAX === "true"`,
  return `sessionId`. Delete `toMetadata`/`provisionPayload`.
- `app/api/checkout/status/route.ts` (4.4) and the done page client `Handoff.tsx`
  (honest copy line, clears the stored agreement, polls, replaces location).
- `app/api/webhooks/stripe/route.ts`: D2 orchestration; ignore `event.account` (Connect
  events) with a loud log; require `session.mode === "subscription"`; `checkout.session.completed`
  only records conversion (never provisions); wrap `markCheckoutAbandoned`; legacy path
  strips `offer`; route tests (the web-checkout map §5(d)).
- CheckoutFlow: remove step 3 (attribution), TOTAL_STEPS 5, maxLength on fields, send the
  allowlist only; AgreementStep keeps `attributionMode: "estimated"` as a constant.
- Copy: extra locations sentence on the pricing page and terms §3; terms §4 mentions the
  portal Billing screen for cancelling; bump LEGAL_VERSION to `2026-10-05.2`,
  LEGAL_LAST_UPDATED stays "5 October 2026"; re-pin every changed page hash.
- `turbo.json` additions it needs: `STRIPE_AUTOMATIC_TAX` (F0 adds all env names).

### 5.4 Package B (usage, answer gate, fallback) — real
- `lib/billing/usage.ts`:
  `recordUsage(input: { locationClinicId: string; meter: "voice_minutes"|"chat_conversations"; quantity: number; source: "voice_call"|"meta"|"web_chat"; sourceRef: string; occurredAt: Date; actor: ActorContext }): Promise<{ recorded: boolean; used: number; included: number; overDelta: number; crossed: (80|100)[] } | { recorded: false; reason: "no_entitlements" | "duplicate" }>`
  — resolves the billing clinic, rolls the annual window first (`rollAllowancePeriod`,
  billing note "allowance_rolled" if it rolled), inserts the usage_events row ON
  CONFLICT DO NOTHING, single-statement counter increment with RETURNING, computes
  `overDelta = max(0, after - pooledIncluded) - max(0, before - pooledIncluded)` where
  `pooledIncluded = included_x * locations`, stores `over_allowance`, returns crossings of
  80% and 100%. A missing entitlements row is normal (synthetic/dev): return
  `{recorded:false, reason:"no_entitlements"}` and do not throw.
  `usageSnapshot(row: Entitlements): { voice: Meter; chat: Meter }` (pure).
- `lib/billing/answering.ts`: pure `decideAnswer(facts)` and
  `assistantMayAnswer(tx: TenantTx, input: { channel: "voice"|"web_chat"|"messenger"|"instagram"|"whatsapp"; startsNew: boolean; now?: Date }): Promise<{ ok: true } | { ok: false; reason: "unpaid"|"suspended"|"paused"|"canceled"|"ai_paused"|"allowance_cap"|"meta_disabled"; fallback: "direct_line"|"contact_form"|"silent"; directLine: string | null }>`
  (D11; reads clinic_settings of the location, entitlements of the billing clinic via
  `withBillingTenant` or the resolved id).
- `lib/chat/threads.ts`: `touchChatThread(tx, { channel, partyId, sentAt }): Promise<{ conversationId: string; startsNew: boolean }>`
  (party_ref = sha256 hex of `${channel}:${partyId}`; uses `CHAT_CONVERSATION_SILENCE_MS`;
  `last_inbound_at = GREATEST(old, sentAt)`).
- Meta: `lib/meta/webhook.ts` adds `messageId` (Messenger/Instagram `message.mid`,
  WhatsApp `messages[].id`); `app/api/webhooks/meta/route.ts`: per message (1) dedupe in
  its own short tenant tx via `meta_inbound_messages` (duplicate -> skip entirely),
  (2) touch the chat thread, (3) `assistantMayAnswer(startsNew)` — refused -> no model
  call, no reply, audit `meta_front_door_reply` with `source: "withheld"`, `reason`,
  (4) if allowed and startsNew -> `recordUsage(chat_conversations, 1, source "meta",
  sourceRef = sha256(conversationId))`, (5) existing answering. Fix the crash: the
  catch block logs `platform` which is not an allowed key — use `channel`/allowed keys.
  Keep `!owner` skip; replace `!owner.enabled` with the gate (`meta_disabled`).
- Voice (Synthflow, pre-Retell): `synthflow-payload.ts` reads documented `duration`
  (seconds) into `durationSeconds`; `ingest.ts` stores it (`conversations` has no
  duration column — store minutes on the usage event only; do NOT add a column) and
  after the conversations insert (non-duplicate) calls `recordUsage(voice_minutes,
  billableVoiceMinutes(d), source "voice_call", sourceRef = sha256(externalCallId))`
  only when `assistantMayAnswer(voice, startsNew:true)` was ok at ingest time (a call
  answered while the clinic was suspended is not billed). `tools.ts`: gate at the top of
  `handleVoiceTool` for every tool; `context` reply gains
  `answer_mode: "assistant" | "pass_through"` and `transfer_number: string | null`;
  `slots`/`book` refuse with 403 `{ error: "service_unavailable" }` when refused.
  Export `voiceAnswerDecision(clinicId, now?)` for the future Retell endpoint, with a
  comment describing how Retell will use it (call_inbound / transfer_number).
- Jobs (replace F0 stubs): `usage-report.ts` (for each billing clinic on a monthly plan
  with a Stripe customer: call `reconcileMeteredItems` when
  `metered_price_keys` differ from `expectedMeteredKeys`; then send
  `billing.meterEvents.create({ event_name: METERS[m].eventName, payload: { stripe_customer_id, value: String(over_allowance) }, identifier: "hd_" + usage_event.id, timestamp })`
  for unreported rows with `over_allowance > 0` and `occurred_at > now - 34 days`; mark
  reported; record attempts/errors; never inside a tx);
  `annual-overage.ts` (annual plans: for each closed allowance window not yet in
  `overage_invoices`, sum `over_allowance` by meter from usage_events of that window,
  create invoice items + a charge_automatically invoice (auto_advance, finalize) with a
  generic description "Voice minutes over allowance, <Mon YYYY>: N × $0.80", idempotency
  key `hd-annual-overage:<clinic>:<windowStart>`, record status; zero units -> 'skipped');
  `usage-alerts.ts` (for billing clinics with usage_alerts_enabled: compute per meter
  used/pooledIncluded; at >= 80% enqueue `usage_80`, at >= 100% `usage_100`, dedupe key
  `${meter}:${windowStartIso}`).
- Direct line becomes a go-live precondition in `lib/onboarding/go-live.ts`.

### 5.5 Package C (billing lifecycle, notices, Stripe actions, setup script) — real
- `lib/billing/events.ts`: (a) remove the dead checkout branch; add a `never` default to
  `dispatch` (F15); (b) `invoice.paid`: record `first_paid_at` (first invoice),
  `paid_through` (latest licensed line period end), `last_paid_invoice_id`, clear
  `open_invoice_*`; when the clinic was suspended -> transition active + enqueue
  `restored`; (c) `invoice.payment_failed`: ignore when the invoice id equals
  `last_paid_invoice_id` or the payload status is `paid` (F3); store `open_invoice_id`
  and `open_invoice_url` (`hosted_invoice_url`); enqueue `payment_failed` (dedupe on
  invoice id — once per invoice, not per retry) with `{ amountDueCents, hostedInvoiceUrl, graceEndsAt }`;
  (d) `invoice.payment_action_required`: enqueue `payment_action_required` (dedupe invoice id);
  (e) `customer.subscription.updated`: snapshot `metered_price_keys` (metered items'
  price lookup keys) and `locations` (package item quantity) — a quantity change updates
  pooled allowances; read `cancel_at` as well as `cancel_at_period_end` (F7) and store it;
  enqueue `cancel_scheduled` / `cancel_reversed` / `plan_changed`;
  (f) `customer.subscription.deleted`: enqueue `canceled` (with the 30-day pass-through
  promise from `POLICY.forwardingPassThroughDays` — define it in the catalog if needed);
  (g) suspension from `unpaid`/dispute enqueues `suspended` with the open invoice URL.
- `lib/billing/entitlements.ts`: writers for every new column; `applyPlanChange` takes
  `locations`; allowances stay per-location numbers (pooling is computed at use).
- `lib/scheduler/billing-sweep.ts`: enqueue `grace_ending` 24 h before grace ends;
  suspend also from canceling/paused when an unpaid invoice is overdue
  (the email-jobs map §11 gap) — only via allowed edges; enqueue `suspended`.
- `lib/scheduler/annual-renewal-reminder.ts`: use `paid_through` (not the allowance
  window, F2) and enqueue `renewal_upcoming` instead of sending to report_recipients.
- `lib/billing/notices.ts` sender (replace F0 stub) + `lib/email/billing-notice.ts`
  renderers for every kind (§7). Immediate best-effort send after a processed event in
  `app/api/billing/events/route.ts` (bounded, never changes the response).
- `lib/billing/metered-items.ts` `reconcileMeteredItems` (replace stub).
- `lib/billing/stripe-actions.ts`:
  `changePlan(input: { clinicId; planId; interval; requestId: string; actorLabel: string }): Promise<{ status: "changed" } | { status: "refused"; message: string }>`
  (owner only — caller checks; swap package price at the same quantity, delete metered
  items not expected, add missing ones (monthly only), setup-fee delta × locations via
  `add_invoice_items` `price_data` on the new package product, `proration_behavior: "always_invoice"`,
  `payment_behavior: "error_if_incomplete"`, idempotency key `hd-plan:<clinic>:<requestId>`);
  `addLocation(input: { clinicId; requestId; actorLabel; locationName?: string }): Promise<{ status: "added"; clinicSlug: string } | { status: "refused"; message }>`
  (quantity + 1, `add_invoice_items: [{ price: <setup price id> }]`, always_invoice,
  error_if_incomplete, idempotency key `hd-location:<clinic>:<n>`, then
  `provisionLocation`, then set `entitlements.locations`);
  `setAutoRenew(clinicId, on: boolean, actorLabel)`;
  `createPortalSession(input: { clinicId; audience: "owner" | "billing"; returnUrl: string; flow?: "payment_method_update" | "subscription_cancel" }): Promise<{ url: string }>`
  (finds the API-created configuration by `metadata.app === "healdesk"` and
  `metadata.audience`, cached per process);
  `previewRefund(clinicId, kind: "setup_fee" | "first_period" | "guarantee")` and
  `commitRefund(clinicId, kind, { confirmAmountCents, reason, actorLabel })` (find the
  first invoice via the subscription, payment intent via `invoicePayments.list`, amount
  net of discounts, idempotency `hd-refund:<kind>:<clinic>`, stamp entitlements columns,
  billing note, audit). Eligibility facts: setup_fee — no channel live
  (`clinics.went_live_at` null) and `first_paid_at` older than 30 days; first_period —
  within 14 days of `first_paid_at`; guarantee — operator judgement with a reason.
- `lib/billing/locations.ts` `provisionLocation(tx-free input: { billingClinicId; name?; actor })`
  (new clinic in the same organization, `billing_clinic_id`, copied specialty/timezone/
  booking provider/call routing/plan/covered-entity flag, synthetic, seeded agent config
  and clinic_settings defaults, owner/admin/billing memberships copied, security event
  `location_added`; no entitlements row).
- `apps/web/scripts/stripe-setup.ts`: create/verify the two billing portal configurations
  (owner: invoice_history, payment_method_update, subscription_cancel at_period_end with
  cancellation_reason; subscription_update DISABLED; pause disabled; billing: invoice
  history + payment method only; business_profile headline "healdesk billing",
  privacy/terms URLs from NEXT_PUBLIC_SITE_URL; metadata app/audience); idempotent by
  metadata, updates a drifted configuration; dry-run prints them; update `printNext`
  (nine platform events incl. checkout.session.expired, the Connect endpoint on apps/app
  with its events, Connect OAuth settings and redirect URI, no manual portal steps).

### 5.6 Package D (deposits and Connect) — real
- `lib/billing/deposits.ts`: `getDepositSettings(tx)` (from clinic_settings),
  `setDepositSettings(tx, input, actorLabel)` (refuses `deposits_enabled` without a
  connected account), pure `depositDecision(facts)` with R0-R4 from the ops-deposits map §8.2;
  precedence (spec rows 180-182 vs 594-597): when the channel cannot collect, its
  "book without a deposit" toggle decides first (On -> book and flag); only when it is
  Off does `deposit_uncollectable` apply (book_and_flag | hold_and_alert |
  decline_and_alert). Document this in code and in the final report.
- Per-service deposits: add optional `depositUsd: number | null` to `AgentService`
  (schema type + `validateAgentConfig` 0..10000); amount = service deposit ?? clinic
  `deposit_policy.amountUsd`. `DepositPolicy.collection` becomes ignored (keep the field
  for old rows; document).
- `lib/billing/deposit-link.ts` `createDepositLink(clinicId, appointmentId, { channel, now?, stripe? })`
  exactly as the ops-deposits map §9 (opaque `deposit_payments.id` ref, "Appointment deposit"
  generic product, `statement_descriptor_suffix: "DEPOSIT"`, `assertNoTreatmentName` on
  every string against the clinic's service names, expires_at = hold minutes, card only,
  no after_expiration, idempotency key `hd-deposit:<ref>`, never inside a tx,
  idempotent re-use of an open session). Fixed patient-facing text builder
  `depositLinkText(url)` for future chat adapters (no treatment name).
- `app/api/webhooks/stripe-connect/route.ts` + `lib/billing/connect-events.ts`: verify
  with `STRIPE_CONNECT_WEBHOOK_SECRET`, require `event.account`, dedupe in
  `stripe_connect_events` (no payload), retry/dead-letter semantics like billing_events,
  resolve clinics with `app_clinics_for_stripe_account`, handle
  checkout.session.completed (paid only when payment_status "paid"),
  checkout.session.async_payment_succeeded/_failed, checkout.session.expired,
  account.application.deauthorized, account.updated (store charges_enabled? only if a
  column exists — it does not; skip). Mark paid with conditional UPDATE
  (status 'open'), verify account/amount/currency, appointment `deposit_status 'paid'`.
  Expired -> per decision (pending_front_desk + staff alert through the existing desk
  notification pattern, phiClass none, link only).
- Connect OAuth hardening (`lib/billing/connect.ts`, `app/api/connect/stripe/**`):
  single-use state rows in `stripe_connect_states` (hash only), TTL 15 min, bound to the
  portal user when started from the portal; `/api/connect/stripe/start?clinic=<slug>`
  route for the portal (session + capability `deposits.manage`), the operator path keeps
  minting from the ops console (return_to 'ops'); refuse to overwrite a DIFFERENT stored
  account (`already_connected`); same account is idempotent; check `livemode` against the
  key mode; callback redirects to `/c/<slug>/behaviour?connect=ok|declined|failed` for
  portal states and to a neutral `/connect/stripe/done` page for operator states (never
  `/admin`); `disconnectStripeConnect(clinicId, actorLabel)` (expire open deposit
  sessions, `oauth.deauthorize`, null the account, stamp disconnected_at, deposits off,
  pending_link -> pending_front_desk, enqueue notice `connect_disconnected`); fix the
  stale SMS/10DLC comments.
- Voice book tool (`lib/voice/tools.ts` `bookInTenant` and `depositLine` ONLY — package B
  owns the top of `handleVoiceTool` and the context reply shape): apply
  `depositDecision` (voice never collects); `insertAppointment` stays pending_front_desk;
  `notifyDesk`/alerts read the appointment's status.
- `app/deposit/thanks` and `app/deposit/cancelled` pages: generic, no data loaded.

### 5.7 Package E (portal screens + ops console; runs after A1-D are merged)
- Portal `app/(portal)/c/[clinicSlug]/billing/**`: plan, channels, locations, renewal
  date (`paid_through`), next invoice amount (Stripe `invoices.createPreview` — degrade
  gracefully), usage meters (used / pooled included, overage $ this cycle from
  usage_events × rate), days left in cycle; switches (owner): overage mode, usage
  alerts, auto-renew; actions (owner): change plan (with the setup-fee delta and price
  shown before confirming), add a location (price + setup fee shown), open Stripe portal
  (payment method/invoices; cancel flow); billing contact management (owner adds/removes
  an email -> user + `billing` grant + `invite` link email; never shows other users'
  data beyond emails). Billing contact role sees read-only billing + "Manage payment
  method and invoices" only.
- Portal `app/(portal)/c/[clinicSlug]/behaviour/**`: deposit switches + per-channel
  wording from the spec, Stripe Connect connect/disconnect, direct line, Pause AI
  (owner/manager).
- Ops (apps/app `lib/ops/api.ts` + apps/web `ops-client.ts` + console): billing panel
  per clinic (`getClinicBilling` read: entitlements projection, usage snapshot, recent
  transitions, notices, overage invoices, attention billing events — never payloads;
  writes: `setOverageMode`, `setUsageAlerts`, `replayBillingEvent`, `previewRefund`,
  `commitRefund`, `setClinicSettings` (direct line, Pause AI), `setDepositSettings`,
  `disconnectStripeConnect`, `sendNoticesNow`); fix F1 (`note` audit key in
  setConnectionPhiBasis), F2 (greeting read with `text()` truncates to 400), F3
  (`&rsquo;`), F12 (refused() wording on 500).

---------------------------------------------------------------------------------------
## 6. Portal capabilities

| capability | owner | admin (manager) | billing (billing contact) |
| --- | --- | --- | --- |
| home.view | yes | yes | yes |
| billing.view | yes | no | yes |
| billing.manage (switches, plan, locations, cancel, contacts) | yes | no | no |
| billing.payment (Stripe portal: payment method + invoices) | yes | no | yes |
| behaviour.view / behaviour.manage | yes | yes | no |
| deposits.manage (Connect, deposit switches) | yes | yes | no |
Other clinic_role values: no portal access (treated as not found).

## 7. Notice kinds: payloads and copy (all phiClass "none"; plain text, short html optional)
Recipients: `billingRecipients()` of the billing clinic. Subject lines carry no links.
- payment_failed `{ amountDueCents, hostedInvoiceUrl, graceEndsAt }` — "Your healdesk
  payment didn't go through": the amount, pay link, the assistant stays on until
  <grace end>, then calls pass straight to your direct line until paid.
- payment_action_required `{ hostedInvoiceUrl }` — your bank wants you to confirm.
- grace_ending `{ graceEndsAt, hostedInvoiceUrl }` — service pauses tomorrow.
- suspended `{ hostedInvoiceUrl | null }` — assistant paused; calls pass to your direct
  line; how to remove call forwarding if you prefer (generic: your carrier's
  "cancel forwarding" code, e.g. *73 or ##21# on many US carriers — say "contact your
  phone provider" if unsure); paying restores everything at once.
- restored `{}`; cancel_scheduled `{ endsAt }` (how to undo before then);
  cancel_reversed `{}`; canceled `{ passThroughDays }` (calls still pass to your line
  for N days; data export/destroy timeline per terms §7).
- renewal_upcoming `{ renewsOn, amountCents, planName }` (annual, 30 days).
- usage_80 / usage_100 `{ meter, used, included, windowEndsOn, overageMode, rateCents }`
  — words: "voice minutes" / "chat conversations"; 100% + keep-going says overage is
  billed at the provisional rate; 100% + stop-and-fall-back says new calls pass to your
  line and chat shows a contact form until the window resets.
- overage_invoiced `{ amountCents, windowLabel }`; plan_changed `{ planName, interval }`;
  location_added `{ locations }`; connect_disconnected `{}`.

## 8. Acceptance (each package's final report must list how each item is met)
- All apps/app, apps/web, catalog, connectors tests pass locally with the DB suites
  RUNNING (not skipped) against the package's own test database; typecheck clean for all
  four workspaces; no new console.*, no unallowed log keys, no PHI in audit metadata.
- New behaviour is covered by tests that fail without it.
- No edits outside the package's file ownership (shared exceptions are listed per package).
