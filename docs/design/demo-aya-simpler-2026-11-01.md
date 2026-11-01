# A simpler Aya: lower latency, more human (proposal, with the latency part built)

Owner, 1 November 2026, after reading `demo-aya-anatomy-2026-11-01.md`: "how
can we make it much simpler so that latency is the lowest possible and
emotional realism the highest?", then: before/after tables for every realism
point, demo values filled between the scrape and the demo being ready, three
short examples in place of the manner rules, realistic pauses after "let me
look at the calendar", and "she should NEVER repeat the same thing twice ...
always worded differently and always the shortest version possible".

Tasks: DEMO-SIMPLE-1 to 5, DEMO-FILL-1. Status (1 November 2026, 17:10 UTC):
built on `claude/compassionate-dirac-rc9bbm` with the owner's approvals given
in chat: section 2; section 3 (row 8 also with the text offer where a clinic
has it); section 4 and its pauses; section 5 (the fill is a build step,
stored and checked; seven benchmark entries are unsourced and listed in
`apps/web/src/lib/demo/benchmarks.ts`); section 6 with a fourth example; in
section 7, points 1, 3, 4, 5 (except native tool use), 6 and 7, with a number
read back whenever given. Not built: native tool use (it changes the contract
of every turn and could not be tried against the real model from here), the
treatment library (point 8; only the owner's pattern for a general treatment
is in the prompt), the tool layer owning the name and number (point 2), and
the two retired replays (point 9).

## 1. Measuring a call's pauses (owner, step by step)

Every turn of a call writes one line, "retell turn timing", to the voice
service's log in AWS CloudWatch. It holds three numbers, in milliseconds:

- `modelMs`: from the caller's words reaching us to the model's first word.
- `ms`: from the caller's words reaching us to the first words we sent back.
- `totalMs`: to the end of our reply.

None of them includes Retell's own time: deciding the caller has finished,
and turning our words into speech.

1. Sign in to the AWS console with the account the host runs in
   (865780386982).
2. Top right, check the region says **N. Virginia** (us-east-1).
3. In the search bar at the top type **CloudWatch** and open it.
4. In the left menu open **Logs**, then **Logs Insights**.
5. In "Select log group(s)" pick **/healdesk/production/voice**.
6. Set the time range (top right, "Custom", absolute, UTC) to the call's day
   and hour: for be078f77, 1 November 2026, 13:15 to 13:45.
7. Paste this into the query box and press **Run query**:

   ```
   fields @timestamp, @message
   | filter @message like /retell turn timing/ and @message like /be078f77/
   | sort @timestamp asc
   ```

8. Each row is one turn. Open a row to see `ms`, `modelMs` and `totalMs`.
   Use **Export results** (top right of the results) to download a CSV to
   share.

The logs are kept indefinitely, and in standby too. be078f77 ran on PR 93's
version, from before the restructure. Its timings show the demo while it
still streamed. The restructure (PR 95) stopped the demo streaming
(section 2), so a fresh test call after this change is deployed shows the
difference.

## 2. Built: latency with no change to what she is allowed to say

| What | Before | After |
|---|---|---|
| What a call asks the model for | With booking tools live (every demo call, and a clinic with a connected calendar), one JSON object with the reply inside it. The streamer saw the opening "{" and could speak nothing until the whole object was written. | On every call, the words first as plain text, then "###", then the details JSON with the action. Same fields, a different order (`prompt.ts` `spokenFirst`). |
| Speaking as she writes, on a turn with booking tools live | Since PR 95 the demo always runs with booking tools live. On such a turn, the whole reply and its JSON were written before a single word went out (`turn.ts`: "Not while the tools are live"). A clinic with a connected calendar was the same. | Streamed sentence by sentence, each once the guard has read it, until the first times are offered. From then until the booking, a reply is still read whole, because the tool layer's lines replace her words there. |
| A find_times she asks for while streaming | Her words were thrown away, and only the tool line was said. | Her words go out first, and the tool line follows: "Let me pull up our calendar. I have Thursday, November 5 at 10 AM, 2 PM, or 4 PM. Which would suit you?" |
| A free time she names herself while streaming | Not possible (nothing streamed). | Held back unsaid at that sentence. The tool layer answers for the day and part of the day the caller named, after what she has said. |
| "What do you have Thursday?" once the treatment is known | The model wrote a reply asking for times, it was thrown away, and the tool line was said. | The tool layer answers at once, with no model turn. Another treatment named, or no day or part of the day, goes to the model as before (`asksForTimes`). |
| "We have Thursday at 11 AM open" | Not caught as a free time she named (only "I have" was), on every call. | Caught ("we have", "we've got"), on every call. |
| Her first sentence | No guidance on its length. | One prompt clause: "with a short first sentence of a few words (it is said the moment it is written; the rest follows)". |

