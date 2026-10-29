# Gate B piece 3: the L17, L18 and L21 emails, as rendered

For the owner to read. Rendered text (the snapshot fixture, clinic Radiance Med Spa, New York time). Each email ends with the shared footer (why you get it, the reply line, the postal address). Each is classed as counts and dates only, not `may-carry-phi`. Code: `apps/app/src/lib/email/templates/outage.ts` and `guarantee_miss.ts`.

The plan declared no payload fields for these (they were `never`), so each carries the minimal set: instants, channel ids, counts and one Home link. They fire only when the routed/answered counter (another lane) calls them.

## L17, AYA stopped answering (critical, any hour)

**Subject:** Calls are going to your direct line
(when phone is not affected: "AYA isn't answering right now")

> Since 9:04 am EDT on Tuesday 6 October, AYA hasn't been answering, because of a fault at healdesk or one of our suppliers.
>
> Meanwhile:
> - Phone: calls go to your direct line ((415) 555-0100)
> - Website chat: shows a contact form
>
> We'll email you again as soon as she's answering.
>
> [Open Home]

Fields: `startedAt`, `channels`, `directLineE164`, `homeUrl`.

## L18, AYA is back (critical, any hour)

**Subject:** AYA is answering again

> AYA has been answering again since 9:52 am EDT on Tuesday 6 October. She wasn't answering from 9:04 am EDT on Tuesday 6 October.
>
> Calls sent to your direct line: 4 calls
> Chats sent to your team: 2 chats
>
> [Open Home]

With no calls and no chats: "No calls or chats came in meanwhile."

Fields: `startedAt`, `endedAt`, `callCount`, `chatCount`, `homeUrl`.

## L21, a guarantee miss (normal, daytime)

**Subject:** We missed a call (or "We missed a message")

> A call on your phone on Monday 5 October was routed to AYA and she didn't answer it. That's our miss, and we're sorry.
>
> If this happened in your first month, our guarantee covers it. Reply to this email from your account address and we'll check our records and tell you what we found.

Fields: `channel`, `missedOn`. No button on purpose: the action is a reply, which L30 and Terms section 5 take as the claim, and a miss has no portal screen.

## Open points

- L21 says "first month" because the guarantee is the first month's. Whether it should go after the first month is for the counter lane and the Terms' notice days.
- "Chats sent to your team" is the counter's definition of a chat that fell back; confirm when the counter lands.
