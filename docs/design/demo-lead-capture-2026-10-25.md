# Lead capture on a demo call that does not close (design note, not built)

Status: proposal for the owner's decision, 25 October 2026 (VOICE-T15, phase 4).
Nothing here is built. It changes what a demo call keeps, so it needs the
owner's yes and the Privacy page change below before any code.

## The problem

A demo call that ends without a sale leaves nothing behind. The engine demo
keeps no transcript, no number and no record of any kind for a prospect's
call (CLAUDE.md, "The three cases that catch people out", 2; the Privacy
page, section 6, "How long we keep it": "The demo call itself: no recording or transcript is kept
by us or by our voice provider"). Only an operator's own test call emails a
transcript to hello@. So an owner like Josh, who was interested but not
ready, is lost the moment he hangs up. Recovering even a fraction of those
calls is likely worth more than any script fix, because it works on every
call that does not close.

## What exists already

- `apps/web` `/api/voice-demo/follow-up`: the old Retell-hosted demo agent's
  one way to reach a person. It takes an email address (never a phone
  number), emails the owner the setup link or emails hello@ the request,
  and records the opt-out on the lead's row. The note it sends hello@ ends
  "Do not phone them: the number on a demo call was given for that call
  only."
- The lead store (`apps/web/src/lib/leads.ts`): rows in the marketing
  Sheet's `leads`, `lead_events` and `call_consents` tabs, keyed on the
  email, purged on a schedule (`purgeStaleLeads`, `purgeStaleCallConsents`).
- The Privacy page already allows "A follow-up you asked for on the demo
  call: as ordinary email correspondence, until the request is answered and
  closed."

## Proposal

1. **On the call.** When the owner hesitates at the close or asks for a
   person, Aya offers: "Want someone from our team to give you a quick call?
   What's the best number?" She repeats the number back once to confirm, and
   asks for one line of context ("what should they come prepared with?").
   She says nothing about the team having been told until the delivery
   below has succeeded within the call (the same rule as
   `lib/support/escalate.ts`: never tell someone a person will reply to a
   request no person received).
2. **The signal.** Her structured state update gains a `callback` entry:
   `{ "phone": "...", "note": "..." }`, read and checked by the session (the
   number normalised to E.164 and refused if it is not a plausible phone
   number; the note cut to one short line). This is the same structured
   channel as `asked` and `beats` (VOICE-T15, phase 2), never her prose.
3. **Where it goes.** Business contact data, not PHI: the person is a clinic's
   owner talking about their own business. So it belongs on the no-PHI side,
   in the marketing Sheet with the rest of the leads, not in apps/app's
   database. apps/app sends one signed request to apps/web the moment the
   number is confirmed (HMAC with `HEALDESK_PROVISION_SECRET`, as the demo's
   own context is sealed), carrying: the demo's slug, the clinic's name, the
   requester's first name, the number, the one-line note, the discount
   window left, and the time. Never the transcript and never anything else
   said on the call.
4. **Delivery to sales.** apps/web appends a `lead_events` row ("callback
   requested") against the demo's lead (the demo already has the requester's
   email from the demo request), stores the number on a new `callback_phone`
   column, and emails hello@ through Resend (business mail, from hello@ as
   all mail is) with those fields and a link to the demo in `/admin`. Aya
   only says "someone will call you" once apps/web has answered 2xx; on any
   failure she gives hello at healdesk dot io instead, as today.
5. **What persists, and for how long.** The number and the one-line note on
   the lead row, as ordinary sales correspondence, until the callback is
   marked done in `/admin` or 30 days pass, whichever comes first; then the
   number and the note are cleared by the existing purge job (a new rule in
   `purgeStaleLeads`). The verbal consent ("yes, call me on ...") is recorded
   in `call_consents` with the consent wording version, as the "Call us"
   button's consent already is, and kept as long as that tab's other rows.
   No recording, no transcript, no other words from the call.

## What it changes, and what has to change with it

- **The Privacy page** gains a line in section 2 ("If you ask for a call
  back on a demo call: the number you give and one line about what you'd
  like to discuss, kept until we have called you or for 30 days") and in
  section 6's retention list. It must ship in the same change, before the
  feature is switched on (CLAUDE.md, "Copy first, then the switch").
- **The "Do not phone them" note** in `voiceFollowUpInternal` stays for the
  email follow-up; a callback request carries its own wording: "They asked
  to be called on this number about this, and nothing else."
- **The CLAUDE.md demo paragraph** ("keeps nothing") gains the exception:
  a callback number and one line, only when the owner asks for a call,
  delivered as a lead.
- **Calling rules.** A call back to a business number the owner gave and
  asked to be called on is a requested call, not a cold one; it still must
  be made within the hours the owner gave, and the consent record must say
  what was asked for. Counsel should confirm the wording once.
- **`/admin/map`** gains the bridge apps/app → apps/web for demo callbacks,
  and `LAUNCH_PROMISES` an item until it is on.

## Decisions for the owner

1. Build it? (Recommended: yes, it recovers value from every call that
   does not close.)
2. Keep the number 30 days, or until called, or both (recommended: both,
   whichever first)?
3. Email hello@ only, or also ping an operator's phone (an SMS to our own
   staff is not patient contact, but it is a new vendor and a new key)?