A correction to the earlier answer in chat: the conversation history was
already cached turn to turn on a call (`cacheConversation`, 25 October 2026).
The AGENTS.md note saying it was not is out of date. Nothing needed doing
there.

Files: `apps/app/src/lib/assistant/{turn,prompt}.ts`, the comment in
`lib/voice/retell.ts`, `apps/app/tests/voice-demo-latency.test.ts` (new).

## 3. Realism: before and after, exactly (proposal)

Each "after" replaces its "before" word for word. Lines marked **every call**
are the clinic product's own lines, so changing them changes every clinic's
calls (the owner's decision, anatomy section J). The opening line (the AI and
transcription notice) and the urgent line are not touched: one is required,
and the other waits on the medical director's sign-off.

### 3a. Lines code says itself

| # | When | Before | After |
|---|---|---|---|
| 1 | Times offered (every call) | "I have Thursday, November 5 at 10 AM, 2 PM, or 4 PM. Which would suit you?" | "Thursday the 5th, I've got 10, 2 or 4. Any of those work?" |
| 2 | First time picked, once a call (demo only) | "That time has just gone. The nearest times I have are Thursday, November 5 at 1 PM or 3 PM." | Removed. The time picked is held. A planned "just gone" is the one line a caller can tell was staged. |
| 3 | A time really taken meanwhile (every call) | "That time has just gone. The nearest times I have are ..." | "Ah, 2 just went. I've got 1 or 3?" |
| 4 | A time picked (every call) | "I've got that time held for a minute while I take your details. Could I take your first name?" | "Great, I'm holding 3 for you. What's your first name?" |
| 5 | Name and number asked together (every call) | "Before I hold Thursday, November 5 at 3 PM for you, could I take your first name and a mobile number the clinic can reach you on?" | "Lovely. What's your first name?" (the number is asked next, on its own) |
| 6 | The number (every call) | "What's the best number for the clinic to reach you on?" | "And the best number for you?" |
| 7 | Booked (every call) | "You're booked for Thursday, November 5 at 3 PM for Botox Cosmetic. It's in the clinic's calendar." | "Perfect, Tomo, you're booked for Botox on Thursday the 5th at 3." (her one use of the name, at the wrap-up) |
| 8 | Deposit after booking (every call) | "A deposit of 50 dollars is required to hold the appointment. The front desk will call you to take it; nothing is charged on this call." | "There's a 50 dollar deposit, and our front desk will give you a quick call to take it." |
| 9 | "When was it again?" after booking | "You're booked for Thursday, November 5 at 3 PM." | "Thursday the 5th, at 3." |
| 10 | Another booking asked for (every call) | "I can only book one appointment per call, and yours is already booked for Thursday, November 5 at 3 PM. For another appointment, please call back or ask the clinic." | "You're all set for Thursday at 3. For a second visit, our front desk can sort that out." |
| 11 | No free time then (every call) | "I don't have a free time then. Which other day or time would suit you?" | "That one's full. Another day work?" |
| 12 | Name not caught (every call) | "I didn't catch your first name. Could you tell me again?" | "Sorry, your first name?" |
| 13 | Number not caught (every call) | "I didn't catch a number the clinic can reach you on. Could you tell me again?" | "Sorry, what was that number?" |
| 14 | Booking failed (every call) | "I'm sorry, I couldn't complete that just now. I can put you through to the clinic, or take your details so they can confirm with you." | "Sorry, that didn't go through. Want me to take your details so the team can confirm?" (a clinic call with a direct line keeps "or put you through") |
| 15 | Manual booking (every call) | "I can't book that directly right now, so I'll take the time you'd like and the clinic will confirm it with you." | "I'll note that time, and our team will confirm it with you." |
| 16 | Business ask (every call) | "For business inquiries, please call our office on seven eight six ... Anything else I can help with?" | "That's one for our office, on seven eight six ... Anything else?" |
| 17 | "Are you always full?" (every call) | "I can usually find you a time that works. Want me to take a look?" | Removed: the model answers, under the rule that only the calendar says how busy it is. |
| 18 | A paused fragment | "Mm-hmm?", then "Take your time." | Kept: short, human, and no model turn. |
| 19 | A bare "hi" | "Hi there! Thanks for calling ... How can I help you today?" (the opening already asked "How can I help you today?") | "Hi there! What can I do for you?" |
| 20 | The planned stall, once a call | "Sorry, say that again?", then the refusal on the next turn | Removed. It costs the caller a whole extra turn, and they repeat themselves for nothing. The refusal is said at once, kindly. |
| 21 | Silence | "Still with me?" / "Hm, you there?" | Kept (already two different wordings). |
| 22 | Something she does not know (demo) | "I don't know that one, but the team can confirm it for you. Anything else I can help with?" | "Good question, I'd have to check that with the team." |
| 23 | The same, asked again (demo) | "I don't have that detail in front of me, but the team can confirm it for you. Anything else I can help with?" | "That one's for the team, I'm afraid." |
| 24 | "Anything else I can help with?" closing many lines | The same words every time | Rotated, never twice in a call: "Anything else?", "What else can I do for you?", "Anything else on your mind?" |

