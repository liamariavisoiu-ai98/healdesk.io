# Demo call 72dc66b7 (Thomas, Lumen): what went wrong, and the fix brief

Status: analysis for the owner, 26 October 2026. Nothing here is built yet.
Section 3 is the prompt to hand Claude Code once the owner has answered
section 4.

The call ran on production after PR 58 was deployed (run 40310795297):
"Talk soon, Thomas!" is VOICE-T18a's sign-off. So every fault below is in
the code on `main` today, not something an earlier deploy left behind.

## 1. What the call should have done

These are the goals each fault is measured against. They come from
CLAUDE.md, the demo design notes and the owner's briefs.

- One short reaction at most, then one short point.
- No filler, no reflex apologies, and no near-verbatim repeats.
- The first time channels come up, say all of them in one go: phone,
  website chat, Instagram, Messenger, WhatsApp.
- A role-play starts only with the exact opener, which carries the AI
  notice, and ends only with the exact exit line.
- Never ask again for something the caller already said.
- Read a rich answer for everything it answers.
- When the caller is impatient, stop qualifying and get to the point.
- Close to match how the call ended: a frustrated caller never gets
  "Talk soon!".

## 2. Each fault, its cause and its fix

"Verified" means the cause was read out of the code. "Likely" means it is
inferred from the transcript.

