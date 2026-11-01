# Aya is only a receptionist: the audit and the change

Task DEMO-RECEPTIONIST-1. Owner, 1 November 2026: "Remove the sales pitch
completely. Aya is now only a receptionist. Audit and make the adjustment",
with a receptionist brief (role and tone, day-of-the-week pleasantries,
validating a choice, verbal nods, empathy for a time of day, human words for a
pause). His answers to three questions the same day:

1. **Scope:** demo and real calls. One Aya: the manner is in the shared voice
   prompt, so a clinic's own patient calls have it too.
2. **Demo start:** straight to the front desk. No intro, no owner questions,
   no call-back offer.
3. **Conflicting lines:** keep the warmth, in true words.

## What the audit found

The pitch ran through the whole demo call:
- the sales prompt (`demoSalesPrompt`, its nine examples and value points);
- the intro and pitch notes (discovery questions, buying signals, the close,
  the live discount, healdesk's price list);
- the recovery lines for the owner;
- the signature quirks;
- the call-back offer and its sender to apps/web;
- the owner listener;
- the role-play's start, stop, restart and exit moves;
- 30-odd regression cases and the owner-persona eval with its workflow.

The receptionist prompt (`prompt.ts`) was already shared by the demo's
role-play and every clinic's patient calls.

## What changed

| | Before | Now |
|---|---|---|
| Demo opening | "Hi! This is Aya, the AI assistant for <clinic>... Who am I speaking with?" | "Thanks for calling <clinic>, this is Aya, the AI assistant, and this call's transcribed. How can I help you today?" |
| Demo call | Intro, then a role-play, then the pitch and close | The clinic's front desk from start to goodbye; the call ends on the caller's goodbye |
| Sales prompt, pitch notes, prices, discount, call-back offer, listener, quirks, role-play moves | In the call path | Removed, code and tests |
| Demo cases and owner-persona eval (`voice-eval:demo`, `demo-eval.yml`) | Ran on every demo change | Removed; plan task `DEMO-EVAL-LIVE` withdrawn |
| Booking checks from c4093be6 (hours, free times, name and number before "the request is in", cancelled never pending, healdesk's words refused, provider-named refusals, the clinic's number in the urgent line) | In the role-play | Kept, now for the whole demo call; a goodbye goes from a reply still asking for details |
| Receptionist manner | Not in the prompt | `RECEPTIONIST_MANNER` in the voice prompt, for demo and clinic calls; the practice's providers are now listed in the prompt so she can name them |

## His lines, and where they were changed to stay true

| His line | Now | Why |
|---|---|---|
| "I hope your week is off to a great start so far! Let me pull up our calendar right now..." (Mon/Tue) | "I hope your week's off to a great start! Let me pull up our calendar..." | Kept; once a call, only when she is about to look for times |
| "Happy [Thursday/Friday]! Let's get this taken care of so you can head into the weekend..." | "Happy Thursday! Let's get this sorted so you can head into the weekend. Let me see what we have open..." | Kept; other days: "Let me pull up our calendar..." |
| "Morning slots are actually our most popular..." | "Mornings go quickly, so I'm glad we could grab this one for you!" | No popularity claim stated as the clinic's fact |
| "Oh, [Name] is absolutely fantastic, you are going to love working with them." | "You'll be in great hands with [provider]." | No outcome promise; only a provider on the clinic's list |
| "Perfect, I have you locked in for that slot. Can I just confirm your email address?" | "Perfect, let me put that in for you. Can I get your full name?" | Nothing is booked by her words (the guard refuses "locked in"); a call takes the details the booking needs, not an email |
| "Saturdays are incredibly popular..." | "Saturdays go fast, so let's see if we can snag one for you." | Same as the morning line |
| Late afternoon, verbal nods, human pauses | As written | No change needed |

Every quoted line of the manner passes the guard on a demo clinic's facts,
and the test `voice-demo-roleplay-moves.test.ts` holds it.

## Not changed, for the owner

- The website-chat demo prompt (`apps/web/src/lib/demo/clinic-prompts.ts`) is
  already receptionist-first; it answers questions about healdesk only if
  asked.
- The apps/web end of the old call-back (`/api/voice-demo/callback-request`,
  the Sheet's `demo_callbacks` tab) is unused now. It is left as it is,
  because the tab is a record. Remove it at your word.
- The demo page's own words are the owner's design and untouched.

## Made-up values for what the website did not show (same day)

The owner, 1 November 2026: "if the website doesnt offer calendar, stripe,
prices the demo should 'invent them' just to show them the dream outcome.
There should be a visible disclaimer saying this wasn't available so we
invented this for demo purposes."

| Not found | Made up for the live demo |
|---|---|
| A price for a treatment | A sample price by kind of treatment ("$14/unit" for Botox, "from $650" for filler, "$199" for a HydraFacial; "from $150" otherwise) |
| Any treatment | A sample menu for the kind of practice (med spa, dental, vet, massage and chiro, GLP-1, hair) |
| Opening hours | Monday to Friday, 9 to 6 |
| A deposit or cancellation rule | "A $50 deposit holds each appointment and comes off the treatment price. Cancel or move it at least 24 hours ahead to keep the deposit." |
| The calendar (never connected in a demo) | The free times Aya offers, from the hours |

- **Never made up:** the address, the phone number or the team, which a
  caller would act on.
- **Where it applies:** in `apps/web/src/lib/demo/samples.ts`
  (`withDemoSamples`), at the chat route, the three voice routes and the
  demo page. It is never applied to the stored profile, so the build's
  audit, which checks the profile against the website, never takes a sample
  for something the reader invented.
- **The disclaimer:** the page's note above the voice and chat cards, now
  headed "Made up for this demo", lists each made-up item. Then, under
  "Still not found", it lists what nothing replaced.
- **What the voice receives:** the sample values inside the sealed clinic
  profile, so `apps/app` needed no change.
- **The deposit on a call:** voice still never takes a payment. The sample
  rule names a deposit, and Aya flags it as on any call.
