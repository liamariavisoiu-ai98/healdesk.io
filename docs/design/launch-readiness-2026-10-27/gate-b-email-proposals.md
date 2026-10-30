# Gate B piece 3: the L17, L18 and L21 emails, as rendered

Final owner copy of 29 October 2026. Fixture clinic Radiance Med Spa, New York time. Each ends with the shared footer (why you get it, reply line, postal address). All carry counts, dates and our own portal links, so none is `may-carry-phi`. Code: `apps/app/src/lib/email/templates/outage.ts` and `guarantee_miss.ts`. They fire only when the routed/answered counter (another lane) queues them. No follow-up email is promised beyond L18. Written emails say "AYA".

Payload keys are named to pass the allowlist in `lib/email/lint.ts`: its boolean keys must start with is, has, was, can or will, so the owner's `callsReachDirectLine`, `chatAffected` and `reachedDirectLine` are `canReachDirectLine`, `isChatAffected` and `wasRoutedToDirectLine`.

## L17, AYA stopped answering (critical, any hour)

**Subject:** AYA can't answer right now

> AYA hasn't been able to answer since 9:04 am EDT on Tuesday 6 October due to a connectivity error. We're working on it now.
>
> In the meantime, calls are ringing through to your direct line, so please keep it staffed.
>
> We'll email you the moment it's fixed.
>
> [Open Home]

The cause always reads "a connectivity error", whatever the underlying cause (owner). The "In the meantime" sentence appears only when `canReachDirectLine` is true. When `isChatAffected` is true, "Website chat visitors are being shown your contact form." is added (alone, it has no "In the meantime"). Fields: `startedAt`, `canReachDirectLine`, `isChatAffected`, `homeUrl`.

## L18, AYA is back (critical, any hour)

**Subject:** AYA is answering again

With something in the meantime:

> AYA has been answering again since 9:52 am EDT on Tuesday 6 October.
>
> While she was away, 4 calls rang through to your direct line and 2 people tried to chat.
>
> [See what came in]

(A zero part is left out, and singular reads "1 call" and "1 person tried to chat".) With nothing in the meantime:

> AYA has been answering again since 9:52 am EDT on Tuesday 6 October.
>
> Everything is working normally.
>
> [Open Home]

Fields: `endedAt`, `callCount` (calls that reached the direct line during the fault), `chatCount` (people who tried to chat on the website, Instagram, Messenger or WhatsApp), `homeUrl`, `missedUrl` (the portal list of what came in).

## L21, a call or message AYA did not answer (normal, daytime)

**Subject:** Looking into a call from Monday 5 October (a message: "Looking into a message from Monday 5 October")

> AYA wasn't able to answer a call at 2:10 pm EDT. It rang through to your direct line. We're looking into why and will fix it so this doesn't happen again.
>
> [See the call]

"It rang through to your direct line." appears only when `wasRoutedToDirectLine` is true. For website chat it reads "Your contact form was shown instead."; for Instagram, Messenger and WhatsApp it says nothing about where the message went. No guarantee, no "sorry", no reply line. Fields: `channel`, `missedAt`, `wasRoutedToDirectLine`, `missedUrl`.

## The links

`missedUrl` is built upstream with `publicUrl` by the routed/answered counter (`lib/channels/answer-notices.ts`, `missedPath`): for L18 the portal's missed list, `/c/<slug>/missed`; for L21 that one missed contact, `/c/<slug>/missed/<missed contact id>` (the list only when the contact's 30-day record is already gone). The fixtures use the same paths.
