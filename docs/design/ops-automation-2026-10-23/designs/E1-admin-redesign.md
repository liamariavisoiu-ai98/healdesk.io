> Design input, written 23 Oct 2026 by a read-only design agent from main at 2e258ae9. Not a decision: the plan in ../README.md decides what is built and in what order. Claims are from the code unless marked NOT VERIFIED; spot-checked by the session that commissioned it.

# E1: The admin redesign (owner's GLOBAL instruction; where items 1, 6, 7, 11, 20 and the clinic-list indicators live)

Read at commit 2e258ae9. Everything below was read from `apps/web/src/app/admin/**`, `apps/web/src/components/admin/*`, `apps/web/src/lib/admin/ops-client.ts` and `apps/app/src/lib/ops/*`. "Not found" means I looked.

## 1. Current state: the honest inventory

Facts first. The ops envelope has **105** operations, not 60 (105 `case` labels in `apps/app/src/lib/ops/api.ts`, 105 exported functions in `ops-client.ts`). The nav (`admin/layout.tsx` `SECTIONS`) has **16 entries**, no "you are here" mark. There is a per-clinic area of **5 pages**; the Billing page is linked only from the Onboarding page's header, never from the clinic card.

| Page | What it shows | Who needs it | Repeats / noise for ops (quoted) |
| --- | --- | --- | --- |
| `/admin` ("Changes", `AdminDashboard.tsx`, 1,025 lines) | Git commit feed, "Commits / Lines added / Lines removed / Active days", activity chart, area breakdown, roadmap board; polls GitHub every 15 s | The developer | **The whole page is engineering telemetry.** An ops person opening the console lands on "What is changing." and a commit list. Nothing on it is a clinic. |
| `/admin/ops` (`OpsConsole.tsx` + `FirstWeeks.tsx`) | Red banner "N clinics are blocked"; **First weeks** (clinics live < 60 d, flags, touch log, "Record call/email/note" via `window.prompt`); **Scheduled jobs** (all 32 jobs as cards, each with last run); **Clinics** (one card per clinic: specialty, synthetic/production, CE, BAA date, "attribution estimated (phase two)", connection tag, timezone, blockers, agreement label, channel states, build tracker, four links, and a **connect-link form on every card**) | Ops, daily | Phase-two noise on every card: `attribution … (phase two)`, the connect-link form, the paragraph "Phase two: N clinics have neither a stored read-back credential…", FirstWeeks' "read-back connected (phase two)". Explanatory prose: jobs intro (6 lines), the 8-line footnote "Configuration only. This is our operator console…" and "Connection state was read for the N most recent clinics". Jobs list is 32 cards of which ops touches two a month. "recovered" / "the desk would have missed" is attribution wording (CLAUDE.md claims rule: say "booked by AYA" / "calls answered"). |
| `/admin/ops/[id]/onboarding` (`OnboardingPanel.tsx`, 1,317) | Checklist, Phone line, Agent script, Deposits (Connect), Meta front door, Booking request fields, Time zone, Calendar, Go live, Channels; 17 actions | Ops during setup | Sound, but it is "Setup" and is named "Onboarding checklist, phone, script, go-live →" on the card. Deposits/Connect also appears on Billing. |
| `/admin/ops/[id]/billing` (`BillingPanel.tsx`, 1,444) | Plan, Usage and the allowance, Refund under Terms § 5, Billing requests, Close an unfinished setup, A location waiting, Annual overage invoices, Parked Stripe events, **Billing emails — last N** (includes `setup_reminder` rows), Status history; 17 actions | Ops on billing days | Ten sections on one scroll; "Status history" and "Parked Stripe events" are engine ledgers nobody reads unless an alert points there. Not reachable from the clinic card. |
| `/admin/ops/[id]/care` (`CarePanel.tsx`, 646) | Who gets the reports, **What was sent — last N**, Incidents (open/notify/resolve), Deletion requests, Amendments, Offboarding | Ops after go-live | "What was sent" is a second delivery ledger (Billing has one, Transcripts has a third). Incidents are opened here but decided on `/admin/incidents`: two homes. |
| `/admin/ops/[id]/transcripts` (`TranscriptsPanel.tsx`) | Counts by status over 7/30/90 d, receipts, "Send again" | Ops when an alert says a transcript failed | Per clinic only; **no cross-clinic view** (item 11's "monitoring" is missing above the clinic). |
| `/admin/ops/[id]/account` (`AccountPanel.tsx`, `DevicesSection.tsx`) | The clinic's address (72 h change), Covered entity, Devices (recovery, removal) | Ops, rarely, with a fresh code | Fine; it is "Account". |
| `/admin/reviews` | Practice-question failures to decide; **Agreement checks** (DPA practices whose site says insurance) | Ops, by the day promised | Agreement matters live in three places: here, `/admin/agreements`, `/admin/notices` (L22 re-signs). |
| `/admin/incidents` (`IncidentsBoard.tsx`, 569) | Every clinic's incidents, two deadlines, send report / not reportable | Ops, rarely, urgently | Two paragraphs of legal history ("BAA 1.2.1 and before promised five calendar days…") on top of the list every time. |
| `/admin/compliance` | BAAs in the chain (attest/withdraw), Gate B human + code, History, and the open **launch promises** | Owner | Launch promises are also the tracker on `/admin/seo` (`LAUNCH_PROMISES` rendered on both). |
| `/admin/notices` (`NoticesBoard.tsx`, 792) | Six send forms (L28 terms, L29 subcontractor, L33 product update, L22 re-signs, L30 guarantee, L31 suspend) + "What was sent, the last 180 days" | Owner, a few times a year | Six always-open forms; the only thing ops reads here is the ledger at the bottom. |
| `/admin/map` | Every tool, bridge and key, live | Owner / developer | Keep; it is the one hand-drawn picture (CLAUDE.md rule). Not daily ops. |
| `/admin/host` | Host state, switch, runs, cost tables | Owner | Keep; cost table is item 20's cost half. |
| `/admin/setup` | Setup requests from the Sheet, send link / decline | Sales-ops | A queue. |
| `/admin/site-reads` | Purchases whose site could not be read, "Read again" | Ops | A queue of ~0–3 rows with its own nav slot. |
| `/admin/support` | Support escalations owed / replied | Ops, daily | A queue. |
| `/admin/recordings` ("Retell deletions") | Calls Retell still holds, delete | Ops | A queue, usually empty. |
| `/admin/crm` | An `<iframe>` of the marketing Sheet | Sales | Placeholder until the CRM session (item 19, plan only). |
| `/admin/demos` | Build a personalised demo; recent demos | Sales | Keep as is. |
| `/admin/agreements` (`AgreementsRegister.tsx`, 1,131) | Every signed BAA/DPA, filters, download, terminate, resend copy | Ops/legal | Keep; the 7-line retention paragraph can be a tooltip. |
| `/admin/seo` | Strategy steps, ten health checks, pages by stage, roadmap, AI panel, launch tracker | Owner | Keep; launch tracker should have one home (see IA). |

Repeats across the code: `function Section` is copied in **6** files; `Tag/Failure/Empty/Problem/Row` exist only in `OpsConsole.tsx` and are re-invented ad hoc elsewhere; `Row` has three unrelated meanings. `text-done` is used in 3 admin files but **no `--color-done` token exists** in `globals.css`, so "done" renders in the inherited colour. Operations with **no screen**: `voiceAgentStatus`/`retryVoiceAgent` (item 10 has nowhere to show), `listCalendarWrites`. Slack is **not in apps/app**; `SLACK_WEBHOOK_URL` exists only in `apps/web/src/lib/demo/alert.ts`. The morning digest exists: `apps/app/src/lib/ops/digest.ts` (`collectDigest()`, job `ops-digest`, 07:00 UTC, email only, counts and ids).

## 2. The new information architecture

Five sections, each answering one question. Nav: **Home · Clinics · Queues · Compliance · System**. Mark the current section in `AdminChrome` (it already calls `useSelectedLayoutSegment`, so the layout's old objection no longer holds).

### Home (`/admin`): "what needs me today, in order"
One list, nothing else. Each row: **count · one sentence · the clinic (name + copyable id) when there is one · one button**. Ordered by deadline, then severity. Sources, all existing: open `ops_alerts` (unresolved events), the digest's queue tally (`collectDigest()` reused: the email and the screen read the same payload, so item 1's new data points appear here the day they enter the digest), `listClinicHealth` flags, `listPracticeReviews`, `listSupportRequests`, `listRecordingAlerts`, `listSiteReadFailures`, E6's approvals. Rows and their button:

| Row | Button (operation) |
| --- | --- |
| N transcripts undelivered > 72 h (item 11) | Open clinic › Deliveries (`resendTranscript`) |
| N clinics ready to go live (item 7: every bought channel `live`/audited, nothing blocking) | Open clinic › Setup › Go live (`goLive`) |
| N clinics changed availability/roster, audit not green (items 5, 6) | Run audit (the audit op from the E-agent for item 5) |
| N clinics in setup with no channel live, days left, last reminder day (items 4, 8) | Open clinic › Setup; Extend (`extendSetupDeadline`, manual only) |
| N near allowance (item 3) | Open clinic › Billing (`setUsageAlerts`, the new send-notification op) |
| N calendar connections broken after retries (item 9) | Open clinic › Setup › Calendar + E7's Fix-with-Claude control |
| N voice agents drifted/failed (item 10) | Retry (`retryVoiceAgent`) |
| Reviews / support / Retell deletions / site reads owed | Open Queues › that section |
| Approvals waiting (E6) | Open Queues › Approvals |
| Launch: N promises open, M blocking (item 20) | Open Compliance › Launch |
| Digest: "sent 07:14 UTC" or "not sent (attempt 3)" | Open System › Jobs |

Empty home = one line: "Nothing needs you. Last checked 09:12." The commit feed moves to System › Changes (not deleted; `changes.ts`, `roadmap.ts` and `honesty.test.ts` are untouched).

### Clinics (`/admin/clinics`): every signed clinic's state at a glance
A table, one row per clinic, newest first, filter chips (Setting up · Live · Paused · Attention · Synthetic). Columns, each a coloured chip with one or two words:

`Clinic (name, id copy)` · `Stage` (setup day n/30 · live since · paused · offboarding) · `Channels` (web ● meta ● voice ●, each live/waiting/off) · `Availability` (unchanged · changed, audit ✓/✗/running — item 5) · `Calendar` (healthy · degraded · broken · none) · `Voice agent` (ok · drift · failed · not provisioned) · `Transcripts` (n waiting / n bounced, 30 d) · `Usage` (% of included, worst channel) · `Last reminder` (day 15 · none) · `Blocking` (the first `blocker.message`, red). Click = the clinic panel; a chip click = the tab that owns it.

Today's four reads (`listClinics`, `listClinicCards`, `listClinicHealth`, `listJobs`) give Stage, Channels, Blocking, and Usage only for clinics < 60 days live. **One new read operation, `listClinicStrip`**, returns the rest per clinic (availability-audit state, calendar state from connection health, `voiceAgentStatus`, transcript counts, setup deadline and the last `setup_reminder` row's day, usage from the billing row) in one envelope: ids, dates, enums and counts only, no names beyond the clinic's. Add the op rather than calling six per row.

