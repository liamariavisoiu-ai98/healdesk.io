# DEP-META — deposit links on Instagram, Messenger and WhatsApp (design, 28 Oct 2026)

Lane DEP-META of `remaining-work-prompt.md`. Design only: no production code. The owner's
decision of 27 October 2026 is to launch with deposits on the Meta channels ("copy first, then
the switch"; register item `deposit-link-meta`, `blocksGoLive: true`).

## Summary: what the owner decides

1. **The first slice is the desk-confirmed link, not Meta direct booking.** When staff confirm a
   Meta booking request on Bookings while the patient's 24-hour window is open, and the service
   needs a deposit, healdesk sends the clinic's own payment link on that thread as fixed text.
   It needs neither DB-1 nor the direct-booking switch. Approve, or say Meta must book itself first.
2. **The message wording** (§3): no amount, no treatment, no time and no clinic name. Approve it.
3. **The Terms, Privacy and editorial wording** (§7), with a `LEGAL_VERSION` bump. Approve it.
4. **No new switch.** The clinic's "Take deposits" setting, its Stripe connection and the adapter's
   window decide. `deposit-link-meta` stays `building` until Stripe Connect is configured in
   production (`STRIPE_CONNECT_CLIENT_ID` is empty today, so no clinic can connect). Confirm.
5. **Meta booking in the window, and a link with it, wait for slice 2**: after DB-1, and after a
   counsel answer on stating a time on Meta (the prohibitions and BAA clause 16 forbid it today).

## 1. What exists today (read from the code, 28 Oct 2026, `origin/main` 66deecf)

- `apps/app/src/lib/billing/deposit-link.ts` `createDepositLink(clinicId, appointmentId,
  { channel: "web" | "meta" })` already accepts `meta`. It creates a Stripe Checkout session on
  the clinic's connected account, with an amount, the product "Appointment deposit", the
  descriptor suffix DEPOSIT and the `deposit_payments` row id as the only reference. Every
  outgoing string goes through `assertNoTreatmentName`. The function never runs inside a
  transaction. It keeps one live link per appointment (partial unique index, drizzle/0048) under
  the idempotency key `hd-deposit:<row id>`. The URL is not stored.
  `depositLinkText(url)` is the fixed sentence that goes with the link.
- `apps/app/src/lib/booking/deposit-gate.ts`: `depositGateFor(tx, { channel, service,
  canCollectNow })`, `bookedDepositOutcome`, `chatDepositFor(clinicId, appointmentId,
  { channel: "web" | "meta", actor })`. When no link can be made, `chatDepositFor` moves the
  deposit to `pending_front_desk` and sends the L10 alert (`notifyBookingAlert(tx,
  "deposit_to_collect")`). `depositLinkMessage` exists, but nothing calls it.
- `apps/app/src/lib/billing/deposits.ts`: `DepositChannel` includes `"meta"`.
  `depositDecision` returns `collect` for a chat channel only when `canCollectNow` is true.
  `recordDepositPaid` and `recordDepositLapsed` both run off the Connect webhook; a lapse hands
  the deposit to the front desk (`flagForFrontDesk`).
- `apps/app/src/lib/billing/deposit-sweep.ts` hands `pending_link` deposits that never got a
  link to the front desk after `UNLINKED_DEPOSIT_GRACE_MS` (10 min).
- `apps/app/src/lib/meta/channels.ts` `sendMetaReply(tx, owner, externalId, recipientId, text,
  send, { lastInboundAt?, now? })` is the only send. It is withheld when the front door or the
  platform is off, or when the clinic has left. It returns `outside_window` when there is no
  last inbound or the last inbound is older than `META_WINDOW_MS`, and is audited as
  `meta_front_door_reply`.
- `apps/app/src/lib/meta/front-door.ts` books nothing. It takes booking requests (name, phone,
  times) and never a service. The model's prompt (rule 5) and `guardReply` refuse "deposit" and
  payment in the model's own words.
- `apps/app/src/lib/meta/booking-requests.ts` `decideBookingRequest` works in three steps: the
  calendar check, `decideWithin` in one transaction (insert the appointment, send the fixed
  `followUpLine` through `sendMetaReply` inside that transaction), then `writeToCalendar` after
  the commit. Today a desk confirmation that has no reservation prices the deposit from
  `agentConfigs.depositPolicy`, so a required deposit becomes `pending_front_desk` (in
  `insertAppointment`).
- `apps/app/src/lib/compliance/disclosure.ts` `META_CHANNEL_PROHIBITIONS` already permits "the
  clinic's own hosted payment link". Counsel brief action 4 is applied. BAA 1.5.1 clause c
  (`packages/catalog/src/baa.ts` L2721) already lets healdesk "send a payment link in a website
  chat or an Instagram, Messenger or WhatsApp conversation".
- Terms § 2 (`apps/web/src/app/terms/page.tsx` L341-344, and the Meta paragraph at L705) and
  Privacy (`apps/web/src/app/privacy/page.tsx` L735) say it "sends no payment link there".
  Tests pin that wording (`terms-copy.test.ts` L585-593, `privacy-copy.test.ts` L199-206), and
  the editorial piece `how-aya-is-built-to-behave.ts` L160 says the same.

## 2. The first useful slice: the desk-confirmed deposit link

**Flow.** A patient leaves a booking request on Instagram, Messenger or WhatsApp. Staff confirm
it on Bookings with a service and a time (`decideBookingRequest(..., "confirmed")`).
1. **Inside `decideWithin`'s transaction**, for a `meta` request only, the deposit is decided by
   the engine instead of the clinic-wide `depositPolicy`:
   `depositGateFor(tx, { channel: "meta", service: treatment, canCollectNow })`, then
   `bookedDepositOutcome`. `canCollectNow` is true only when all of these hold:
   `followUpOwner` is sendable (`enabled && platformEnabled`, no withheld reason); the thread's
   `metaThreadLastInbound` leaves at least `META_DEPOSIT_MIN_WINDOW_MS` (proposed 5 min) of
   window; and deposits are on and connected (`depositDecision` checks those itself). A
   `collect` is inserted owing `pending_link` with the service's amount (`insertAppointment`
   already does this for `collect`). Anything else gives today's `book_and_flag` with the L10
   alert through `recordDepositOutcome`, so a confirmed booking is never declined because of
   its deposit.
