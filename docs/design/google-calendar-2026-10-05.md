# Google Calendar and the calendar BAA: design record and seams (5 and 6 October 2026)

The owner confirmed the plan for the Google Calendar connection backend and the calendar-dependent
business associate agreement on 5 October 2026 and answered its eight questions the same day. On 6
October the owner settled the Google scopes and the first findings of the BAA's release audit, and
the funnel session agreed the portal contract. The plan and its addendum are not in the repo, so
this file restates what the other sessions build against: §2 to §4 and §7 for the funnel and
portal session, §6 for the Stripe session's packages and the runtime. §1 says what is built and
what remains, §8 lists the owner's decisions, and §9 what the sessions still have to settle.

`docs/v1-product-spec.md` wins over this file, and §6 of
`docs/design/funnel-portal-contracts-2026-10-06.md` is the funnel's side of §2. "Built" means in
the code on 7 October 2026. The plan's commit names, C0 to C20, are kept.

## 1. Built, and what remains

| Commit  | What                                                                                               | State                                          |
| ------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| C0r     | KMS and SES that hold in production (§5)                                                           | Built (6740037)                                |
| C1      | The Google adapter, OAuth helpers, watch probe and offline fake (`packages/connectors`)            | Built (c3acc82); the list changes before C8    |
| C2      | The catalog interface (§3) and the BAA 1.3.0 draft                                                 | Built (cc56c9d)                                |
| C3      | Signing takes the two calendar answers (§3)                                                        | Built (ad02b30)                                |
| C4, C16 | Checkout's manual-booking notice and its Google-account question                                   | Dropped (§7)                                   |
| C5      | This record                                                                                        | This file                                      |
| C6      | Migration A: elections, OAuth states, slot holds, Auto-confirm, `clinics.client_number`, providers | Built (3cca422); the funnel's M3 goes after it |
| C6b     | The KMS lock labels (§5)                                                                           | Built                                          |
| C7      | The agreement and calendar terms in effect, elections, the demo clinic                             | Built                                          |
| C8      | Connecting, choosing calendars, disconnecting, revoking (§2, §4)                                   | To build                                       |
| C9      | Booking mode and Auto-confirm (§2)                                                                 | To build                                       |
| C10     | The five-minute calendar watch                                                                     | To build; ships switched off                   |
| C11     | Privacy §11 and `/data-deletion` say what the code does                                            | To build                                       |
| C12     | Availability, the desk path, migration B, the harness parked; HRC-04 at each desk write (§4)       | To build                                       |
| C13     | The booking engine (§6); HRC-04 at each write (§4)                                                 | To build                                       |
| C14     | The harness wired to the engine, and the fixed lines                                               | To build                                       |
| C15     | Provisioning reads the signed acceptance                                                           | Built                                          |
| C17     | The console's cards; `setBookingMode` and `directBookingAllowed` removed                           | To build                                       |
| C18     | Elections and account changes from the portal                                                      | To build; `requirePortal` is on main           |
| C19     | Release 1.3.0 and `calendar-election/1.0.0`                                                        | When Claude's own audit finds no blocker       |
| C20     | Empty `BAA_RELEASE_OVERLAP`                                                                        | Once C19 is deployed                           |

- **1.3.0** is a draft at `BAA_TEMPLATES[1]` (`approvedByCounsel: false`), merged on main clause by
  clause as the owner chose (6dc50a7; `docs/counsel/agreement-changes.md` §12, the choices in
  §12.13). Nothing offers it, signing refuses it, and so does provisioning, whose approval gate
  judges the bound acceptance's own version by `isBaaVersionAcceptable` (C15). C19 adds a migration
  so that `app_baa_version_acceptable` accepts it, and decides whether `MIN_ACCEPTABLE_BAA_VERSION`
  rises. If it rises past 1.2.1, C19 leaves 1.2.1 out of `BAA_RELEASE_OVERLAP`: a buyer could sign
  it and then be refused at Pay, by the checkout intent's own check (`agreementMismatch`), and at
  go-live, and the go-live floor test fails while a listed version is below the floor. A 1.2.1
  purchase whose intent was checked before such a release and paid after it is refused at
  provisioning instead, after paying, and reaches ops as a refused provisioning.
- **One calendar per provider.** The 1.3.0 calendar clauses are to say "the calendar, or one
  calendar per provider, that Practice chooses" (6 October). `google-calendar-disclosure/1`, which
  nobody has seen yet, also speaks of one calendar, and needs the same change before C8 shows it.
- **"Owns" is Google's owner role**, which is not ownership (§4). The C19 audit checks the
  catalog's "calendar that account owns" (`WHICH_CALENDAR` in `calendar-terms.ts`, and the
  disclosure's first paragraph) against what the code checks.
- **Migration A** takes the next free number at commit time: on 7 October main ends at
  `0050_stripe_bcd`, and funnel branches already hold 0051s, `0051_agreement_kinds` among them.
  C7's `agreementInEffect` wraps `app_agreement_in_effect` (0048) and never redefines it.
- **No live booking yet.** The assistant books only where the location's terms allow writing, the
  connection is healthy, Auto-confirm is on and the owner has set the kill switch, and for no
  production clinic until the Retell process exists (launch plan 2.1).
- **Not in this build:** the Retell process; booking from web chat and Meta (Meta stays
  request-only); the spec's other option for a one-way booking system, writing to Google for staff
  to copy across (such a clinic runs manual booking); the assistant cancelling or moving a booking;
  reading back a clinic's edits to healdesk's events; RISC; gating go-live on calendar terms;
  removing the legacy direct-booking columns, which stay, inert.

## 2. The portal's calendar contract

To be built in C8 and C9, in `apps/app`, with no new `lib/` directory. The portal calls these on
app.healdesk.io; apps/web never does.