| # | What happened | Cause | Fix |
|---|---|---|---|
| 1 | "Mm." and "Hmm." at the start of replies ("Mm. Hi, great to hear from you!", "Hmm. Let me put it more simply") | **Verified**: the code says these itself. `retell.ts` `ACKNOWLEDGEMENTS.en = ["Mm.", "Hmm.", "Let's see."]` is spoken whenever a reply takes more than 900 ms to start. | Remove filler words from the acknowledgement list on every call. Use silence, or a real short word that fits the turn ("Sure." only after a request). Strip "Let me see"-style model openers in `LEADING_FILLER`. |
| 2 | "Yes, please" to "walk through each channel, or switch into the role-play?" started a role-play ("Ring ring!") | **Likely**: the model took an ambiguous yes as the second option. **Verified**: nothing stops it. | When an either/or question is answered with a bare yes, ask which one, in a few words. The role-play starts only when the caller's own words choose it. |
| 3 | The role-play began with a bare "Ring ring!", with no clinic greeting and no AI notice | **Verified**: the stage still comes from a regex over her own words (`nextDemoStage`, `DEMO_ROLEPLAY_START`). Any reply containing "Ring ring" flips the stage, whatever else it says. The opener the owner requires (`demoRoleplayOpener`) is only asked for in the note. | Make the start a code-said line, as the call-back line already is. The model sets `"roleplay": "start"` in its state, and the adapter itself says `demoRoleplayOpener(clinic)`, word for word. The stage changes only on that signal, never on a regex. |
| 4 | "And that's the role-play! So, how was that?" said when no role-play had happened ("We didn't do the role play") | **Verified, same cause as 3**: the stage stuck at "roleplay" after the caller said "No, I didn't mean that". The four-turn cap then forced the exit line. | The model may set `"roleplay": "cancel"` when the caller declines right after the start. The stage goes back without the exit line. The exit line is code-said, and only after at least one in-character exchange. |
| 5 | The second role-play start was improvised ("Quick heads-up: I'll play Lumen's front desk..."). Later the role-play dropped silently into "how many calls do you get a day?" | **Verified, same cause**: no "Ring ring" in her words, so the stage stayed "pitch". The role-play ran under the pitch note, whose next step was a discovery question. | Fixed by 3. Also: the adapter never lets a discovery question out while the stage is "roleplay". It says the exit line in its place. |
| 6 | Asked "what can you do", she named phone and website chat only. Meta and WhatsApp came up only when Thomas pushed: "don't you mention WhatsApp upfront?" | **Verified**: the intro's "hear more" line (`demo-facts.ts`, the `!a.choice` branch) lists calls, treatments, prices, hours and booking requests, and no channels. `channelsLine()` is a separate rule the model skipped. | The "hear more" line carries the full channel statement: phone, website chat, Instagram, Messenger and WhatsApp, as one Aya. Also the deposit link, as design (see 7). A case asserts all five names in the first answer. |
| 7 | She claimed Aya "can send deposit links through web chat, Meta chat... WhatsApp as well" | **Verified**: LAUNCH_PROMISES has only "In website chat AYA sends the clinic's own deposit link", status "building". The Meta front door books nothing and sends no link. She followed the caller into a claim production does not make. | Say only what LAUNCH_PROMISES allows, as design: "in website chat I'm designed to send your own deposit link". Never on a call. A Meta or WhatsApp deposit link is said only once the owner adds that promise (section 4). Pin it with a guard-style check in the demo cases. |
| 8 | "The second one" (after Signature $249, VIP $349, Prestige $599) became "the Prestige Facial at $599", the third | **Verified**: nothing keeps the list she just said. The model counts on its own. | Keep the last list of menu items she said, in order, read from her reply against the menu (`lastListed` in progress). When the caller says "the second one", "the first", "the last" or "the middle one", the note names the item: "they mean the VIP Facial ($349), the 2nd you listed". She confirms it by name. |
| 9 | "I don't understand", twice, got the same price list again, then the same line again | **Verified**: no rule covers it. VOICE-T13c's repeat check covers the caller repeating themselves, not the caller not understanding. | A bare "I don't understand" gets one short question: "Which part?". Never the same words again. A second one gets the simplest version, one item. A third gets a fresh angle or an offer to move on. Track it in progress (`confused` count). |
| 10 | The role-play booking asked for the service four times ("Which service would you like the consultation for?") after the consultation and a facial were agreed. Thomas: "Don't make me repeat again." | **Verified**: the role-play keeps nothing structured. The note says "ask only for the treatment and a preferred day and time" but never says what is already known. | Keep role-play booking state: `rpService`, `rpDay`, `rpTime`, from her structured state. The note says "On file: Prestige Facial consultation. Never ask for it again." Once both are known, take the request and wrap up. |
| 11 | "Monday, ten PM" got "Would a weekday earlier that day work instead?" (nonsense), then a question about the service | **Likely**: no rule for out-of-hours. | Out of hours: say the hours in a few words and offer two real times inside them on the same day (for Monday 10am to 7pm: "5 or 6pm?"). Never return to the service. |
| 12 | A volume answer of "I don't know. Like, five." was treated as no count, then the month maths was done anyway. After Thomas gave a rich answer (phone, questions, upselling, booking, deposit links, web, WhatsApp, Instagram), she asked for calls a week again. He hung up. | **Verified**: `bareCount("I don't know. Like, five.")` returns null, because only a single remaining word counts. And a caller's words are stored only against the one question asked, so the rich answer counted for `goal` alone. This is the brief's "highest-priority" fault, and it caused the hang-up again. | (a) `bareCount` takes the one number in a hedged answer. (b) A state field `"answered": [...]` names every discovery question the caller's last words answered, and code stores the words against each. (c) The volume check is skipped when the count was hedged. (d) A fast lane, below. |
| 13 | Thomas said "You tired me... not straight to the point", "your questions are not clear", "I'm done with repeating myself". She kept qualifying. | **Verified**: pushback moves rotate, but nothing ends discovery for an impatient caller. | Fast lane: the model sets `"impatient": true` on a clear sign (tired, not clear, repeating, hang up). Code then marks every open discovery question as skipped and jumps straight to "recommend one package" and the close, with no more questions. |
| 14 | Unclear, improvised questions ("Anything you're working on for the next call?", "What's the one thing you'd want a call like this to get right?") | **Likely**: a symptom of the stage confusion in 3 to 5. Discovery questions are also only "close to these words". | Discovery questions are said in the script's words. The model may shorten them, but not invent new ones. A case checks that each asked question matches its script. |
| 15 | A frustrated hang-up got "Thanks for your time, and have a good one! Talk soon, Thomas!" | **Verified**: VOICE-T18a's rule excludes only a firm refusal ("leave me alone") and a failed call back. | Never offer "Talk soon" once the caller has shown frustration (the same signal as 13). Code also strips a "Talk soon" the model writes anyway. The close is one short, sincere line: "Sorry it wasn't smoother, Thomas. Thanks for your time." |
| 16 | His name in nearly every reply, about 20 times | **Verified**: `voiceHabits` only reminds the model ("Do not say their name in this reply"). Nothing enforces it. | Code removes the caller's first name as a vocative ("Sure, Thomas," becomes "Sure,") after two uses in a call. The opening, the greeting and the sign-off are exempt. |
| 17 | Reflex apologies: "I'm sorry, the address is...", "I'm sorry, Thomas, the second one is...". Thomas: "you don't need to be sorry." | **Verified**: only a reminder (`voiceHabits`, "You have already apologised"). | Code strips a leading "I'm sorry" or "Sorry" from a reply that is not a refusal, a correction or the stall's sorry line. One genuine apology a call at most. |
| 18 | Two reactions before the point ("Nice, thanks for being straight with me. Great, so you know the front desk side well.") and price lists read in full | **Verified**: 6a caps length in the note only. | Code check: a reply longer than about 30 words, or holding more than one reaction sentence, is asked again once with "shorter: one point". Lists over two items become "from $249 for the Signature Facial" plus an offer to say more. |
| 19 | "Still with me?" then "Fair enough, Thomas." after "Yeah, I'm here." | **Likely**: the silence check's follow-up has no rule. | After the silence check, a "yes" gets straight back to the thread, never a reaction word. |