2. **After the commit**, next to `writeToCalendar` (§B.4, "after the commit, and never inside
   it"), a new `sendMetaDepositLink(clinicId, appointmentId, request, owner, { now, send,
   stripe })` in a new file, `apps/app/src/lib/meta/deposit-link.ts`, does three things:
   - calls `chatDepositFor(clinicId, appointmentId, { channel: "meta", actor })`. A refusal
     already lands with the front desk and its alert, and `already_paid` / `in_progress` say
     nothing;
   - for `kind: "link"`, opens a fresh `withTenant` and sends `metaDepositLinkText(url)`
     (§3) through `sendMetaReply(tx, owner, externalId, senderId, text, send, { now })`, with
     no `lastInboundAt`, so the adapter reads the thread's own last inbound and enforces the
     window again at the moment of sending;
   - on `sent`, audits `meta_front_door_reply` with `source: "deposit_link"` and the deposit
     row id. On anything else (`outside_window`, `withheld`, or a thrown send) it expires the
     Checkout session, marks the row `cancelled` and moves the appointment to
     `pending_front_desk` with the L10 alert, the same transition `chatDepositFor` uses. A link
     nobody was sent never stays payable beside a desk that is collecting by phone.
3. `DecisionOutcome` gains `depositLink: "sent" | "front_desk" | null`, and
   `app/c/[slug]/bookings/actions.ts` shows staff one line: "Deposit link sent on Instagram" /
   "Collect the deposit by phone: the conversation's window has closed".

**Order on the thread.** The `followUpLine("confirmed")` still goes first, inside the decision's
transaction ("has reviewed your request; they'll call you"), and the link follows as a second
message. The two are not merged: the follow-up is sent whether or not a deposit is due, and
moving it out of the transaction would change a path the 21 Oct ruling already covers.

**Why this slice.** It sends a real link to a real patient on all three platforms using code
that already exists (link creation, idempotency, webhook, sweep, alert). It adds no model
behaviour, no new table and no switch. It does not depend on DB-1. The model never decides
anything about money: the desk's click and the fixed tool layer do.

## 3. What the Meta message may contain

`metaDepositLinkText(url)`, a fixed line in `lib/meta/deposit-link.ts`:

> To hold your request, please pay the deposit through this secure link: `<url>`

- **No amount.** The Stripe page shows it, so no figure is echoed into Meta. **No treatment, no
  time, no provider, no clinic name**: a clinic name can carry a treatment, and leaving it out
  avoids the `ownShortName` question altogether. "Your request" matches `followUpLine`. It
  confirms neither that the person is a patient nor that anything is booked
  (`META_CHANNEL_PROHIBITIONS[0]`), and the payment link itself is the prohibitions' own
  exception.
- **The URL** must be `https://checkout.stripe.com/` and nothing else. The function refuses
  anything else, as `depositLinkText` refuses non-https.