- **`startGoogleConnect({ clinicId, returnTo, disclosureVersion }) → { authUrl }`** (C8) runs in a
  server action, because it sets the HttpOnly cookie that binds the round trip through Google to
  the browser. It refuses a `disclosureVersion` that is not the current
  `GOOGLE_CALENDAR_DISCLOSURE.version` (setup step 3 and Settings → Calendar show the disclosure
  directly above an unticked box and the Google-branded button); a `returnTo` other than exactly
  `/c/<slug>/setup` or `/c/<slug>/settings` for the clinic's own slug, so it is never an open
  redirect; and, so that nobody is sent to Google for a grant that could not be stored, an
  unconfigured Google client, a deployment that cannot seal (`credentialSealingProblem()`, §5) or a
  missing public origin. It also refuses a location whose terms do not allow writing: `none` and
  `not_used` end `terms`, and `needs_election` needs an election first (C18 in the portal). The
  callback returns to `returnTo` with `?calendar=<outcome>`: `connected`, `declined`,
  `admin_blocked`, `failed`, `scopes`, `no_refresh`, `probe`, `mismatch`, `different_account`,
  `election_needed`, `account_in_use`, `already_connected`, `terms`, `disclosure` or
  `unavailable`.
- **Before C19 no real clinic can connect.** A clinic that signed 1.2.1, as every clinic does
  until C19, resolves to `needs_election`, and no election is possible until C19 releases
  `calendar-election/1.0.0`: draft terms count only for a demo clinic (plan §2.8). Until then
  setup step 3 is to show the funnel plan's "Bookings arrive as requests your team confirms."
  rather than the button.
- **`getCalendarConnection(clinicId)`** (C8): the status, the account and its kind, the calendar
  booked into, when it was last checked and since when it has been broken; C8 fixes the fields. The
  account's email address reaches the clinic only, never an ops projection, an audit row or a log.
- **`disconnect(clinicId)`** (C8) erases the token, releases live holds and, unless another live
  connection uses the account, revokes the grant at Google. The mode, being derived, turns to
  requests at once.
- **Who acted.** The connect flow and `disconnect` write audit rows
  (`calendar_disclosure_accepted` at the start, `calendar_connected` at the callback, the
  disconnect), and an audit row takes its actor from an `ActorContext`, which only the caller can
  build, from `requirePortal`'s `PortalContext.userId`. So `startGoogleConnect` and `disconnect`
  are to take the portal `actor`, as `setAutoConfirm` does, with the OAuth state row carrying it
  to the callback; otherwise C8 records a clinic user's connect or disconnect as the system. That
  changes the agreed signatures (§9, item 8).
- **`listCalendars(clinicId)`** (C8): the calendars on which the connected account has Google's
  owner role, which a calendar shared in from another account or domain can have too (§4), hidden
  ones left out, primary first; 100 or more is refused (`too_many_calendars`) rather than shown
  incomplete. Names are the clinic's own words, shown to it and never audited or logged. With more
  than one, the portal's picker defaults to primary, and a choice re-runs the connect-time check
  and audits `calendar_target_changed` without the name. A covered clinic's choice is narrower
  (§4).
- **Named providers** (C8, C9): `listProviderCalendars`, `saveProviders` (each calendar checked as
  the shared one is, §4) and `setProviderServices`, for setup step 3.2 and Settings → Calendar. The
  switch is the funnel's `clinic_settings.booking_detail`, `generic` (the default) or
  `named_provider`, added in its M3.
- **`effectiveBookingMode(clinicId) → { mode: "direct" | "requests", reason, reasons }`** (C9) is
  `bookingModeFor`'s `live` or `manual`. `reasons` holds every gate that applies, each a code and a
  sentence; `reason` is the one the "Right now: …" line shows. The plan's codes: `kill_switch_off`,
  `auto_confirm_off`, `no_agreement`, `needs_election`, `manual_booking_system`,
  `google_not_configured`, `calendar_not_connected`, `calendar_broken`, `calendar_degraded`,
  `calendar_account_mismatch`, `calendar_disclosure_outdated`, `opening_hours_unknown`,
  `timezone_unconfirmed`, `offboarding`, `not_production`, `agent_not_approved`.
- **`setAutoConfirm(clinicId, on, actor)`** (C9) goes through `updateClinicSettings`, stamps who
  changed it and when, and audits `{ autoConfirm }`; the portal calls it behind step-up, and ops
  `setAutoConfirm` calls it too. `clinic_settings.auto_confirm_bookings` defaults to on, as does a
  clinic with no settings row; off makes every booking the assistant takes a request.
- **The kill switch is the owner's.** Unless `HEALDESK_DIRECT_BOOKING_ENABLED` is the literal
  `true`, the assistant books nothing itself. No commit, script, CI file, Dockerfile, `.env.example`
  value or deploy step sets it, and it never stops staff confirmations writing to Google.
- **Clinic emails about the calendar** go through
  `notifyCalendarState(tx, clinicId, "stopped" | "reconnected", { dedupeKey })`
  (`apps/app/src/lib/notices/calendar-state.ts`, on main), which never throws and sends nothing
  until the funnel's M3 makes it queue O13 in the caller's transaction; from `withTenant()`, pass
  `tx.db`. The watch sends `stopped` in the transaction that claims `broken_alerted_at` (C10), a
  reconnect after setup sends `reconnected` (C8), and a connect during setup sends nothing. The
  plan's own clinic emails for these are dropped.
- **Ops alerts** go through `notifyOps(event, fields)` (`apps/app/src/lib/ops/notify.ts`, on main:
  a log line, an `ops_alerts` row deduplicated within the hour and the I1 email; it never throws).
  This build adds its events to the closed `OPS_EVENTS` list (for example `calendar_broken`,
  `calendar_degraded`, `calendar_recovered`, `calendar_watch_incomplete`,
  `google_oauth_client_rejected`) in place of the plan's ops email, with ids and counts under
  `ALLOWED_LOG_KEYS` as fields. Security events stay as planned.