### 3b. Never the same thing twice (the owner's rule)

| # | Before | After |
|---|---|---|
| 25 | A demo reply said before word for word becomes "Like I mentioned, " plus its first sentence, again word for word (`retell.ts`). | The model is told, before it writes, what she already said in answer to the same question ("You already said: '...'. Say it again shorter, in new words"). Code then checks no sentence matches one said before. If one still does, it keeps only the sentence's key fact (the price, the time, the day), never a repeated sentence. |
| 26 | A caller asks "sorry?" or "what?": the prompt says "say only the key part again, in fewer and shorter words". | Kept, and it now applies to every repeat, not only "sorry?". |
| 27 | Fixed lines can repeat when the same situation comes back (the same offer, the same "anything else"). | Each fixed line has two or three wordings, shortest last. Code picks one not yet said in the call, and the second use is the shortest. |

### 3c. The manner rules (the prompt)

| # | Before | After |
|---|---|---|
| 28 | About 40 manner bullets: "Style" (30) and "How you run a booking" (12), about 2,300 words of the 3,450. | One persona sentence, five one-line musts, and the three examples in section 6. |
| 29 | Hard rules ("Rules you never break"), booking mechanics, the JSON format, languages, the clinic's facts | Unchanged. |

The five musts that stay as rules: one or two short sentences, the first of a
few words, and at most one question; never a sentence said before, so a
repeat is said shorter and in new words; their first name once, at the
wrap-up; the mood word in brackets first; "9-1-1", and no lists, markdown or
links.

## 4. Pauses after "let me look" (proposal)

A person at a front desk takes a moment to find things. A reply that says
"Let me pull up Thursday..." and then the times with no gap sounds read out.
Our in-memory demo calendar answers in a few milliseconds, so the gap has to
be made on purpose.

| Use case | What she says first | How long it takes a person (estimate) | Silence after her words (proposed) |
|---|---|---|---|
| Free times for a day | "Let me pull up Thursday..." | 2 to 3 s | 1.2 s |
| A provider's schedule | "Let me bring up Dr. Patel's schedule..." | 2 to 3 s | 1.2 s |
| Another day, calendar already open | "Let me check Friday..." | 1 to 2 s | 0.7 s |
| Holding the time picked | "Let me grab that for you..." | 1.5 to 2 s | 1.0 s |
| Writing the booking at the end | "Okay, putting that in now..." | 2 to 4 s | 1.5 s |
| Checking a policy (deposit, cancellation) | "Let me check that..." | about 1 s | 0.5 s |
| A price from the menu | none: she knows her menu | under 1 s | none |

These are estimates of ordinary front-desk work, not measurements. The
silence is counted from when her words finish, so the whole moment is her
sentence (about a second) plus the silence, kept under about 2.5 seconds,
past which callers start to wonder whether the line dropped. With a hurried
caller the silence is halved. When the real lookup takes longer (a clinic's
Google Calendar), nothing is added on top.

How it would work: code knows when her words went out, estimates how long
they take to say (about 2.7 words a second), and sends the tool's line only
after that plus the silence for the use case.

## 5. Demo values filled after the scrape, not while she talks (proposal)

**Today.** Aya already makes nothing up herself. `withDemoSamples`
(`apps/web/src/lib/demo/samples.ts`) fills the gaps in code and the guard
allows only the filled list, so "listed prices only" already holds on a demo
against the filled list. But the fill is worked out again on every page view
and call, it is never stored or audited, and its prices come from one flat
table ("$14/unit" for any neurotoxin, "from $150" for anything it does not
recognise).