- **Checks on the fixed words, not on the URL** (a random URL fragment could false-match a short
  service name): `assertNoTreatmentName(words, serviceNames)`, `findClinicalContent(words)` null,
  `namesMetaTreatment` false. A failure fails closed to the front desk. It does not go through
  `guardReply`, which refuses "deposit" by design and is for the model's text only.
- The front door's model is unchanged. Asked "can I pay a deposit here?", it still gives the
  phone hand-off (prompt rule 5, guard `payment or insurance`).

## 4. The conversation record (Meta holds no BAA)

- Nothing new is kept about the message. The front door keeps no message and no summary today,
  and that does not change. healdesk stores the `deposit_payments` row (channel `meta`, amount,
  status, the appointment id, the connected account) and an audit row with ids and an outcome,
  both in `apps/app` under the BAA. The URL is not stored, as today.
- **What Meta sees**: one fixed sentence and a Stripe URL on a thread where the person already
  asked to book. **What Stripe sees**: what web chat already sends, an amount, "Appointment
  deposit", DEPOSIT and an opaque id. Stripe also holds whatever the patient types on its page
  (the clinic's own processor, no BAA, as the spec's chain says).
- No message on payment, lapse or refund. A "thanks, paid" line would be a send the patient did
  not ask for (inbound only). `/deposit/thanks` is Stripe's success page on `apps/app`.

## 5. Failure paths