- **Closures.** Availability (C12) leaves out every local date the clinic is closed, read with
  `closedOn(tx, clinicId, localDate)` (`apps/app/src/lib/clinic/closures.ts`, on main) in the
  transaction that reads its other facts. Weekly hours stay in `clinics.opening_hours`; nothing
  depends on an opening date.
- **One address, one sign-in.** `calendarRecipients()` and `ownerRecipients()` both resolve to the
  clinic's one email address. Provisioning makes its one membership active with role `owner`, which
  C6's guard requires of a widening election made in the portal; `requirePortal(slug)` checks
  membership only. Nothing here writes `clinic_channels`.
- **No Behaviour screen:** every route this build would send to `/c/<slug>/behaviour` goes to
  `/c/<slug>/settings`.

## 3. What the funnel imports from `packages/catalog` (C2, built)

One module owns each name, and `packages/catalog/src/index.ts` exports them all.

**`booking-systems.ts`** answers "Where do bookings live today?", apart from the phase-two
`platforms` list: `BookingSystemId`, `BookingSystem`, `BOOKING_SYSTEMS`, `getBookingSystem`,
`isBookingSystemId`, `bookingSyncFor`, `bookingSystemName` and `manualBookingNotice(label)`. Each
entry is `{ id, label, readsGoogleCalendar, setupNote, setupHelpUrl, phaseTwoPlatformId }`, where
`setupHelpUrl`, for HighLevel's help page, is the one field beyond the agreed shape. In order:

| id                | Label                 | Reads Google Calendar                                                        | Booking |
| ----------------- | --------------------- | ---------------------------------------------------------------------------- | ------- |
| `google_calendar` | Google Calendar only  | Yes                                                                          | Live    |
| `calendly`        | Calendly              | Yes                                                                          | Live    |
| `calcom`          | Cal.com               | Yes                                                                          | Live    |
| `gohighlevel`     | HighLevel             | Yes, once the clinic sets that calendar as a conflict calendar (`setupNote`) | Live    |
| `mindbody`        | Mindbody              | No                                                                           | Manual  |
| `boulevard`       | Boulevard             | Unverified                                                                   | Manual  |
| `other`           | Something else        | Unverified                                                                   | Manual  |
| `none`            | No booking system yet | Yes                                                                          | Live    |

`bookingSyncFor(id)` is `live` only for "yes"; an unknown id is `manual`. Zenoti, PatientNow,
Acuity and Vagaro are only in `platforms`, unverified: a clinic on one answers "Something else".

**`calendar-terms.ts`**: `CalendarAccount` (`workspace_baa`, `workspace_no_baa`, `personal`),
`CALENDAR_ACCOUNTS`, `isCalendarAccount`, `CALENDAR_ACCOUNT_OPTIONS` ("Which Google account will
bookings go into?" in plain words), `CalendarTermsKind` (`covered`, `uncovered`, `not_used`),
`calendarTermsKind(sync, account)`, `CALENDAR_CLAUSE_IDS`,
`calendarClauseBody({ kind, account, connectedPlatform })`, `CALENDAR_LOCATION_PARAGRAPH`,
`electionWidens(previous, next)` and `selectCalendarClause({ bookingSystem, calendarAccount })`,
which returns `{ kind, clauseId, body }` without the BAA's location paragraph and is how the
funnel's DPA picks its calendar clause. The election document, which takes the booking system, is
here too: `CALENDAR_ELECTIONS` (`calendar-election/1.0.0`, unreleased), `currentCalendarElection`,
`getCalendarElection`, `renderCalendarElection`, `hashCalendarElection` and
`prepareCalendarElection`.

**`google-calendar-disclosure.ts`**: `GOOGLE_CALENDAR_DISCLOSURE` (`google-calendar-disclosure/1`,
which names the calendar list among what healdesk reads),
`renderGoogleCalendarDisclosure({ clinicName })`, `GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE` and
`googleCalendarDisclosureSha256()`. A new recipient of calendar-derived times means a new version,
left off the compatible list, so every connection is asked to reconnect.

**`subprocessor-notice.ts`**: `SUBPROCESSOR_NOTICE_HOURS = 24`, `SUBPROCESSOR_NOTICE_HEADING` and
`subprocessorNoticeClauseBody()`, used by 1.3.0's subcontractors clause and the funnel's DPA; 1.2.1
keeps its fifteen days.

**`baa-selections.ts`**: `buildBaaSelections()` takes `specialtyId`, `attributionMode`,
`bookingSystem`, an optional `platformId`, `isCoveredEntity`, `calendarAccount` and `template`, and
is the one builder both renders call: `signAgreement` since C3, the funnel's agreement step from
M2. Before 1.3.0 a template names the phase-two platform, `platformId` first, byte for byte as
before; 1.3.0 names the booking system and carries both answers. The sync is derived, never chosen,
so nobody can sign live booking for a one-way system.

**`baa.ts`** adds `templateReadsCalendarAccount`, `CALENDAR_CLAUSE_IDS_1_3`, `calendarAccountOf`,
`bookingSyncOf` and `BAA_RELEASE_OVERLAP`, empty until C19; **`agreement-kind.ts`**, the funnel's,
has `agreementKindFor`, which signing asks through `agreementKindForRequest`.

**Signing (C3).** `SignAgreementRequest` gains `bookingSystem` and `calendarAccount`, and
`platform` becomes optional. A template that reads the answers needs both, with a 422 naming the
one missing, and a `platform` sent with them must be that system's own phase-two platform, or
`none` for a system that has none (`google_calendar`, `calendly`, `other`, `none`). Unknown values
are refused for every version. An earlier template needs a platform or a booking system, and names
the platform when both come. The acceptance keeps `platformId`, `bookingSystem` and
`calendarAccount` as sent, outside the hash. `signableTemplate` accepts the current template, or a
released one listed in `BAA_RELEASE_OVERLAP` until its deadline. A veterinary practice gets a 422
naming `specialty`, as the endpoint signs BAAs only and the DPA is unreleased; main's checkout
still lists every specialty, so the funnel is to hide it (`specialtyOffered`). Provisioning (C15)
stores the signed booking system in `clinics.booking_provider`.

## 4. Google access

The constants and the adapter are built (C1); the connect flow that applies them is C8.

- **Five scopes, in this order** (`GOOGLE_SCOPES`; owner, 6 October): `openid`,
  `https://www.googleapis.com/auth/userinfo.email`,
  `https://www.googleapis.com/auth/calendar.calendarlist.readonly`,
  `https://www.googleapis.com/auth/calendar.events.freebusy` and
  `https://www.googleapis.com/auth/calendar.events.owned`. The three calendar scopes are
  `REQUIRED_CALENDAR_SCOPES`: a sign-in without one ends `scopes`, and a refresh that loses one is
  `scope_lost`, on which the stored token is to be erased. The email scope may be refused, and the
  account then shows as "a Google account". These replace the plan's four scopes and its
  primary-only target, in the Google verification submission too.
- **The calendar booked into.** One Google account per location, live on one clinic at a time. The
  calendar is one on which that account has Google's owner role, stored as `metadata.calendarId`:
  `primary` by default and when it is the only one, otherwise the clinic's choice. Free/busy, event
  inserts and reads, the connect-time check (which requires the owner role) and the watch's probe
  all use it. The owner role is not ownership. Google's calendar list says "the owner role is
  different from the calendar's data owner": a calendar has one data owner and may have several
  users with the owner role, so a calendar another account or domain shares in with "make changes
  and manage sharing" is listed as owner too.
- **Named providers are in v1**, as the spec's "Provider-specific" booking. With `booking_detail`
  set to `named_provider` and an active provider mapped to the service, availability, holds and
  writes (C12, C13) use that provider's calendar, otherwise the shared one, and holds and the
  overlap guard key on the clinic and the calendar. Each provider's calendar is one on which the
  location's account has the owner role, and passes the same checks, HRC-04's included. "The
  person they saw last time" is a provider the patient names, never one looked up beyond the
  clinic's own records.
- **A covered clinic stays in its own domain** (owner, 6 October, HRC-04). Under `workspace_baa`
  terms only the primary calendar, or a secondary one shown to belong to the connected account's
  own Workspace organisation, may be chosen, as the shared calendar or a provider's. C8 checks it
  when a calendar is chosen and stores what it verified, and C12's `writeToCalendar` (with the
  write guard) and C13's writer re-check it before every insert. Nothing checks it yet: C1's
  `CALENDAR_LIST_QUERY` filters only by `minAccessRole=owner`, and `verify()` refuses only a
  calendar without the owner role (`docs/counsel/agreement-changes.md` §12.11, item 7). Before C8,
  C1's list asks `showOwnOrganizationOnly=true` for a managed account, or adds `dataOwner` to its
  fields (Google sets it only for secondary calendars); until then, covered terms book only into
  the primary calendar.