## 3. The prompt for Claude Code

> Fix the Healdesk demo-call voice agent (Aya) against test call 72dc66b7
> (Thomas, Lumen, 26 October 2026, on production after PR 58). The
> analysis, with each cause read out of the code, is
> `docs/design/demo-call-72dc66b7-review-2026-10-26.md`. Read it first,
> then CLAUDE.md, AGENTS.md, `lib/voice/demo-facts.ts`,
> `lib/voice/retell.ts`, `lib/voice/demo-cases.ts` and
> `lib/assistant/turn.ts`.
>
> NON-NEGOTIABLE:
> - `apps/app/src/lib/assistant/guard.ts` is shared with real patient calls.
>   No change may weaken clinical-content screening, complication or
>   urgent-symptom matching, or any other guard for a real patient. Any
>   change there ships only with the full apps/app suite green.
> - Every new code path here is demo-only unless the fix says "every call".
> - Nothing lands on `main`, and nothing deploys, without the owner's
>   explicit yes.
> - Run `bash scripts/verify-local.sh`, or the full `npm test -w
>   @healdesk/app` and `-w @healdesk/web` against a real Postgres, after each
>   step. Report pass, fail and skip counts.
>
> STEP 0, the case first. Add `thomas-lumen-72dc66b7` to
> `lib/voice/demo-cases.ts`: every caller line of the transcript, verbatim,
> turn by turn. Each turn checks what the fixed behaviour must be: the
> heard line, the stage, the progress, and note includes and excludes. Also
> add one focused case per fault: 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 15,
> 16 and 17. Every case must fail on today's code before its fix and pass
> after it.
>
> STEP 1, the stage is a signal, not a regex (faults 2 to 5 and 14).
> - Replace `DEMO_ROLEPLAY_START` and `DEMO_ROLEPLAY_END` regex inference in
>   `nextDemoStage` with explicit state from the model: `"roleplay":
>   "start" | "cancel" | "end"`.
> - "start": the adapter says `demoRoleplayOpener(clinic)` itself, word for
>   word, in place of the model's words. It does this the way
>   `callbackSentLine` replaces "Perfect.".
> - "end": the adapter says "And that's the role-play! So, how was that?"
>   itself, only after at least one in-character exchange. A forced wrap
>   at the turn cap uses the same line.
> - "cancel": allowed only on the caller's first turn after the start; the
>   stage goes back with no exit line.
> - While the stage is "roleplay", a reply declaring a discovery question
>   is replaced by the exit line.
> - An either/or question answered with a bare yes gets "Which one: X or
>   Y?", never a guess.
> - Discovery questions are said in the script's words; check this in a
>   case.
>
> STEP 2, read every answer for what it answers (faults 12 and 13).
> - `bareCount` takes the one number in a hedged answer ("I don't know.
>   Like, five." gives 5). When the count was hedged, the volume check is
>   skipped.
> - New state field `"answered": [question names]`. `afterDemoReply` takes
>   the caller's words and stores them against each named discovery
>   question that is not yet answered. The intro and pitch notes say: "If
>   their last words answered other discovery questions (for example, they
>   named the channels and jobs they want covered: that is goal and
>   coverage), name them in `answered` and never ask them."
> - New state field `"impatient": true` on a clear sign. Code then marks
>   every open discovery question as skipped (`SKIPPED_ANSWER`) and the
>   note jumps to the recommend beat and the close: no more questions, at
>   most two short beats.
>
> STEP 3, what she says about the product (faults 6 and 7).
> - The intro's "hear more" line carries the full channel list as one Aya:
>   phone, website chat, Instagram, Messenger and WhatsApp. It also says the
>   website-chat deposit link, as design.
> - Deposit links are claimed only as LAUNCH_PROMISES allows: website chat,
>   "designed to", never on a call. Meta and WhatsApp are not claimed until
>   the owner adds that promise (owner decision, section 4 of the review).
>   Add a case where the caller insists on Meta links, and assert she does
>   not claim them.
>
> STEP 4, the role-play behaves like a front desk (faults 8, 10 and 11).
> - Keep `lastListed`: the menu items her last reply named, in order, read
>   against the clinic's menu. The note resolves an ordinal ("the second
>   one", "first", "last", "middle") to that item by name, and she confirms
>   it by name.
> - Keep role-play booking state (`rpService`, `rpDay`, `rpTime`) from her
>   structured state. The note says what is on file and "never ask for it
>   again". Once all three are known, she takes the request and wraps up.
> - Out of hours: she says the hours in a few words and offers two real
>   in-hours times on the same day, computed in code from the profile's
>   hours. She never returns to the service.
>
> STEP 5, register, enforced in code and not only in the note (faults 1, 9,
> 15, 16, 17, 18 and 19).
> - Every call: remove "Mm.", "Hmm." and "Let's see." from
>   `ACKNOWLEDGEMENTS`. Use silence or a fitting word. Extend
>   `LEADING_FILLER` to "Let me see" and "Let's see".
> - Demo: the `confused` count. A bare "I don't understand" gets "Which
>   part?". The second gets the simplest single-item version. The third
>   gets a new angle or an offer to move on. Never the same words twice.
> - Demo: no "Talk soon" once the caller showed frustration. Strip it in
>   code if written anyway. The close after frustration is one sincere line.
> - Every call: the caller's first name as a vocative is removed after two
>   uses (the opening and the sign-off are exempt). A leading "Sorry" or
>   "I'm sorry" is removed from a reply that is not a refusal, a correction
>   or the stall's sorry line, after the first apology of a call.
> - Demo: a reply over about 30 words, or holding more than one reaction
>   sentence, is asked again once with "shorter: one point". A price list
>   over two items becomes the lowest "from" price plus an offer to say
>   more.
> - The silence check's follow-up: after "yes, I'm here", go straight back
>   to the thread.
>
> DO NOT IMPLEMENT:
> - Any claim the demo is a partial or capped version of Aya.
> - ROI, "revenue" or "recovered revenue" maths.
> - SMS, voice payment collection, or deposits "automated" from a call.
> - A hardcoded discount percentage.
> - "The only ones..." exclusivity claims (unverified).
> - Deposit links on Meta or WhatsApp before the owner adds the promise.
>
> Update AGENTS.md, CLAUDE.md's demo paragraph and `/admin/map` if a
> connection changes, in the same change. Open a PR naming the task ID
> VOICE-T19, the tests run with their counts, and the owner-only steps:
> the merge, the deploy (it rolls the voice service), and a test call.

## 4. Decisions only the owner can make

1. **Deposit links on Meta and WhatsApp.** The spec allows hosted payment
   links on the Meta channels, but production's Meta front door sends none,
   and LAUNCH_PROMISES lists only website chat. Should Aya say Meta and
   WhatsApp too, "designed to"? If yes, a LAUNCH_PROMISES item goes in
   with it, and blocks go-live until built.
2. **"I'm an employee".** Today the demo pitches to whoever is on the line.
   Should a non-owner get a lighter call: the role-play and the channels,
   then "share the demo page with your owner"?
3. **Transcript c53e5c3e (Lia, Lumen)** is not in the repo, and d2d9a915
   (Josh) is still a reconstruction. Paste either one to have it replayed
   turn by turn as a case.