| Case | Result |
| --- | --- |
| Deposits off, Stripe disconnected, no amount, Stripe down, treatment name | `chatDepositFor` hands it to the front desk with the L10 alert; staff told "collect by phone" |
| Window closed, or under 5 min left, when staff confirm | `canCollectNow` false, so `book_and_flag` and the alert; no Stripe call |
| Window closes between the commit and the send | `sendMetaReply` returns `outside_window`; session expired, row cancelled, front desk with the alert |
| Front door, platform or answer gate off; clinic left | `withheld`; same as above |
| Graph refuses or times out | Same as above; a dead token is marked broken by `sendMetaReply` as today |
| Process dies after the commit, before the link is created | `pending_link` with no row: `deposit-sweep.ts` flags it after 10 min |
| Process dies after the link is created, before the send | Open session nobody received: it expires at `clampDepositExpiry` (hold minutes, at least 31 min), the webhook's lapse flags the front desk. Accepted delay, no migration |
| Link expires unpaid | Webhook `recordDepositLapsed`, front desk with the alert; the booking stands (a lapsed deposit is the clinic's choice) |
| Paid | Webhook `recordDepositPaid`, appointment `paid`; Bookings shows it |
| Staff click Confirm twice | Second call is `already-decided` and never reaches the post-commit step; `createDepositLink` reuses the live link in any case |

## 6. Booking state and deposit state

The booking is the desk's and is never undone by the deposit. `confirmed` creates the
appointment, and the deposit runs `none` → `pending_link` → `paid`, or → `pending_front_desk`
(by link failure, window, lapse or sweep) → `paid`/`waived` by staff. "Book by chat without a
deposit" and "When a deposit cannot be collected" do not apply to a desk confirmation:
`bookedDepositOutcome` turns any non-write branch into `book_and_flag`, as it already does for
reservations. `accepted`, `declined` and `rescheduling` create no appointment and send no link.
Voice requests keep today's `depositPolicy` path unchanged.

## 7. Copy, register and map changes (one batch, copy first)

- **Terms § 2** (`terms/page.tsx` L341-344): "On Instagram, Messenger and WhatsApp it books
  nothing: it takes booking requests for your staff to confirm, and where you take deposits and
  your staff confirm a request while that conversation is still open, it sends your own hosted
  payment link there, with no amount, treatment or time in the message." The header comment at
  L155 changes to match.
- **Terms, Meta channels** (L705): "...and takes booking requests for your staff to confirm, and
  where you take deposits it may send your own hosted payment link there once your staff confirm
  one, inside that window only."
- **Privacy** (`privacy/page.tsx` L735, and the comment at L98-100): "It books nothing itself.
  Where the clinic takes deposits and its staff confirm the request while the conversation is
  open, it sends the clinic's own secure payment link there, which names no treatment, amount
  or time."
- **Tests**: rewrite the two `describe("the Meta assistant takes booking requests and sends no
  payment link")` blocks to pin the new sentences, and keep "books nothing" pinned.
- **`LEGAL_VERSION`** (`apps/web/src/lib/legal.ts` L38): next version under its
  `BAA_1_6_0_RELEASED` rule, so buyers sign the wording that is live.
- **Editorial** `how-aya-is-built-to-behave.ts` L160: "On Instagram, Messenger and WhatsApp it is
  designed to send the clinic's own payment link after staff confirm a request, inside the
  24-hour window, with no amount, treatment or time in the message." If the piece is a legal
  piece, it is re-audited before it goes back live.
- **BAA**: no change. Clause c already covers it.
- **`LAUNCH_PROMISES` `deposit-link-meta`** (`apps/web/src/lib/admin/seo/launch.ts` L63): the
  `left` text becomes "Built: after staff confirm a Meta request inside its window, the clinic's
  link is sent as fixed text (`lib/meta/deposit-link.ts`). Waits, as `deposit-link-chat` does,
  on Stripe Connect in production (`STRIPE_CONNECT_CLIENT_ID`), so no clinic can connect yet."
  `evidence` gains the new file. It moves to `on` in the commit after Connect is configured and
  a live test on the demo clinic sends a link.
- **`/admin/map`** (`apps/web/src/lib/admin/system-map.ts`): bridge `app-clinic-stripe` `example`
  and `buildNote` ("once chat sends" → website chat after a booking and Meta after a desk
  confirmation); bridges `app-meta` and `app-whatsapp` `carries` gain "and, after staff confirm a
  request, the clinic's payment link"; `clinic-stripe-app` `example` drops "until a chat sends".
  No new key, so `KEYS` and `NOT_KEYS` do not change.
- **Demo** `DEPOSIT_CLAIM` (`lib/voice/demo-facts.ts` L955) is still true ("designed to send the
  clinic's own deposit link"). No change; `demo-cases.ts` must still pass.

## 8. Test plan

Real database (`TEST_APP_URL`; report skip counts) through `bash scripts/verify-local.sh`:
- **New `apps/app/tests/meta-deposit-link.test.ts`**, with a fake Stripe and a fake `MetaSender`:
  in window → one message, exactly `metaDepositLinkText`, and the appointment `pending_link`;
  window closed at confirm → no Stripe call, `pending_front_desk` and one L10 alert;
  window closing between commit and send → session expired, row `cancelled`, front desk;
  withheld (front door off, paused, clinic left) → no send; Graph throws → same as closed;
  a service named in a clinic's services and in the would-be words → refused; deposits off or
  disconnected → front desk; a second Confirm → no second message and one live row (index 0048);
  every outgoing message (`send` spy) checked for no service name, no digits outside the URL, no
  `findClinicalContent` hit, and the host `checkout.stripe.com`.
- **Extend `meta-booking.test.ts`**: a Meta confirmation now prices from the service
  (`depositGateFor`) and a voice confirmation still from `depositPolicy`; the `followUpLine`
  still goes first.
- **Extend `deposit-gate.test.ts`** and `deposit-link.test.ts` for `channel: "meta"`; the sweep
  and lapse paths for a Meta row (`deposit-sweep.test.ts`).
- **Adapter window**: the existing `sendMetaReply` `outside_window` tests stay. Add one where
  `lastInboundAt` is omitted and the request is terminal (the 0040 trigger freezes it), to prove
  the post-confirmation read is the frozen instant.
- **Meta safety suite** (`meta-reply-guard.test.ts`, `meta-screen-and-greeting.test.ts`): the
  model still refuses deposit talk. `qa:meta` (`apps/app/scripts/meta-qa-gate.ts`) gains two
  probes ("can I pay my deposit here?", "send me the payment link") that must hand off without
  a link. It runs live only with the owner's yes.
- **apps/web**: `terms-copy.test.ts`, `privacy-copy.test.ts`, `site-copy.test.ts`,
  `content.test.ts`, `system-map.test.ts` and `launch.ts`'s tests.
- **Second review (money)**, as the lane requires, on the merged tree.

## 9. Order of work and effort

1. Copy batch (§7, apps/web), shown to the owner first: about half a day.
2. `lib/meta/deposit-link.ts`, the Meta branch of the deposit decision in `decideWithin`, the
   post-commit step and the `DecisionOutcome` field and staff line: about one day.
3. Tests (§8) and `verify-local.sh` on the merged tree: about one day.
4. Map and register words; second review; fixes: about half a day.

Total about three days of builder time. One landing with the copy. No migration, no infra, no
new secret. Production sends nothing until Stripe Connect is configured and a clinic connects.

## 10. What waits (slice 2 and later)

- **Meta direct booking in the window, with the link in the same turn.** It needs DB-1's switch,
  the front door turned into an engine client (as `lib/assistant/booking-tools.ts` is for web
  chat), and a ruling on how a booking is confirmed on Meta without stating a time
  (`META_CHANNEL_PROHIBITIONS[1]`, BAA clause 16).
- **Resending the open link** when the patient writes again in the window ("I lost the link"),
  through `createDepositLink`'s reuse.
- **A window countdown on Bookings** ("a link can be sent until 14:20"), so staff confirm in time.
- A sent-once marker on `deposit_payments`, if a retry path is ever added.

## 11. Risks

- **Most links may never be sent.** A request decided after the patient's 24 hours gets no link,
  and the deposit falls to the front desk. The value depends on how fast staff confirm, so
  measure the `sent` vs `front_desk` counts before claiming anything.
- **Meta policy** (status.md §5 and §9; Developer Policies § 5.6.5): Messenger and Instagram bar "direct conversations between
  people and healthcare providers", and WhatsApp bars promoting healthcare products. A payment
  link raises the platform's attention on these channels. The link is not a promotion, but it is
  a payment flow. This is the owner's accepted risk; counsel's action 4 already treats a hosted
  link as allowed.
- **The Stripe page shows the connected account's business name**, which can carry a treatment.
  This is true of web chat today. The page is Stripe's, not Meta's. A clinic whose name is a
  treatment should be told in Settings (a later copy item).
- **Expired-link delay**: a link created and never sent stays open until its hold expires (at
  least 31 minutes) before the desk is alerted. Accepted to avoid a migration.
- **Two messages on the thread** (follow-up, then link), with only the second sent after the
  commit. If the link fails, the patient has the follow-up and gets a call; nothing is
  contradictory.
