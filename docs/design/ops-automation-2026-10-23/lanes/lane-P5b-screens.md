# Lane P5b: the Phase 5 console screens — builder: Fable

Read `RULES.md` first (trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; check every
commit with `git log -s --format='%(trailers:key=Co-Authored-By,valueonly)'`).
Worktree `/Users/liamariavisoiu/projects/healdesk-p5b`, branch `ops/p5b-screens`, cut from the lead's integration branch
`ops/p5-integ` (main plus lanes P5a and P5d, so the new `ops-client` functions exist). apps/web only, no database; run
`npm test -w @healdesk/web -- <files>`. Owner's rule for every screen: VERY CLEAR AND EASY TO UNDERSTAND, no repetition,
no information that is not useful for the ops.

## Why
Phase 5 added operations with no screen: the voice agent's status and its retry, clearing a drift flag, calendar
writes that are stuck across clinics, transcript copies that never reached a clinic, the machine queues (outbox, Stripe
events, billing requests, paid orders without an account, unsent alerts) and the lifecycle ignore list for internal test
accounts. The alerts and Home rows tell the owner to open these; the controls must exist with exactly the names below,
because the alert wording lane quotes them and a test checks each quoted name appears in apps/web's source.

## The owner's decision (24 Oct 2026)
The machine queues are a READ-ONLY section of the System page, and the part of it that lists what is past its patience
is headed literally **"Requires your attention"**. Below it, the queues that are fine are shown as counts under
**"Being watched"**. The human queues page (`/admin/queues`: reviews, support, agreement checks...) stays where it is.

## What to build (use only ops-client functions that exist on the integration branch; read their types)
1. **System page** (`apps/web/src/app/admin/system/page.tsx`): add, above the page links, the section
   **"Requires your attention"** (anchor `id="attention"`), drawn from `fetchMachineQueues()`,
   `fetchStuckCalendarWrites()` and `fetchUndeliveredTranscripts()`:
   - machine queues with `needsAttention`: the queue's plain words, the count, how long the oldest has waited ("2 hours"),
     and nothing else; no buttons that act. Where a queue belongs to one clinic, link to that clinic's tab.
   - **"Calendar writes stuck"** (anchor `id="calendar-writes"`): one row per clinic with a count and the oldest problem
     in words ("failed", "gave up after 5 tries", "waiting for its next try"), linking to that clinic's Setup tab
     (anchor `#calendar-writes`, built in item 3). Say when the list is cut off at 100.
   - **"Transcript copies not delivered"** (anchor `id="transcripts"`): one row per clinic: how many are overdue,
     bounced or expired, the oldest age in hours, link to the clinic's Deliveries tab.
   - an empty section says "Nothing needs you here." (one line), never a table of zeros. A part that could not be read
     says so by name ("Stripe events could not be read") and is never drawn as a zero.
   - **"Being watched"**: the remaining queues, name and count, one compact list.
   - Standby: the host-in-standby behaviour the Queues page has (one notice, not one per section).
2. **Setup tab, card titled "Voice agent"** (`clinics/[clinicId]/setup`, anchor `#voice`): from `fetchVoiceAgentStatus
   (clinicId)`: in words, whether the agent is ready, which phone number is held (never print the number), the engine, the
   last problem in plain words, attempts, and whether it is flagged as drifted. Buttons: **"Retry"** (`retryVoiceAgent`,
   outcome line: ready, already set up, not allowed yet and why, failed), **"Check against Retell"** (`fetchVoiceAgentStatus`
   with `verify`, shows what differs in plain words), and **"Clear flag and recheck"** (`clearVoiceDriftFlag`, ONLY when
   the clinic is flagged; asks for the fresh authenticator code the way the other step-up controls on the Billing tab do;
   outcome lines for cleared, still drifted (with the problem), code refused). Never offer a button that is not allowed
   for the state (no Retry on a ready clinic without saying why).
3. **Setup tab, section "Calendar writes"** (anchor `#calendar-writes`): the stuck writes of this clinic from
   `fetchStuckCalendarWrites` filtered to the clinic, each with status in words, reason in words, tries so far of 5,
   next try ("in about 30 minutes") or "will not be tried again", the slot as "in N days", and a **"Retry"** only if the
   operation set for it already exists on the integration branch (`retryCalendarWrite`: check `ops-client.ts`; reuse the
   existing control if one exists on the onboarding/Setup tab rather than building another). Empty: "No stuck writes."
4. **Setup window card: "Do not watch this account"** control (internal test accounts): a clearly secondary button using
   `setLifecycleIgnored(clinicId, true/false)` with a one-sentence confirm ("No setup reminders or setup alerts for this
   account. Its calendar, voice and billing alerts still arrive."), and the state shown ("Not watched (internal)") when
   ignored. The card must still render for an ignored clinic so the owner can turn it back on.
5. **Links**: the Home rows P5a and P5d add point at `/admin/system#attention`, `/admin/system#transcripts`,
   `/admin/clinics/<id>/setup#voice` and `#calendar-writes`. Make sure `IssuePanel`/the hash map in `lib/admin/issue-link.ts`
   scrolls to `#voice`, `#calendar-writes`, `#transcripts` and `#attention`, and add a test that every `href` the apps/app
   inbox constants export resolves to a page and anchor that exist in apps/web's source (read the constants from apps/app
   source text in the test, as lane A4's did).
6. **Clinics table**: nothing new unless P5d's strip carries `ignored` (check `strip-types.ts`: you may NOT edit it; if the
   table needs a field it lacks, STOP and report).

## Files you OWN
`apps/web/src/app/admin/system/**`, `apps/web/src/app/admin/clinics/[clinicId]/setup/**`, `components/admin/**`,
`lib/admin/{issue-link,inbox*}.ts`, their tests. Hot: `ops-client.ts`, `system-map.ts`: untouched (you need no change;
if you do, STOP and report). Not: `apps/app`, `strip-types.ts`, `AGENTS.md`, `CLAUDE.md`, `docs/`, `.github/`.

## Tests
Static-render tests with fixtures for each state (including "could not read", standby, empty, truncated), each button calls
the right ops-client function with the right arguments (mock ops-client), the step-up control refuses without a code,
the anchors above exist, no phone number or address ever appears in the Voice agent card's output (assert on a fixture
that contains one). Full `npm test -w @healdesk/web`, `npx tsc --noEmit -p apps/web`, `npm run lint`,
`npm run build -w @healdesk/web`.

## Report
RULES.md format; list every control and section name you built (they are quoted by alert wording) with its anchor, and
what you did not build.
