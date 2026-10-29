# Gate B piece 3: the L17, L18 and L21 emails, as rendered

Final text after the owner's decisions of 29 October 2026. Fixture clinic Radiance Med Spa, New York time. Each ends with the shared footer (why you get it, reply line, postal address). All carry counts and dates only, so none is `may-carry-phi`. Code: `apps/app/src/lib/email/templates/outage.ts` and `guarantee_miss.ts`. They fire only when the routed/answered counter (another lane) queues them. The plan declared no payload fields, so these are the minimum. Written emails say "AYA" (the spelling "Aya" is for spoken text only).

## L17, AYA stopped answering (critical, any hour)

**Subject:** AYA can't answer right now

> AYA has not been able to answer since 9:04 am EDT on Tuesday 6 October, because of a fault at healdesk or one of our suppliers. We are working on it and will keep you updated as soon as it is resolved.
>
> [Open Home]

Fields: `startedAt`, `homeUrl`.

## L18, AYA is back (critical, any hour)

**Subject:** AYA is answering again

> AYA is answering again as of 9:52 am EDT on Tuesday 6 October. Everything is working normally.
>
> While she was away, 4 calls rang through to your direct line and 2 people tried to chat.
>
> [Open Home]

The second sentence appears only when a count is above zero, and names only the non-zero part. Fields: `endedAt`, `callCount` (calls that reached the direct line during the fault), `chatCount` (people who tried to chat on the website, Instagram, Messenger or WhatsApp during the fault), `homeUrl`.

## L21, a call or message AYA did not answer (normal, daytime)

Recommended subject: **We're looking into a call** (a message: "We're looking into a message")

> AYA wasn't able to answer a call to Radiance Med Spa at 2:10 pm EDT on Monday 5 October. We're looking into why, so it doesn't happen again.
>
> If you'd like to know more, just reply to this email.

No button (a miss has no portal screen) and no mention of the guarantee. Fields: `channel`, `missedAt`.

Five other subjects, none negative (say "call" or "message" to match the channel):

1. A note about a call
2. Following up on a call
3. A quick note about AYA
4. Looking into a call from Monday 5 October
5. AYA and your call on Monday 5 October

Why the recommended one: it says plainly what we are doing, it is calm, and it does not accuse anyone or repeat the failure in the inbox line. Number 4 or 5 are the choices if you want the day in the subject. Changing the subject is one line in `guarantee_miss.ts`.
