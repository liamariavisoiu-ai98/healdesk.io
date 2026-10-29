# Gate B piece 3: the L17, L18 and L21 emails, as rendered

For the owner to read. Revised 29 October 2026 after his feedback. Rendered text (fixture clinic Radiance Med Spa, New York time). Each ends with the shared footer (why you get it, reply line, postal address). All carry counts and dates only, so none is `may-carry-phi`. Code: `apps/app/src/lib/email/templates/outage.ts` and `guarantee_miss.ts`. They fire only when the routed/answered counter (another lane) queues them. The plan declared no payload fields, so these are the minimum.

## L17, AYA stopped answering (critical, any hour)

**Subject:** AYA can't answer right now

> AYA has not been able to answer since 9:04 am EDT on Tuesday 6 October, because of a fault at healdesk or one of our suppliers. We are working on it and will keep you updated as soon as it is resolved.

No button, no other facts, no direct line. Field: `startedAt`.

## L18, AYA is back (critical, any hour)

**Subject:** AYA is answering again

Version (a), minimal:

> AYA is answering again as of 9:52 am EDT on Tuesday 6 October. Everything is working normally.

Version (b), recommended: the same, plus one sentence only when a number is not zero:

> AYA is answering again as of 9:52 am EDT on Tuesday 6 October. Everything is working normally.
>
> While she was away, 4 calls rang through to your direct line and 2 people tried to chat.

(Only calls: "While she was away, 4 calls rang through to your direct line." Only chats: "While she was away, 2 people tried to chat." Neither: version (a).)

Version (b) needs two fields, besides `endedAt`:
- `callCount`: phone calls that reached your own direct line instead of AYA during the fault. These are the ones your team had to pick up, or that may have gone unanswered.
- `chatCount`: people who tried to chat with you (website chat, Instagram, Messenger or WhatsApp) during the fault. On your website they saw your contact form; on the apps their message waited for your team.

Recommendation: (b). It adds one line and only when it matters: it tells the clinic whether anyone may be waiting for a reply. Version (a) says nothing about that. If the counter cannot count chats reliably, ship (a) by sending both counts as 0.

## L21, a call or message AYA did not answer (normal, daytime)

What L21 is for: the plan's notice for "a guarantee miss is recorded", sent within the Terms' notice days (`docs/design/funnel-onboarding-portal-2026-10-06.md`, Annex X5).

What the Terms promise (section 5, `apps/web/src/lib/legal.ts`, `GUARANTEE_TEXT`): if during the first month (30-day window from the day AYA first answers a patient; a later channel is covered from its go-live to the end of that window) the assistant fails to answer a call or message routed to it, we refund the first month's subscription fee, not the setup fee. The account owner must claim by emailing us from the account address within the claim window after the first month ends; we tell them our finding in 10 business days and refund within 14 days of a miss. One refund per practice. It is the only remedy for a miss in the first month, and it does not limit the clinic's rights under its Data Agreement. The Terms do not oblige us to tell the clinic about the guarantee when a miss happens, and the email cannot know whether the miss is in the first month.

Alternative A, recommended. **Subject:** A call AYA didn't answer (or "A message AYA didn't answer")

> A call to Radiance Med Spa on Monday 5 October reached AYA, and she didn't answer it. We're sorry. We're looking into why it happened.
>
> If you'd like to talk it through, just reply to this email.

Alternative B. Same subject and first paragraph, then:

> If this was in your first month, our first-month guarantee applies. Reply to this email and we'll go through it with you.

Recommendation: A. It is kind and carries no claim of its own. A clinic that wants to talk replies, and a person on our side can raise the guarantee when it applies (first month). B is more forthcoming, but it would also go to clinics beyond their first month, where it reads as a promise that does not hold, and it makes the apology feel like a claims notice. Choose B if you would rather the clinic hears about the guarantee without having to ask.

Fields: `channel`, `missedOn`. No button: a miss has no portal screen.