### Clinic panel (`/admin/clinics/[id]`): tabs that each own one concern
Header: name · id (copy) · stage chip · blocking line · tabs. Tabs:

1. **Setup** = today's Onboarding page, plus an **Availability & roster** card (item 5/6: last change, by whom and how — portal or db-apply — the automatic audit's result, "Run audit again") and a **Ready to go live** summary at the top (item 7).
2. **Billing** = today's Billing page, sections collapsed by default except Plan, Usage, Billing requests; adds the item-3 "Send usage notice" button.
3. **Deliveries** = Transcripts + Care's "What was sent" + Billing's "Billing emails" + the setup reminders, one ledger with a kind filter (item 11 monitoring, item 4 "every time a reminder has been sent").
4. **Care** = recipients, incidents (open/notify/resolve), patient-rights steps, offboarding.
5. **Account** = address, covered entity, devices.

The clinic-level transcript, care and billing panels keep their props and tests; only the shell changes.

### Queues (`/admin/queues`): one page, sections with counts
Reviews · Agreement checks · Support · Retell deletions · Site reads · Setup requests · Approvals (E6's `/admin/inbox` can live here or stay its own URL; the Home row links either way) · Patient rights (E6's `/admin/rights`). Each section = the existing page body, minus its heading prose.

### Compliance (`/admin/compliance`)
BAAs in the chain · Gate B · **Launch promises (the one home; removed from `/admin/seo`)** · Agreements register (today's `/admin/agreements`) · Incidents register · Notices (sends behind a "Send a notice…" disclosure; the 180-day ledger open) · Weekly pack (E6).

### System (`/admin/system`)
Host (+ costs, item 20) · Jobs (only switches and last results; the 32 cards become a table; a job off that a live clinic needs is a Home row) · Map · SEO · Changes (the old dashboard) · Sales (Demos, CRM iframe, until the CRM session).

### Before → after page map

| Before (16 nav items, 21 pages) | After |
| --- | --- |
| `/admin` Changes | **Home** (needs-me list); Changes → `/admin/system/changes` |
| `/admin/ops` | `/admin/clinics` (list) + `/admin/system/jobs` |
| `/admin/ops/[id]/{onboarding,billing,care,transcripts,account}` | `/admin/clinics/[id]/{setup,billing,deliveries,care,account}`; old URLs `redirect()` so every mailed alert link keeps working |
| reviews, support, recordings, site-reads, setup | `/admin/queues#…` (old URLs redirect) |
| compliance, agreements, incidents, notices | `/admin/compliance` with sub-routes `/agreements`, `/incidents`, `/notices` |
| map, host, seo, crm, demos | `/admin/system/…` (map and host keep their URLs; they are in runbooks) |

**Merge:** three delivery ledgers → one Deliveries tab; agreement checks + register + re-signs → Compliance; five small queues → Queues; launch tracker ×2 → one. **Delete:** the connect-link form from the clinic card (keep the op; move it to Setup behind "Phase two"), the First-weeks touch log's `window.prompt` (a proper small form in the Care tab), the "Status history" section (fold into Deliveries as a kind), the phase-two paragraphs.

### Noise removed (specific)
"attribution estimated (phase two)" tag; "Phase two: N clinics have neither a stored read-back credential…"; "Connection state was read for the N most recent clinics…"; the 8-line "Configuration only…" footnote; the jobs intro paragraph; the two legal-history paragraphs on Incidents (→ a "Why two deadlines" disclosure); the 7-line retention paragraph on Agreements (→ tooltip on the purge column); "read-back connected (phase two)" in First weeks; "Commits / Lines added / Lines removed / Active days" from the first screen; the `timezone` on every card (it is in Setup › Time zone); six always-open notice forms; the `specialty` tag (keep in the panel header). Reword "recovered" → "booked by AYA" (claims rule).

## 3. Design-system rules (existing tokens in `globals.css` only)

- **Five tones, one component.** `Tone = ok | warn | bad | info | muted` → `bg-tint-mint text-ink` · `bg-tint-butter text-ink` · `bg-red/10 text-red-deep` · `bg-tint-sky text-ink` · `bg-paper-2 text-muted`. A dot before a word uses `bg-mint`, `bg-sun`, `bg-red`, `bg-ink/40`, `bg-line-strong`. Red is for *blocking* only (today it also means "job on"). Add `--color-done` = `--color-mint` to `@theme` and then retire `text-done` for the ok tone.
- **Shared primitives in `apps/web/src/components/admin/ui.tsx`** (client-safe, imports types only, so `client-imports.test.ts` stays green): `Section`, `Tag`, `Chip`, `Failure`, `Empty`, `Row`, `ActionButton`, `ClinicId`, `IssueAnchor`. Nothing under `admin/` defines its own copy after step 0.
- **Empty states are one line and say which empty**: "No X." vs "Could not read X: <ops-client sentence>." (what `honesty.test.ts` already enforces for the dashboard). Never a zero where nothing was read; never prose explaining the product.
- **One button pattern for send / retry / audit**: `ActionButton` with `idle → working → done | refused | failed`, label a verb ("Send", "Send again", "Retry", "Run audit"), the outcome in one `role="status"` line beneath, "audit entry could not be written" kept as a warning. Primary = `bg-ink text-white rounded-full`; secondary = `border-line-strong hover:border-ink`; destructive = secondary + a confirm sentence; anything irreversible to a clinic (a send, a refund, a close) needs the fresh-code step as today.
- **An alert links to the exact issue.** Every alert, Home row, Slack line and email button carries `/admin/clinics/<id>/<tab>#<event>-<id>`; the tab renders `IssueAnchor` with that id, scrolls to it and highlights it (`:target`), and the row shows the same button Home does. One URL shape for all 60+ events (`lib/admin/issue-link.ts`), tested.
- **Ids are text**: every clinic, conversation, alert and invoice id is `<code class="font-mono select-all">` with Copy (keep `ids-visible.test.ts`).
- **Type sizes:** page h1 `text-[28px] font-display`, section h2 `text-sm uppercase tracking-[0.08em]`, body `text-sm`, chips `text-[13.2px]`. One content width (1240 px), one card (`border-line rounded-md bg-white p-5`).

## 4. Migration plan: page by page, 105 operations and the tests untouched

Principle: **ops-client and `apps/app/src/lib/ops/api.ts` change only by addition** (`listClinicStrip`, `opsInbox`). Panels keep their `view`/`actions` props, so their static-render tests (`care-copy`, `audit-copy`, `booking-copy`, `account-copy`, `devices-copy`, `transcripts-copy`, `notices-copy`, `incidents-copy`) pass unchanged; page tests that import a page's default export (`support`, `recordings`, `setup`, `site-reads`) move with the page body into its Queues section file and import that instead; `ids-visible.test.ts` keeps working through a re-export of `ClinicId` from `OpsConsole.tsx` until that file goes.

| Step | Size | What | Proves it | Files |
| --- | --- | --- | --- | --- |
| 0 | S | `ui.tsx` primitives, `--color-done`, replace the six `Section`s and ad-hoc tags | existing copy tests; new `ui.test.ts` renders every tone | `components/admin/ui.tsx`, `globals.css`, the six panels |
| 1 | M | `/admin/clinics` from the four existing reads, old `/admin/ops` kept | `clinics-list.test.ts` (static render, fixtures as in `account-copy.test.ts` "the clinic cards") | `app/admin/clinics/page.tsx`, `ClinicTable.tsx` |
| 2 | M | `listClinicStrip` in apps/app + reader; columns Availability, Calendar, Voice, Transcripts, Usage, Last reminder | `ops-client.test.ts` contract test; apps/app api test; `readonly-tables` unaffected (no new table) | `apps/app/src/lib/ops/api.ts`, new `ops/strip.ts`, `ops-client.ts` |
| 3 | M | Clinic panel shell with tabs mounting the existing panels; old per-clinic URLs → `redirect()` | panel tests unchanged; a redirect test per old route | `app/admin/clinics/[id]/layout.tsx` + 5 tab pages; 5 old `page.tsx` reduced to redirects |
| 4 | M | Home = `opsInbox` (built on `collectDigest()` + open `ops_alerts` + the list reads); Changes → System | `home-copy.test.ts`: every row has a count, a sentence, a link; empty state one line; `honesty.test.ts` unchanged | `app/admin/page.tsx`, `app/admin/system/changes/page.tsx`, `apps/app/src/lib/ops/inbox.ts`, `ops-client.ts` |
| 5 | M | Queues page; each old queue page becomes a redirect as its section lands (one PR each) | its moved page test | `app/admin/queues/*` |
| 6 | S | Compliance absorbs agreement checks, launch promises, agreements, incidents, notices as sub-routes; `/admin/seo` drops the tracker | `register-kinds.test.ts`, `notices-copy`, `incidents-copy` unchanged | `app/admin/compliance/*`, `seo/page.tsx` |
| 7 | S | Deliveries tab merges the three ledgers | `transcripts-copy` + a merged-ledger test | `clinics/[id]/deliveries/*` |
| 8 | S | Nav 16→5 with current mark; noise removal; delete `OpsConsole.tsx` (move `ClinicId` to `ui.tsx`, update `ids-visible.test.ts` import) | lint, build, full `npm test -w @healdesk/web` | `layout.tsx`, `AdminDashboard.tsx` (`AdminChrome`) |

Each step is its own CI batch (`check/<name>`, owner's 19 Oct rule). Nothing here touches the portal, PHI, Terraform or `/admin/map`'s keys; the two new operations are read-only projections and go on the map's `BRIDGES` words for the ops envelope.

## 5. Guardrails and conflicts

- **PHI:** the strip and the inbox carry ids, enums, counts and dates; no conversation text, no patient field. The Deliveries tab stays receipts without words. Keep the standby notice pattern (`HostStandbyNotice`).
- **Claims:** "recovered"/"the desk would have missed" on First weeks becomes "booked by AYA"/"calls answered" (CLAUDE.md, Claims). Not an owner decision; the rule exists.
- **OWNER DECISION 1:** the commit feed leaves `/admin`. Recommended: keep it at System › Changes, never delete.
- **OWNER DECISION 2:** merging small queues into one page changes runbook URLs (`/admin/support` etc.). Recommended: redirects forever, so old links in emails and docs still land.
- **OWNER DECISION 3:** Slack from the PHI side does not exist; the Home row and the alert link are the same object, so whichever agent adds Slack to `notifyOps` must use `lib/admin/issue-link.ts`'s URL shape, not a second one.
- The portal's must-never-grow list is not touched: every screen here is `/admin`.

## 6. Open questions (owner)

1. Should synthetic (demo/test) clinics appear in the Clinics list by default, or only behind the "Synthetic" filter?
2. Is `/admin/map` and `/admin/host` under System acceptable, or do you want them one click from Home as today?
3. Do you read the console on a phone (the manifest says yes)? If so the Clinics table collapses to cards under 640 px; otherwise I keep it a table only.