- **Unverified at Google** until the sandbox checks on a spare Workspace (plan §1.3 and risk 7):
  whether `events.owned` writes to `primary`, and to an owner-role calendar that another account
  data-owns; whether Google accepts PKCE from a confidential client; what an insert with a deleted
  event's id does; whether `hd` comes with and without the email scope; and how long a revoked
  access token keeps working.
- **What is stored:** the sealed refresh token, never an access token; the Google `sub` only as
  `account_ref = sha256hex("google:" + sub)`, which keeps one live connection per account across
  clinics; the account's email address in the connection's metadata, for the clinic only.
- **The OAuth client** (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`) is set only in the
  AWS BAA host's secret store for apps/app: never on apps/web or any Vercel project.

## 5. Keys

**One KMS key for everything** (owner, 5 October), which C0r enforces: `HEALDESK_KMS_KEY_ID` must
be the full ARN of a single-region us-east-1 key, and an alias, a bare key id, another region's key
or an `AWS_REGION` naming another region is refused without echoing the value. The KMS client
connects within 2 s, gives each request 5 s with `throwOnRequestTimeout` and tries twice; SES gains
`throwOnRequestTimeout`. `credentialSealingProblem()` tells the connect flow whether it can seal.
`selfCheckCredentialKey()` seals and opens a throwaway value within 8 s and never throws; it runs at
worker start and behind the read-only ops operation `getCredentialKeyStatus`, which no /admin card
shows yet.

**Lock labels** (owner, 5 October; built in C6b):

- Migration A adds `clinics.client_number`: unique, numbered in creation order and then from a
  sequence, so a customer's second location takes the next number. The trigger
  `clinics_client_number_fixed` refuses any change for every role (42501), and `healdesk_app` has no
  UPDATE grant on the column. `healdesk_app` keeps 0003's table-level UPDATE on
  `provider_connections`, so there the guard is the trigger `provider_connections_identity_fixed`
  (migration A), which refuses any change of `id`, `clinic_id` or `provider` for every role (42501):
  a changed provider would leave every envelope sealed under the old label unopenable. The database
  audit asserts both (`apps/app/tests/database-audit.test.ts`).
- The AWS KMS wrapper sends
  `EncryptionContext: { "healdesk:clinic": "<clinic label>", "healdesk:login": "<kind>" }` on
  GenerateDataKey, Decrypt and Encrypt (the rewrap). `seal()`, `open()` and `rewrap()` in
  `lib/crypto/envelope.ts` each take the label as an argument, and all four callers pass one,
  derived from values that cannot change, when sealing and again at every open; the envelope never
  stores it, since a label that travelled with a row would travel with a copied row too. The fixed
  labels are `FIXED_LOCK_LABELS` in `lib/crypto/kms.ts`, and `healdesk:clinic` takes nothing but a
  client number or one of the two planes those labels use, `ops` and `users`:

| Sealer                                                                         | `healdesk:clinic`                            | `healdesk:login`                                            |
| ------------------------------------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------- |
| A `provider_connections` row (`lib/connections/store.ts`)                      | The clinic's `client_number`, read each time | The row's `provider`: `google_calendar`, `meta-whatsapp`, … |
| The operator's TOTP secret (`lib/ops/admin-totp.ts`)                           | `ops`                                        | `admin-code`                                                |
| A portal user's authenticator-app secret (`lib/factors/totp.ts`, the funnel's) | `users` (§9, item 3)                         | `user-totp`                                                 |
| The key self-check, `selfCheckCredentialKey()`                                 | `ops`                                        | `self-check`                                                |

- A labelled envelope carries `aad_version = 2`, and only such an envelope is opened with a
  context. The version is inside the AAD, so editing it cannot skip the label: a version-2 envelope
  marked 1 asks KMS without the context and is refused. `open()` and `rewrap()` read the version
  once and refuse a missing one, or any value but 1 or 2, before the key is asked anything, so
  whether the label is used and which AAD the payload carries are decided from the same number. A
  version-1 envelope opens without a context: always under `LocalKeyWrapper`, and on AWS only until
  the infra rule below is applied. Its label is still checked for shape, but a whole label of the
  wrong clinic or login goes unnoticed there, since a version-1 envelope relies on its AAD alone.
  `rewrap()` keeps the label, and refuses a version-1 envelope rather than wrap its key again
  without one. `LocalKeyWrapper` binds the label into its AES-GCM AAD, so tests catch a mismatch.
  Both wrappers refuse to wrap a data key without both keys, or to unwrap one under a label missing
  either; only an explicit `null`, which `open()` passes for a version-1 envelope alone, unwraps
  without a label. So a sealer added later without a label fails a test rather than production
  (`apps/app/tests/lock-labels.test.ts`, and each sealer's own suite).
- **Infra rule, for the AWS build.** The task role's KMS permission on the one key is two
  statements in its IAM policy, and the key policy gives the task role nothing of its own.

  1. The application's own calls: `kms:GenerateDataKey`, `kms:Decrypt` and `kms:Encrypt`, only when
     no AWS service is making the call and the encryption context carries both lock-label keys and
     no other:

     ```json
     {
       "Effect": "Allow",
       "Action": ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt"],
       "Resource": "arn:aws:kms:us-east-1:<account>:key/<key id>",
       "Condition": {
         "Null": {
           "kms:EncryptionContext:healdesk:clinic": "false",
           "kms:EncryptionContext:healdesk:login": "false",
           "kms:ViaService": "true"
         },
         "ForAllValues:StringEquals": {
           "kms:EncryptionContextKeys": ["healdesk:clinic", "healdesk:login"]
         }
       }
     }
     ```

     The two `Null` `"false"` conditions are what require the label. `ForAllValues` on
     `kms:EncryptionContextKeys` alone also holds for a request with no context at all (IAM
     documents this of `ForAllValues`), so it only adds that no other key is sent. `Null` `"true"`
     on `kms:ViaService` keeps the statement to calls the application makes itself.

  2. S3's calls for the transcript bucket. The bucket is SSE-KMS under the same key
     (`docs/policies/aws-hipaa-account.md`), and S3 asks KMS with the task role's own permissions
     (GenerateDataKey for an upload, Decrypt for a download) and the context
     `{ "aws:s3:arn": … }`, which carries neither label key and another key besides. The first
     statement refuses that, so without this one every transcript upload and download fails:

     ```json
     {
       "Effect": "Allow",
       "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
       "Resource": "arn:aws:kms:us-east-1:<account>:key/<key id>",
       "Condition": {
         "StringEquals": { "kms:ViaService": "s3.us-east-1.amazonaws.com" },
         "StringLike": { "kms:EncryptionContext:aws:s3:arn": "arn:aws:s3:::<transcript bucket>/*" }
       }
     }
     ```

     With S3 Bucket Keys on, S3 sends the bucket's ARN rather than the object's, and the condition
     names `arn:aws:s3:::<transcript bucket>` instead. No call the application makes itself
     carries `kms:ViaService`, so this statement serves none of them: every direct call still needs
     the label.

  The key policy delegates to IAM through the account's own statement
  (`"Principal": { "AWS": "arn:aws:iam::<account>:root" }`) and names the task role in no
  statement of its own. KMS allows a call that either the key policy or an IAM policy allows, so a
  key-policy statement naming the role without these conditions, such as the console's default "key
  users" statement, would let every call through and leave both statements moot; any that has to
  name the role carries the same conditions. The rule binds the task role only: RDS, CloudTrail and
  CloudWatch Logs use the key under their own principals (the grant RDS creates with the instance,
  and the service principals in the key policy), so it does not touch them.

  Since C6b every sealer above sends both keys, so the rule can go on with the role itself; until it
  does, KMS would serve a call without them. Once it is on, KMS also refuses the unlabelled Decrypt
  a version-1 envelope needs, so any such envelope on AWS is to be sealed again first. If the owner
  wants no S3 exception at all, S3 needs a key of its own, which reopens "one key for everything".

## 6. Seams with the Stripe packages and the runtime

The owner let this build take (5 October, Q1) the voice booking path in `lib/voice/tools.ts` below
B's gate (`bookInTenant` goes, `depositLine` stays), `insertAppointment`, `notifyDesk`,
`decideBookingRequest`, `lib/provisioning.ts`, `app/api/provision/route.ts` and the console's
booking and calendar cards. B, C and D are built on `stripe/bcd`, and since 7 October so is E's
ops billing panel, which contracts §1 makes C's. None of it is on main yet, which has only their
shared ground and stubs (14e11f8). Whichever lands second rebases onto the other along these
lines.

- **B, the answer gate**, owns the top of `handleVoiceTool` and the context reply's `answer_mode`
  and `transfer_number`, which this build leaves alone. The gate is
  `assistantMayAnswer({ clinicId, channel, usage?, now?, actor })`, or
  `voiceAnswerDecision(clinicId, now?)` for a call (`apps/app/src/lib/billing/answering.ts`; main's
  stub answers everything), and runs outside any transaction. On `stripe/bcd` the top of
  `handleVoiceTool` asks it for `context` and `slots`, and `voiceToolSlots` refuses times on its
  answer; `book` skips it there, and `voiceToolBook` asks it only after `priorOutcome` has replayed
  an earlier outcome (R25). C12 deletes both functions, so C12's parked routes and C14's
  demo-engine routes call `voiceAnswerDecision` in the same order: before any time is offered, and
  for a booking after the replay (§9, item 13).
- **D, deposits.** `depositDecision(facts)` (`apps/app/src/lib/billing/deposits.ts`, on
  `stripe/bcd`) weighs the service's deposit (else the clinic's default), the connected account and
  the deposit settings, and answers `book`, `book_and_flag`, `collect`, `hold_and_alert` or
  `decline_and_alert`. The engine's deposit gate (`lib/booking/deposit-gate.ts`, C13) takes that
  answer in place of the plan's interim `voiceDepositOutcome`: `book` and `book_and_flag` write;
  `hold_and_alert`, and chat's `collect`, reserve the slot for `deposit_hold_minutes`;
  `decline_and_alert` logs a request and holds and writes nothing. What a decision leaves behind,
  `pending_front_desk` with the amount and the L10 alert through
  `notifyBookingAlert(tx, "deposit_to_collect", ref)`, is written by D's
  `recordDepositOutcome(tx, outcome, ref)`, which D keeps for the runtime's booking layer to call
  inside the booking's transaction; the engine calls it, rather than adding the plan's
  `appointmentDepositFields` as a second writer. `insertAppointment`, for staff confirmations,
  still applies the clinic-level rule on `stripe/bcd`. `depositLine` stays in `tools.ts` in D's
  form. D's voice rules inside `bookInTenant` go when C12 parks the harness, so D's decision
  reaches voice through the engine.
- **C, locations.** C's `addLocation` calls
  `createLocationClinic({ billingClinicId, locationNumber, name?, actor })`
  (`apps/app/src/lib/location-clinic.ts`, a stub behind `LOCATION_CLINICS_READY = false` until the
  funnel's provisioning rewrite), which sets a location up "exactly as provisioning sets up a bought
  clinic", "the terms record" included. For the calendar: the billing clinic's `organization_id`,
  no `calendar_elections` row and no entitlements row. The location runs manual booking until it
  records an election of its own, which widens and so needs the owner, and connects its own Google
  account. Whether it is mailed a calendar link is §9, item 5.
- **A1, accounts and intents, now the funnel's.** The check before payment is the funnel's
  `agreementMismatch` (`apps/app/src/lib/checkout/intents.ts`, d423a84 on `funnel/build`), which
  compares the `bookingSystem` and `calendarAccount` C3 stores (before 1.3.0, the platform the
  agreement names) with the purchase. C7 builds no second definition of a matching agreement: the
  plan's `assertPlatformMatchesAgreement` is dropped for intents, or at most wraps that function.
  The funnel's provisioning rewrite keeps what C15 built in `lib/provisioning.ts`: the approval gate
  on the bound acceptance's own version, the location's first election row from a signature that
  carries calendar terms (the clause as signed, even where the catalogue has since reclassified the
  booking system), and the signed booking system winning over the request's, with a
  `provision_platform_mismatch` security event, so nobody is paid but refused. Main's `seedSetup`
  (cf07f36, 295cdee) also writes where bookings live, into `clinic_settings.booking_system` and
  `calendar_account`, with Auto-confirm following it, from the intent. The merge is to settle one
  booking system in provisioning and write it there and to `clinics.booking_provider`: under 1.3.0
  or the DPA, the signed `bookingSystem` and `calendarAccount`, which Pay has checked against the
  intent's; before 1.3.0, the intent's answer when it maps to the platform the document names.
  C15, which sees only the request's platform, takes there the `bookingSystem` C3 keeps beside the
  row, but that answer is outside the signed text ("Google Calendar only" and "Something else" sign
  the same 1.2.1 document, and a buyer can swap one for the other without signing again), so the
  intent's is the later word. Provisioning records `provision_platform_mismatch` whenever the
  intent's answer is not the one it settles on.
- **E, the console.** E's portal screens are the funnel's now, and its ops billing panel is C's
  (contracts §1). The panel (d56769d) adds the ops operations `setClinicSettings` (Pause AI and the
  direct line) and `setDepositSettings`, and rewrites `updateClinicSettings` in
  `lib/billing/settings.ts`: a timed pause through `aiPausedUntil`, judged by `isPaused`, and a
  refusal to switch deposits. C9 adds `autoConfirmBookings` to that same `ClinicSettings`,
  `ClinicSettingsPatch` and `updateClinicSettings`, and puts ops `setAutoConfirm` beside
  `setClinicSettings` in `OPERATIONS` and `MUTATING_OPERATIONS`, or folds it in (plan §10). C17's
  edits to `apps/web/src/lib/admin/ops-client.ts` rebase onto the panel's. C17 turns
  `BookingModeCard` into `BookingCard` (the mode and its reasons, Auto-confirm, the kill switch
  read-only, the terms) and extends `CalendarCard`; apps/web deploys first, and the old projection
  keys stay until C17.
- **The hero.** The ring's "to Cal.com, Calendly and HighLevel through that calendar"
  (`apps/web/src/lib/integrations.ts`) matches `BOOKING_SYSTEMS`; C19 adds a test holding them
  together.
- **The runtime.** Bookings are written only through `lib/booking/engine.ts` (C13): `offerTimes`,
  `placeHold`, `bookConversation`, `logRequest` and `ensureDeskNotified`. Google is never called
  inside a database transaction. `offerTimes` follows `canOfferTimes`, not the mode (plan §8.1,
  over §7.4's "manual mode" comment): a clinic with Auto-confirm off, or still in setup
  (`not_production`, `agent_not_approved`), is offered real free times once its terms allow
  writing and its calendar is healthy, and the time chosen becomes a request. The funnel's "Talk
  to your AYA" preview, whose dry tools hold and write nothing, calls `offerTimes` only, never
  `placeHold`, `bookConversation` or `logRequest`. The keys:

| Channel                              | `holderKey`              | `bookingKey`                                                                        |
| ------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------- |
| Retell (launch plan 2.1)             | `retell:<call_id>`       | `retell:<call_id>:<n>`, where n grows only when the caller asks for another booking |
| Web chat                             | `web:<session>`          | `web:<booking-attempt uuid>`                                                        |
| Meta, requests only                  | `meta:<conversation_id>` | `meta:<platform>:<mid>`                                                             |
| Synthflow harness, demo clinics only | `voice:<call_id>`        | `<call_id>`                                                                         |

The Retell process links its post-call record by its key prefix. Until Retell, the Synthflow routes
are a test harness: for any clinic that is not a demo clinic, `slots`, `hold` and `book` answer 403
`manual_booking`.

## 7. Dropped from this build: C4 and C16

The funnel's M2 owns checkout: the "Where do bookings live today?" picker, the manual-booking
notice, the "Which Google account will bookings go into?" question, and the agreement step's
preview through `buildBaaSelections`. This build edits no apps/web checkout file. Calendly, which
the plan would have added at the release, is already in C2's booking systems.

## 8. The owner's decisions this build follows

5 October, while planning:

1. The funnel asks both the booking system and the kind of Google account, and the two answers
   choose the agreement's calendar clause.
2. A calendar outside Google's business associate agreement still gets the first name, the service
   and the time, at the practice's direction and on its responsibility: the uncovered clause.
3. Calendar terms are per location: the signed agreement for the location set up at signing, then
   append-only calendar elections, never a re-signed agreement.
4. Direct booking needs Auto-confirm (on by default), a healthy connection and signed terms that
   allow writing. `HEALDESK_DIRECT_BOOKING_ENABLED` is a kill switch, off by default, that only the
   owner sets.
5. The calendar watch runs on its own five-minute schedule: a forced token refresh and one
   free/busy probe per connection, and a definitive failure flips the location to manual booking.

5 October, the plan's questions:

- **Q1.** Yes, with the seams in §6.
- **Q2.** Claude releases 1.3.0 and `calendar-election/1.0.0` after its own adversarial audit of
  the full text, with no counsel gate, and records the audit in `agreement-changes.md` §12.
  Counsel's approval of the calendar BAA and the 24-hour notice, which the owner reported on 6
  October, came before main's merged text, so the audit covers all of it.
- **Q3.** A practice that declared itself a covered entity may use the uncovered clause.
- **Q4.** Calendly is added. Without written confirmation from their vendors, Zenoti, PatientNow,
  Acuity, Vagaro and Boulevard stay unverified. HighLevel is live because the spec's table now says
  it reads Google Calendar once set up (a45cd9a).
- **Q5.** Spec step 8 now says the booking is in the clinic's calendar (082cf9d). The booked line
  is "You're booked for {when}{ for service}. It's in the clinic's calendar."
- **Q6.** An operator script may create one fictional demo clinic in production, for Google's
  verification video. It can never go live.
- **Q7.** The defaults stand: one Google account per location; no staff confirmation of overlapping
  times on a location that writes to Google, with no override until named-provider booking, which
  is now in v1 (§9, item 4); access revoked when offboarding starts; the kill switch stops only the
  assistant's own bookings; 120 minutes' notice, offers up to 14 days ahead (60 for a named date),
  a 15-minute grid, a 60-second hold, 30 minutes for a service with no duration, and 3 options in a
  voice offer.
- **Q8.** 1.3.0 also carries the Payments clause, the state-law clause and the 45 CFR 164.514(b)
  citation.

5 October, hosting: AWS RDS rather than Neon, one KMS key, and lock labels from permanent client
numbers (§5).

6 October:

- five Google scopes, the calendar list included (§4);
- 1.3.0 gives 24 hours' notice before a new subcontractor handles PHI, and keeps the practice's
  right to object;
- one email address and one sign-in per clinic, whose one membership is active, with role `owner`;
- the kill switch stays the owner's, and Auto-confirm is the clinic's control;
- no Behaviour screen, and no opening dates;
- on the release audit's first pass: the uncovered clause stays open to a covered practice, a risk
  the owner accepts (HRC-01); 1.3.0's Term clause is to say what the product does, destroying data
  30 days after termination once the export has been downloaded and otherwise within 90 days, with
  backups until they expire (HRC-02); where return or destruction is infeasible, 1.3.0 is to limit
  further uses and disclosures alike (HRC-03); and code holds a covered clinic's calendars to its
  own domain (HRC-04, §4).

Named-provider booking is in v1 because the spec has it, which is what the calendar-list scope was
taken for; the funnel agreed its tables and functions the same day (§2, §4).

## 9. Open between the sessions

Found while writing this record, in the funnel plan and on the Stripe and funnel branches as they
stood on 6 and 7 October. Each is to be settled with the other session before the commit named.

1. **Settings columns (C6, with the funnel).** The funnel plan's `clinic_settings` gains
   `auto_confirm`, `booking_detail`, `booking_system` and `google_account_type`, and its
   provisioning sets Auto-confirm from the booking system; the spec defaults Auto-confirm to on, and
   this plan adds `auto_confirm_bookings`, with who changed it and when, in migration A. Which
   migration adds it is to be agreed. Here, neither answer decides a location's calendar terms,
   which come only from the signed acceptance and the location's elections; changing either answer
   in Settings records an election (C18).
2. **A changed agreement (C6 and C7, with the funnel).** The funnel's `0051_agreement_kinds`, still
   on its branch, adds DPA acceptances, which carry the same calendar clause ids, and
   `app_supersede_agreement()`, which replaces a clinic's agreement with a later one. The plan
   assumed none is ever replaced: elections anchor to the agreement in effect, and an `agreement`
   election row may only be a location's first. What a superseding agreement does to a location's
   calendar terms is to be settled before migration A.
3. **The portal user's lock label (C6b, with the funnel).** The funnel's `lib/factors/totp.ts`
   seals each clinic user's authenticator-app secret through the same envelope, keyed by the user,
   so it has no `client_number`. C6b changed its two calls, since `seal()` and `open()` now require
   a label, and gave them the fixed label `users` / `user-totp` (§5). The funnel is to confirm it
   before any sign-in enrols in production: a secret sealed under one label does not open under
   another, and the application cannot re-seal a secret, so a later change means every sign-in
   enrols again.
4. **Staff confirmations with named providers (C6 and C12, with the funnel).** The overlap guard
   keys on the clinic and the calendar, but a staff-confirmed appointment records no calendar. With
   named providers it needs one, the provider's, for the guard to key on; which calendar a
   confirmation occupies, and where Bookings asks for it, is to be agreed.
5. **Calendar links (C8, with the funnel).** The plan's single-use calendar links to the practice
   (the recipients link, the owner's change and confirm links, the rotated link) came before the
   portal. With connects through `startGoogleConnect`, calendar emails through O13 and one owner
   sign-in per clinic, which kinds remain, and whether a new location or account gets one, is to be
   agreed.
6. **Choosing the shared calendar (C8).** The contract has `listCalendars`, and `saveProviders` for
   named providers, but no function for the shared calendar the portal's picker chooses.
7. **A covered clinic's picker (C8, with the funnel).** Until C1's calendar list can tell the
   account's own organisation's calendars from ones shared in (§4), a location under
   `workspace_baa` terms books only into its primary calendar, so the picker offers it nothing
   else, and setup step 3.2 offers it no named providers, each of whom needs a calendar of their
   own.
8. **Who acted (C8, with the funnel).** `startGoogleConnect` and `disconnect` are to take the
   portal user as `actor`, as `setAutoConfirm` does (§2), which changes the signatures agreed on 6
   October.
9. **Google's 100-user cap (C8, with the funnel).** The funnel's /admin is to show the count from
   the calendar backend. No planned commit records it, and destroying a clinic's data deletes the
   connection rows it could be counted from.
10. **A booking mode without a clinic (C9, with the funnel).** Checkout's step 2 shows a line from
    "`effectiveBookingMode`'s global state" before any clinic exists; the agreed signature takes a
    clinic.
11. **Desk emails and the desk page (C12 and C13, with the funnel).** `notifyBookingAlert` (on main,
    a no-op until the funnel's M5) replaces `notifyDesk`: its emails carry ids only and point into
    Bookings, and a booking the assistant made raises none unless a deposit is owed (L10); the daily
    summary lists it. In M5 the funnel also makes `/booking/[token]` a pointer with no patient
    fields and no actions, and moves decisions behind sign-in and the passkey step-up, through
    `decideBookingRequest`'s core refactored to `(clinicId, requestId)` (funnel plan F5). Today the
    token is the whole of the authentication for a page that shows a patient's first name, phone
    number, times and service, which the v1 portal rules in CLAUDE.md do not allow. So desk-token
    links do not carry into v1 for real patients: C12 makes its desk-path changes in
    `decideBookingRequest`'s core rather than in the token page, and C12 and C13 mail no desk token
    and re-issue none (no `app_reissue_undelivered_booking_token`). Which booking-alert kind, if
    any, each of the plan's `notifyDesk` variants (`fyi_direct`, `calendar_unconfirmed`,
    `late_write_confirmed`, `deposit_hold`) and link-free notices (`second_ask`,
    `calendar_conflict`) becomes is to be agreed before C12.
12. **Voice deposits (C13, with D).** With "Book by phone without a deposit" off, D declines a
    deposit-required voice booking whatever "When a deposit cannot be collected" says, following
    the spec's row for the phone switch ("routes to staff instead"). The plan (§7.6) and the Stripe
    design (§5.6) let that setting decide, following its own row ("applies to any channel that
    cannot collect in the moment"). The engine follows `depositDecision` either way; which reading
    holds is the owner's call.
13. **The gate and the replay (C13 and C14, with B).** B answers a retried booking from its replay
    before it asks the gate (R25), so a booking that went through is answered as it was, whatever
    the gate says now. The plan has the runtime ask the gate before calling the engine, whose
    replay is the first step of `bookConversation`; keeping R25 puts the gate after that replay.
14. **The daily summary's booking link (C13, with the funnel).** L13 opens each booking's Google
    Calendar event, but the adapter returns the event's id rather than Google's `htmlLink`, and a
    connection that books into a main calendar stores `primary`, not that calendar's id.
15. **Sealing in main's Meta connect flow (with the session that owns it).** Found on main on 7
    October. `POST /api/meta/login` sends a clinic to Meta's dialog, and `POST /api/meta/whatsapp`
    subscribes the clinic's WhatsApp account and registers its number, after checking only the
    Meta app's configuration; the tokens are sealed after that (`attachMetaChannel`, then
    `saveConnection`). C0r refuses a `HEALDESK_KMS_KEY_ID` that main accepted (an alias, a bare
    key id, another region's key), so on such a deployment the clinic gets through Meta, the seal
    fails, and the clinic is told `meta_error` (the callback's `?problem=`, the WhatsApp route's
    500), blaming Meta for our key. Each route is to call `credentialSealingProblem()` (§5) once
    its link resolves and before it calls Meta, log the reason (it names the variable, never the
    value) and answer with its existing `not_configured`: the login route's redirect, the WhatsApp
    route's 503. Nothing calls it yet; until something does, the worker's start-up self-check is
    what reports the key.