**Proposed.** A step of its own in the build, between the scrape and the
demo being ready:

1. Scrape, structure, check against the pages (as today).
2. **Fill the gaps (new).** For exactly the items the demo page lists today
   as "Made up for this demo":
   - the free times (always made up, worked out live from the hours);
   - a price for each treatment listed without one;
   - a sample menu when none was found;
   - opening hours when none were found;
   - the deposit and cancellation rule when none was found.

   Each price comes from a benchmark table by kind of treatment and
   specialty: a typical US price with its unit (per unit, per syringe, per
   session), each figure with its source and the date it was checked, as the
   editorial library's sources are. A treatment the table does not cover
   gets a complimentary consultation, not a guessed number.
3. Store the fill beside the profile on the demo's row (`demoFill`: each
   item, its value, "benchmark" or "sample"), never inside the profile, so
   the audit still checks the profile against the website alone.
4. The audit also checks the fill: every price within the benchmark's range,
   and every item on the page note matching the fill.
5. The page note, the chat, the voice call and the call-back all read the
   stored fill, so the note always matches what Aya says.

Never made up, as today: the address, the phone number, the team, parking,
insurance and financing (she says "I'd have to check that with the team").

For the owner: the benchmark figures and their sources, and whether a demo
already built gets its fill on its next rebuild or at once.

## 6. Three examples in place of the manner rules (proposal)

Placed in the prompt where the manner rules are. Code builds them from each
clinic's own facts (its first priced treatment and price, its first
provider), so an example never puts a fact in her mouth that the clinic does
not have. Shown here with Miami Skin & Vein's.

**1. A nervous first-timer (warm, unhurried; one validation, then help)**

> Caller: Hi, um, I've never had Botox and I'm honestly a bit nervous. How much is it?
>
> Aya: [reassuring] That's so normal! It's from $18 a unit, and Dr. Patel works out how many with you at a relaxed consultation. Want me to find you a time?
>
> Caller: Sure, maybe Thursday after work?
>
> Aya: [warm] Let's get you in after work so you're not rushing. Let me pull up Thursday... (action: find_times, Thursday, after 16:00)

**2. A brisk caller (no pleasantries, crisp, one question at a time)**

> Caller: Dysport, Friday morning, earliest you've got.
>
> Aya: [focused] On it, checking Friday morning. (action: find_times, Friday, before 12:00)
>
> Caller: The nine.
>
> Aya: [focused] Got it. First name? (action: choose_time)

**3. A repeat, a medical question, a goodbye (shorter in new words; no advice; a warm close)**

> Caller: Sorry, what was the price again?
>
> Aya: [calm] From $18 a unit.
>
> Caller: And is it okay if I'm breastfeeding?
>
> Aya: [sympathetic] That's one for Dr. Patel to go through with you. Shall I book you a consultation?
>
> Caller: No, that's it, thanks.
>
> Aya: [cheerful] Thanks for calling, have a lovely day! (end)

## 7. The owner's nine review points, answered

**1. The prompt still scripts lines code now owns.** Agreed. The booking
block gives example lines for moments the tool layer speaks ("Can I get your
full name?", "I've put that in for you", the day's pleasantry with the
times). Proposal: remove every line for a tool moment from the prompt. The
model keeps only what comes before the tool's line (one short validation:
"Mornings go fast, glad we got one."), and the tool's lines get their warmth
from section 3a.

**2. Name and phone are kept in two places.** Agreed, and the phone bug in
the anatomy doc (section J) follows from it. Proposal: the tool layer owns
the booking's details. It asks for the name, then the number, and reads the
caller's next words itself: the number with the parser it already has
(`toE164`), and the name as the caller's answer to its own question. The
model's `booking` JSON goes. A number changed after the booking updates the
booking: in memory on a demo, on the calendar event on a clinic's call (a
write, so the owner's word first).

**3. Rules the model is asked to enforce but cannot.** Agreed. Each rule
goes to the one party that can keep it:
- Rules that need exact memory of the whole call go to code, and out of the
  prompt: never the same sentence or feeling sound twice, never two turns
  opened the same way, the name once, one question, no booking claim. Code
  already keeps most of these.
- What only the model can do (tone, mirroring, empathy, curiosity) is taught
  by the three examples in section 6, not by rules.
- The hard rules stay as a short list in the prompt, and the guard enforces
  them as well.

What makes this succeed rather than become one more patch is a test that
runs the real model (point 9).

