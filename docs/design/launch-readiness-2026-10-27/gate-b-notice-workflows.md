# What happens behind the three "AYA isn't answering" emails

Owner's requirement, 29 October 2026: the emails promise things, so something
real must happen once they are sent. This is what the code does today, in
plain words. Code: `apps/app/src/lib/channels/answer-notices.ts` (the sweep),
`routed-answered.ts` (the counter), `miss-cases.ts` (the cases),
`apps/app/src/lib/portal/missed-contacts.ts` (the 30-day record). Migration:
`apps/app/drizzle/0139_gate_b_counter_workflows.sql`.

## The counter underneath

Every call, website chat and Instagram, Messenger or WhatsApp conversation
that reaches AYA for a clinic is written down as "routed", and then what
became of it: answered, not counted (the clinic paused AYA, switched the
channel off, ran out of allowance, is unpaid, or the caller hung up within 5
seconds), or missed (our side or one of our suppliers failed: a start that
failed, the failure line, an error, a late answer, a process that stopped).
The rules are the first-month guarantee's (Terms section 5). Nothing a caller
said is kept: only the channel, a scrambled reference, the outcome and times.

A sweep runs every minute (and every hour as a backstop). No switch turns it
off, because the emails and the 30-day deletion are promises.

## 1. "AYA can't answer right now" (L17) and the outage

- **When it goes.** AYA has failed to answer everything that reached a clinic
  for ten minutes: the first and the latest failure are at least ten minutes
  apart, with nothing answered in between. A single failure with no traffic
  after it sends nothing.
- **What happens at the same moment.** An outage is opened for that clinic
  (when it started, which channels failed), and the email is queued in the
  same step, so there is never an email without an outage or the other way
  round. You get an ops alert ("AYA has not answered a clinic for ten
  minutes"), in your inbox and Slack.
- **What the clinic reads.** That AYA has not been able to answer since a
  time, that the cause is on our side, that calls ring through to its direct
  line (only if it has one that works), that website chat shows its contact
  form (only if website chat is affected), and that we will email the moment
  it is fixed.
- **Where you see it.** /admin › Queues › Misses and outages: each outage,
  open or closed, its channels, when it started, when you will be reminded.
- **If it is still not fixed.** Two hours after it opened you get a second
  alert ("An outage at a clinic needs a call from you"), then one every
  twelve hours while it stays open. That is your cue to phone or email the
  clinic yourself.

## 2. "AYA is answering again" (L18)

- **When it goes.** AYA has answered something again, and ten minutes have
  passed since that answer with nothing failing on any channel. A failure
  inside those ten minutes starts the clock again, so a flapping fault never
  sends "answering again" early.
- **What happens.** The outage closes, with when AYA answered again and how
  many calls and chats went unanswered while it lasted (counted from the
  counter), and the email is queued in the same step: once per outage, and
  only for an outage that sent L17.
- **What the clinic reads.** That AYA has been answering again since a time,
  and, if anything came in meanwhile, how many calls rang through and how many
  people tried to chat, with a button to its list of missed calls and chats.
- **If an email fails to send.** The outbox tries again on its usual
  schedule, and alerts ops if a critical email (L17, L18) is still unsent. If
  the email could not even be queued, the outage is not opened (or closed),
  the sweep tries again the next minute, and you get one alert ("An answering
  email could not be queued").

## 3. "Looking into a call from <day>" (L21) and the miss case

- **When it goes.** A call or message in a practice's first month (its first
  channel's go-live day and the 29 days after, in its own time zone), on a
  channel that was live at the time, went unanswered by our fault. The day
  must have ended first (plus 15 minutes), so the email goes the next morning,
  well inside the 7 days the Terms promise.
- **The collapse rule.** One email and one miss case per channel per day. A
  burst of missed calls on one day is one case with a count, and one email
  naming the first of them.
- **What happens at the same moment.** A miss case is opened (status open,
  with a "look into it by" day, the next business day), the email is queued in
  the same step, and you get an ops alert ("AYA missed a clinic's call or
  message in its first month").
- **What the clinic reads.** That AYA wasn't able to answer a call (or message)
  at a time, whether it rang through to its direct line (or showed the contact
  form), that we are looking into why and will fix it, and a "See the call"
  button to that one missed contact in its portal. No follow-up email is
  promised and none is sent.
- **What you do.** In /admin › Queues › Misses and outages: Mark looking, then
  Mark explained with a one- or two-line closing note (plain words, no address
  or link), then Close miss case. The closing note is shown to the clinic in its
  portal beside each missed call of that case. It is never emailed.
- **If the clinic replies.** Its reply goes to our support mailbox and opens a
  support case on the Support page, as any clinic email does; the miss case
  shows "the clinic replied", and a second reply to the same email joins the
  same support case. A reply is matched by its subject ("Looking into a call
  from <day>") and the clinic's own sign-in address.
- **A miss can also mean a refund** under the first-month guarantee if the
  account owner claims it; that stays the Billing tab's "Refund under Terms § 5".

## The 30-day missed-contact record (owner-approved)

- For each call or chat that reached AYA and that she did not answer, the
  clinic's portal keeps: when, the channel, the caller's number if we had it,
  where it went (direct line, contact form, nowhere, or not known), a "Called
  back" tick the clinic sets, and your closing note when there is one. Nothing
  the caller said, no audio, no transcript.
- Kept 30 days after the miss, then deleted automatically (every minute by
  the sweep, and nightly by the retention purge). Deleted with the clinic's
  data at destruction. A person's erasure takes their missed calls by their
  number. A person's export, and the clinic's export, include them. Correcting
  a contact's details does not change these rows: they record the number the
  call came from.
- In the portal: Home shows "Needs your attention" while AYA is not answering
  or a missed call or chat is waiting for a call back (counts only). The list
  is at `/c/<slug>/missed` and one missed contact at `/c/<slug>/missed/<id>`,
  both behind the passkey, and every open is written to the access log naming
  the passkey.
- Privacy page section 6 says so (legal version 2026-10-29.5).

## What the owner must do

- Nothing to switch on: the sweep runs whenever the worker runs.
- Watch for the four alerts; follow each outage to closed and each miss case
  to closed in /admin › Queues › Misses and outages.
- The emails send only while the outbox's own switch is on, as every email.

## Not built, or not tested here

- A call that never reached our endpoint (our host fully down) is not counted:
  Retell's own call log is not read.
- The portal pages render behind a real passkey session, which the tests here
  do not drive; the database reads and the access-log rule are tested.
- The whole inbound path (a real email through SES and S3) is not driven; the
  reply-matching functions are tested against the database.