**4. The stall makes a loop.** Agreed: removed in row 20 of section 3a,
along with its turn note (the "Once in this call" paragraph in the
anatomy's section E). The refusal is said straight away, kindly, and
offers the next step.

**5. The JSON wrapper.** Checked in the code:
- *Latency:* the endpoint does parse the words as they stream, but only in
  the words-first format. With booking tools live, every demo call was asked
  for one JSON object, so nothing was spoken until the whole answer was
  written. Fixed in section 2.
- *Ending the call:* code does turn `end: true` into Retell's end-call
  signal (`retell.ts`, `endCall`). So in be078f77 either the model did not
  set it, or the reply went through a path that drops it: a guard
  refusal, a fixed line, or a tool line, none of which carries `end`.
  Proposal: code ends the call when the caller's words are a goodbye and her
  reply is one too, whatever the JSON says.
- *Native tool use:* recommended, in this form. The tools are `find_times`,
  `choose_time`, `end_call` and `hand_off`, and the reply is plain streamed
  text. One trade-off: if the model is to say the times in its own words, a
  tool result needs a second model call, about half a second more. If the
  tool layer keeps saying the times (section 3a rows 1 to 11), no second
  call is needed. I recommend the second: same speed, and the warmth comes
  from the lines themselves.

**6. "Do not invent facts" against made-up values.** Agreed. Proposal: the
base prompt keeps "Do not invent facts about the practice". On a demo only,
the facts block marks the filled values (section 5) with one line: "On this
demonstration, the values marked (sample) were filled in so the owner can
hear how you would say them: say them as given, as the practice's own." The
model then follows its rule rather than breaking it, and nothing else may be
made up.

**7. Suggesting other treatments.** The spec already has the switch:
"Suggest add-on treatments", off by default for clinics (spec, "Every switch
in the portal"). Proposal for the best result:
- On a demo it is on, to show the dream.
- What to suggest is chosen by code, not the model: a pairing table over
  the clinic's own menu (Botox with lip filler, a HydraFacial with a peel,
  laser hair removal with a package). Each pairing carries its reason in
  plain words (the same area, the same visit, prep before an event).
- The model is given at most one pairing per call, at one moment: after a
  time is picked, before the details, and only when the caller has said why
  they are coming (an occasion, a goal) or sounds relaxed, never in a hurry.
- She says it as their benefit ("Since you're coming in for Botox, a
  HydraFacial in the same visit is a nice refresh, it's $199. Want me to
  add it?"), with its listed price, once, and drops it on
  a no. Never a popularity claim, never an outcome.

**8. Knowing every treatment beyond the website.** Proposal: a treatment
library in `packages/catalog` (business data, no patient data). It is
written once and reviewed, as the editorial library is, so every answer is
the same each time and checkable.

For each treatment it holds:
- what it is;
- what it is generally for;
- how long a session takes;
- a typical course.

It never holds risks, safety, candidacy or results, which stay out by the
spec's rule.

How it is used:
- For a named treatment on the menu, she answers from the entry.
- For a generic name ("a hydrating facial"), she answers in the owner's
  pattern: "That's one our experts can tailor for you, but in general,
  hydrating facials are meant to put moisture back into the skin, usually
  in about an hour. Want me to find you a time?"

The model's own general knowledge is no longer the source, so a demo cannot
say something the library does not.

**9. Patches, and narrower coverage.** Agreed, and the fix is in two parts:
- Bring back the c4093be6 and a44374c9 replays on the new booking path (their
  callers' words still apply; only the old code they judged is gone), and
  make every owner test call a permanent replay.
- Add a test with the real model: about 20 caller personas (nervous, brisk,
  price-checker, mishearing line, medical question, upset, goodbye). Each is
  played against the real prompt on Haiku 5.5 and scored for:
  - the words in the first sentence;
  - repeated sentences;
  - two questions in one reply;
  - a line spoken at a tool's moment;
  - realism, against a written rubric.

  Run before every change to the prompt, it shows whether a change made her
  better, rather than whether the code still works. Today's replays script
  the model, so they test only the code around it.

## 8. What waits for the owner

- Section 3: each row, above all those marked "every call".
- Section 4: the silences.
- Section 5: the benchmark figures and their sources.
- Section 6: the examples, and the rules they replace (3c).
- Section 7: points 2 (the tool layer owns the details, and updates a changed number), 5 (native tool use), 7 (the pairing table and the demo switch), 8 (the treatment library).
- Then one build, with the replays (`voice-demo-be078f77`,
  `voice-demo-sound-alike`) and the voice safety suites rerun on the merged
  tree before anything is pushed.
