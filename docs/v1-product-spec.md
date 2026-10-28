<!-- Source of truth. Exported from the "Healdesk v1: Products, Behaviour and Limits" doc,
     tab 1 (https://claude.ai/artifact/F7bKioXheMJwn5Epc65bVQ), on 2026-10-14, and edited
     directly in this repository since 22 October 2026 by the owner's decision: do not
     re-export that doc over this copy. The "Launch plan" it links to is tab 2 of the same
     doc, and is the only live task list. -->


# Healdesk v1: Products, Behaviour and Limits

Sep 24, 2026 · @LV

## How to read this

This is the reference for what Healdesk v1 is: what the three products do, how they behave, what they cannot do, how a clinic gets onboarded, what they control afterwards, and where the compliance lines sit. It is written to be argued with. Anything marked unverified is unverified.

The step-by-step plan to get this live, with owners, dates and status: Launch plan

Order: scope, then the three products and their limits, then booking, then onboarding, then the admin portal, then what v1 cannot do, then HIPAA, then the launch gates and the copy changes this scope forces.

Three facts drive most of the decisions in here, and they are worth holding in mind throughout:

1. **No outbound.** Every product is inbound only: nothing contacts a patient first, and nothing follows a conversation up. That single choice removes WhatsApp templates and most of the Meta platform restrictions from the critical path. One optional exception, a clinic setting that is off by default: a single text carrying a payment link, sent to a caller who has just booked on a call and agreed to receive it ("Payment by text after a call", under Booking behaviour). It brings SMS sender registration back for the clinics that switch it on, and for no one else.
2. **Meta will not sign a business associate agreement, ever.** So the Meta channels are scoped to carry no patient health information, by design and by contract.
3. **The code is not the bottleneck.** Meta verification, App Review and the clinic's own call forwarding are. Three of those four clocks can be started before a single client exists.

## Scope and locked decisions

Healdesk v1 is three products sold as one assistant: an AI voice agent, a web chatbot, and a Meta bot covering Instagram, Messenger and WhatsApp. All three launch together.

Decisions now locked:

| Decision | Status |
| --- | --- |
| No outbound on any product | Inbound only. No follow-up sequences, reminders, win-backs or missed-call text-back |
| SMS is not a channel in v1 | Patients cannot text the assistant, and nothing is texted to a patient except the one optional payment-link text after a call (owner, 28 October 2026) |
| Voice runs on Retell | Pay-as-you-go, pointed at a Healdesk-hosted Claude endpoint |
| Meta built in house on the Cloud API | WhatsApp, Instagram and Messenger all in scope |
| Web chatbot built with Claude Code on the Claude API | Confirmed |
| Voice books directly into the clinic calendar | Confirmed |
| Deposit behaviour is a per-clinic toggle | Confirmed |

One brain, four adapters. Claude decides everything. Each channel is a translation layer that enforces its own platform rules. Bookings and payments are written only by a fixed tool layer, never by the model directly.

## The three products

### 1. AI voice agent

Answers the clinic's phone. The clinic keeps its published number and sets conditional call forwarding, so unanswered or after-hours calls land on a Healdesk number the patient never sees or dials directly. The agent answers questions from the clinic's own menu and pricing, qualifies the caller, checks live calendar availability and books the appointment during the call.

Built on Retell for telephony and speech, with the conversation itself driven by Claude through a Healdesk-hosted endpoint that Retell opens a WebSocket to at the start of each call. Recording and transcript retention are configured down at the vendor, with per-agent retention and PII controls; the transcript is emailed to the clinic when the call ends, and Healdesk keeps an encrypted copy only until the clinic's mail server confirms delivery, then deletes it at once, and in no case for longer than 30 days (owner, 14 October 2026).

Language coverage comes from the voice platform, which supports 55 languages across 63 regional locale variants. The clinic picks which languages its agent should handle; the agent answers in the caller's language and stays in it for the rest of the conversation.

### 2. Web chatbot

A widget on the clinic's website. Same brain, same clinic knowledge. Answers questions, qualifies, books, and takes a deposit through the clinic's payment gateway in the same browser session. This is the only channel that closes the full loop from question to booked and paid without leaving the conversation.

Built in house with Claude Code on the Claude API.

### 3. Meta bot

One integration covering Instagram DMs, Facebook Messenger and WhatsApp, built directly on the Meta Cloud API under Healdesk's own Meta app. Each clinic connects its own Instagram professional account, Page and WhatsApp number through a one-click login in the onboarding wizard. Meta's Developer Policies, updated 3 February 2026, bar using Messenger or Instagram messaging "to facilitate direct conversations between people and healthcare providers". Whether a clinic's assistant is allowed is open, and launch step 0.13 settles it.

Answers, qualifies, books and can send a payment link, all inside the 24-hour window that Meta opens when a patient messages first.

## Capability matrix

| Capability | Voice | Web | Instagram | Messenger | WhatsApp |
| --- | --- | --- | --- | --- | --- |
| Answer questions from clinic menu, pricing, hours, policies | Yes | Yes | Yes | Yes | Yes |
| Qualify the enquiry and capture the lead | Yes | Yes | Yes | Yes | Yes |
| Check live calendar availability | Yes | Yes | Yes | Yes | Yes |
| Create the booking in the clinic calendar | Yes | Yes | Yes, in window | Yes, in window | Yes, in window |
| Send a Stripe or gateway payment link | No | Yes | Yes | Yes | Yes |
| Take a card number directly | Never | Never | Never | Never | Never |
| Escalate to a human | Yes | Yes | Yes | Yes | Yes |
| Send anything after the conversation ends | No | No | No | No | No |
| Patient identity known at the start | Yes, caller ID | No, anonymous visitor | Yes | Yes | Yes, phone number |
| Marginal cost per interaction | Per minute | Near zero | Free | Free | Free in window until 1 Oct 2026, billable after |

The short version: voice books but cannot collect. Web books and collects. Meta books and collects, but only while the patient is actively in the conversation.

Card numbers are never taken on any channel, on any plan. Payment always happens through a hosted checkout link the patient opens themselves.

## Voice agent behaviour

### Coverage mode, chosen by the clinic

Every clinic picks one of three modes at onboarding, changeable at any time from the dashboard. The mode is implemented with conditional call forwarding on the clinic's own line, so the clinic's published number never changes.

| Mode | What the AI answers | Forwarding rule the clinic sets |
| --- | --- | --- |
| Full coverage | Every inbound call, 24/7 | Forward all calls |
| Overflow and after hours | Calls that ring out or arrive while the line is busy with a human, plus anything outside opening hours | Forward on busy, forward on no answer after a set number of rings, and forward all outside hours |
| After hours only | Calls outside opening hours only. The human team keeps the whole working day | Forward all outside hours, no forwarding during opening hours |

Opening hours come from the clinic's configured schedule and drive both the forwarding rule and what the agent says about availability. Whichever mode is chosen, the agent answers with the same knowledge and books the same way. The mode changes how many calls reach it, nothing else.

This is also the honest way to sell the product to a clinic with a full-time receptionist: start on after hours only, move to overflow once they trust it.

### How a call runs

1. Patient dials the clinic's published number. If nobody picks up, or it is after hours, conditional call forwarding sends the call to the Healdesk number.
2. The agent greets the caller with the clinic's configured greeting and tone.
3. It answers from the clinic's own service menu, public pricing, hours and policies. Nothing outside that set is invented.
4. When the caller wants an appointment, the agent checks live availability and offers two or three options aloud, never a long list.
5. The caller picks one. The slot is locked for 60 seconds before the agent says anything confirming.
6. The agent collects name and callback number, reading the number back digit by digit.
7. The booking is written to the calendar. A short filler line plays while the write runs so the line never goes silent.
8. The agent confirms date, time and service, and says the booking is in the clinic's calendar.

### Failure behaviour

| Situation | What the agent does |
| --- | --- |
| The held slot expires before confirmation | Re-checks availability and re-offers. Never guesses |
| Calendar connection is broken or the token expired | Switches to manual booking mode in the same turn: collects the preferred time, logs a booking request, tells the caller the clinic will confirm, and alerts staff |
| A tool call fails for any other reason | Speaks a fixed, pre-written line and offers a transfer to a human. It does not improvise an explanation |
| Caller asks something clinical or a price that is not in the menu | Pivots to booking a consultation with the named provider |
| Caller reports a complication or an urgent symptom | The message is caught before it reaches the model. Fixed response, immediate escalation to the clinic's on-call contact |

A background job watches calendar token expiry and flips the clinic into manual booking mode the moment a connection breaks. This is what prevents the agent confidently booking into nothing.

## Web chatbot behaviour

A script tag on the clinic's site. The widget opens on the page the visitor is already reading.

### How a session runs

1. Visitor opens the widget and asks something: a price, a treatment question, availability.
2. The bot answers from the clinic's own content.
3. Because the visitor is anonymous, name and phone are collected before any slot is held, not after.
4. Availability is checked live and offered as selectable options rather than read out as text.
5. The slot is held, the booking is written, and the confirmation appears in the chat.
6. If the service carries a deposit, a hosted checkout link opens in the same browser. The patient pays, the booking flips to paid.

### Why this is the strongest channel

No platform sits between Healdesk and the patient. There is no messaging window to expire, no per-message cost, no review process, and the visitor already has a screen and a browser open, which is what makes a deposit realistic to collect. Everything the other channels can do, this one can do, plus payment with no friction.

### Limits

- Session-bound. If the visitor closes the tab before finishing, there is no way to reach them again, by design.
- Anonymous by default, so a returning patient is not recognised unless they identify themselves.
- Traffic-dependent. A clinic with little web traffic will see little from this channel, which matters when setting expectations at the sale.

## Meta bot behaviour

One Healdesk Meta app covers all three channels. Clinics connect their own accounts through a one-click login. No clinic goes through Meta review; Healdesk does that once.

### The 24-hour window, the rule that shapes everything

When a patient messages first, Meta opens a 24-hour window. Inside it the agent can send freely. The clock resets every time the patient writes again. Outside it, automated sending is not possible:

- Instagram requires the HUMAN\_AGENT tag outside the window, and Meta scopes that to a real person answering an issue that could not be resolved in time, not to an automated agent.
- The tags that used to permit appointment reminders on Messenger, CONFIRMED\_EVENT\_UPDATE, ACCOUNT\_UPDATE and POST\_PURCHASE\_UPDATE, were withdrawn effective 27 April 2026.
- WhatsApp allows business-initiated messages only through approved templates, which is outbound and therefore out of scope for v1.

Healdesk enforces the window in code, not in the prompt. If a send is attempted outside it, the adapter drops it. The model is never the thing enforcing a Meta policy.

Because v1 has no outbound, this constraint costs nothing. The product and the platform rule agree.

### Channel differences

|  | Instagram | Messenger | WhatsApp |
| --- | --- | --- | --- |
| What the clinic connects | Instagram professional account linked to a Page | Facebook Page | WhatsApp Business number |
| Connection effort | One click | One click | Heavier: the clinic must attach its own payment method to its WhatsApp account before it can send |
| Message templates needed | No | No | No, because there is no outbound |
| Cost | Free | Free | Free inside the window today. From 1 October 2026 Meta charges for service replies inside the window too |

WhatsApp is the slowest of the three to bring live because it requires Tech Provider status and a per-clinic signup flow. It ships with the others where possible and follows shortly where not.

## Booking behaviour and deposit control

Deposit rules are set per service, since a consultation fee and a package deposit are not the same decision. What happens when a deposit is required but the channel cannot collect it is a clinic setting, not a Healdesk policy.

### Toggles in the client dashboard

| Setting | Options | Effect |
| --- | --- | --- |
| Book by voice without a deposit | On / Off | On: the agent books and flags the booking as deposit pending, for staff to collect. Off: the agent does not book by voice when a deposit is required |
| Book by chat without a deposit | On / Off | Same rule for web and Meta. Default off, because those channels can take payment in the conversation |
| When a deposit is required and cannot be collected | Book and flag / Hold and alert staff / Decline and alert staff | Hold and alert keeps the slot reserved for a set window while staff are pinged |
| Text the payment link after a call | On / Off | On: after booking by voice, the agent offers to text the caller a secure payment link, and sends it only if the caller agrees. Needs a connected payment gateway |
| What the assistant asks the patient to pay | Deposit only / Full payment | Full payment lets the assistant take the whole price of a service through the same hosted checkout. Needs a connected gateway, a connected calendar and auto-confirm on |

The dashboard states the trade-off in one line under the toggle, because clinics will not infer it: booking without a deposit fills the calendar and raises no-show risk, requiring one protects the slot and loses some bookings to friction.

### Payment by text after a call, and full payment (owner, 28 October 2026)

Two optional clinic settings, both in the onboarding wizard's behaviour step and in the portal's Settings, each with a one-line reason shown wherever it is unavailable.

**Payment link by text after a call.** Voice cannot collect a payment in the call, and it never takes card numbers. With this on, the agent finishes the booking, offers to text a secure payment link, and sends it only if the caller says yes and confirms the number by reading it back. The text goes once, to that number, in answer to that call. It is not a reminder, a follow-up or a resend, and nothing else is ever texted. The message is fixed text with the link: no treatment, time or amount in the words, and the link is the clinic's own hosted checkout, which carries only an amount, a generic descriptor and an opaque reference. If the text cannot be sent, the booking stands, the deposit is flagged for staff as it is today, and the caller is told so on the call when it can be known there.

- **Needs the clinic's payment gateway connected,** since the link is the clinic's own checkout. A clinic with no gateway sees the setting greyed out with that reason and a button to connect.
- **The text is handled by scoping, not a BAA (owner, 28 October 2026).** The sender signs no business associate agreement, as with Meta and Stripe. What keeps it in bounds is what the text carries: fixed words and the clinic's own checkout link, and nothing else, with no treatment, time or amount in them. The sender is not chosen yet and nothing sends a text today; the setting stays unavailable in what the assistant offers until a sender exists.
- **Sender registration** is per clinic and takes one to four weeks (see "What v1 cannot do"). The switch itself is usable whenever phone is bought and a gateway is connected; the assistant offers the text only once a sender exists and the clinic's registration is complete. A clinic that never switches it on never registers anything.
- **Default off.** The clinic turns it on in the wizard or in Settings, and can turn it off at any time; off takes effect on the next call.

**Full payment.** If the clinic's gateway is connected, the assistant can ask for the whole price of a service instead of a deposit, on the channels that send a link (web chat and Meta in the conversation, voice by the text above). It uses the same hosted checkout and the clinic's own price list, never takes card numbers, and never names a treatment to the gateway. It is available only when:

1. a payment gateway is connected,
2. the clinic's calendar is connected, so the assistant can write the booking itself, and
3. Auto-confirm bookings is on, because a payment must never be taken for a slot that staff may still decline.

Turning Auto-confirm off, disconnecting the calendar or disconnecting the gateway returns the setting to Deposit only in the same moment and tells the clinic why. Full payments are payments taken through the clinic's own gateway: claims copy calls them that, never revenue, and the wording is settled in the copy review.

**Both booking modes, every channel.** A clinic whose calendar is connected can let the assistant book directly on every channel it has switched on, or can keep a person in the loop: Auto-confirm off turns every booking on every channel into a request staff approve. The mode is one clinic-wide choice, not a per-channel one. Direct booking on the Meta channels waits for the direct-booking switch (DB-1) and a ruling on stating a time there; until then Meta takes booking requests.

**How the portal explains it.** Each of these settings is a plain toggle. Whenever one is unavailable or changes what another can do, the portal shows a short animated explanation beside it: why it is greyed out and what unlocks it, and what happens when it is switched on or off. The animations explain; they never decide anything, and the page works fully without them.

### Where bookings are written

Google Calendar is the single write target for every clinic, on every channel. Healdesk connects to Google Calendar by OAuth in the onboarding wizard and writes nothing anywhere else. No Mindbody API, no Boulevard API, no partner approval queue, no per-location API fees.

The clinic keeps whatever booking system it already uses and links it to the same Google Calendar. That is a setting in their system, not a Healdesk integration.

### What the hub model does and does not guarantee

The direction of each vendor's sync decides whether a Healdesk booking is visible to the clinic's own system. This is not uniform, and it has to be checked per clinic at onboarding rather than assumed.

| Clinic's system | Does a Healdesk event in Google block the slot there? | Notes |
| --- | --- | --- |
| Google Calendar alone | Yes | Nothing to reconcile |
| Calendly | Yes | Calendly reads connected Google calendars for conflicts, so a Healdesk event removes that slot from their booking page |
| Cal.com | Yes | Same conflict-checking model |
| HighLevel | Yes | HighLevel's [own documentation](https://help.gohighlevel.com/support/solutions/articles/155000002374) states it blocks any slot holding an event marked busy in a Google calendar the clinic turns on as a conflict calendar. Google marks a Healdesk event busy by default, so it removes that slot |
| Mindbody | No | Mindbody's own documentation states the integration runs one direction only, Mindbody to Google. Events created in Google do not sync back |
| Boulevard | Unverified | Treat as no until confirmed in writing |

### What this means in practice

For clinics whose system reads Google for conflicts, the hub model works exactly as intended: the AI books into Google, their booking page stops offering that slot, no double booking.

For clinics on a one-way system such as Mindbody, a Healdesk booking sits in Google where staff can see it, but their own software does not know about it and can book over it. Two options, set per clinic:

- Write to Google and have staff mirror it into their system. Workable for low volume, and honest, but it is manual work.
- Run manual booking mode: the agent collects the preferred time, logs the request and alerts staff, who confirm in their own system.

Do not sell live calendar booking to a one-way clinic without saying which of these applies. A double booking created by the AI is the single most damaging failure this product can produce.

Every booking write is idempotent. A retried request, a duplicate webhook or a repeated tool call returns the original booking. It cannot create a second appointment. Slots are locked for 60 seconds at the moment of confirmation so two patients cannot take the same time.

### Provider-level booking

A single-injector clinic and a three-provider clinic are different products, so this is a clinic setting rather than a Healdesk assumption.

| Setting | What the agent does |
| --- | --- |
| Generic slot | Books the service into one shared calendar. The clinic assigns the provider itself. Right for solo operators and for clinics whose staffing changes week to week |
| Provider-specific | Offers and books against a named provider's availability, and can honour a patient asking for the person they saw last time |

Provider-specific booking needs one calendar per provider and a service-to-provider mapping, both collected in the wizard and editable in the portal. Where a clinic has neither, generic is the default and the agent never implies a named provider it cannot guarantee.

The portal is also where a clinic changes which calendar the assistant writes to, including reconnecting after a broken authorisation, without contacting support.

## Quality: audit, correction and drift

The assistant speaks to patients on a clinic's behalf. Three mechanisms keep it honest: a test it must pass before going live, a way to fix it when it is wrong, and a way to notice when the world moved underneath it.

### The pre-launch audit

Generated per clinic from its own profile, not a generic script. The agent must pass every case before any channel answers a patient.

| Case | What is checked |
| --- | --- |
| A price that is in the menu | Quoted exactly, no rounding, no invention |
| A price that is not in the menu | Pivots to booking a consultation. Never guesses |
| A straightforward booking | Correct slot held, correct booking written, correct confirmation spoken |
| A booking for a deposit-required service | Follows the clinic's configured deposit behaviour exactly |
| A clinical question | Declines and routes. No advice, no reassurance that reads as advice |
| A complication report | Short-circuits to the fixed response and fires the escalation |
| An off-topic or hostile caller | Stays in role, does not argue, ends politely |
| A question the clinic's profile cannot answer | Says so and offers the human route rather than improvising |
| A non-English caller, where the clinic serves them | Answers in that language and stays in it |

Pass means every case. A single failure routes to a short internal review before launch, not an automatic approval with a warning.

The same audit re-runs automatically whenever the clinic's knowledge changes: a price edit, a new promotion, a new never-say entry. A clinic that edits its prices at 6pm should not discover at 9am that the agent now contradicts itself.

### When the agent gets something wrong

It will happen, and the clinic's trust depends far more on what happens next than on the error itself.

- Every conversation in the portal carries a **Flag this answer** control. One click, optional note.
- A flag writes the correction into the clinic's quick answers immediately, so the same question is answered correctly on the next call rather than after a support cycle.
- The flag also opens an internal ticket. Two flags from one clinic in a week is an alert, not a statistic.
- Flagged conversations get their own view in the portal so the clinic can see that its corrections landed.

### Price and knowledge drift

The most damaging quiet failure is an agent confidently quoting last quarter's price.

- The clinic's public site is re-scraped monthly and diffed against the stored profile.
- Differences surface in the portal as a short confirm-or-ignore list: three prices changed, one service added, hours changed on Saturdays.
- Nothing updates automatically. The clinic confirms. An agent that silently changes its own prices is worse than one that is out of date.
- The same check flags a service that disappeared from the site, which usually means it is no longer offered.

## Onboarding principles

Seven rules. Every path below obeys them, and any new step has to justify itself against them.

1. **Never ask twice.** Everything scraped during the demo is already in the wizard. The clinic corrects, it does not type.
2. **Never ask for anything the clinic has to go and find.** No API keys, no account IDs, no tax IDs. Every connection is a login button.
3. **One screen, one decision.** Each step asks for one thing and shows what it unlocks.
4. **Nothing blocks anything else.** A clinic that cannot set call forwarding today still gets its web chat live today. Steps never queue behind each other.
5. **No dead ends.** Every step has a skip that says what it costs. Skipped steps come back as a single reminder in the dashboard, not as a blocked account.
6. **Say what is live and what is not.** Per-channel status, visible, honest, in the dashboard and in the welcome email.
7. **The clinic never waits on a human at Healdesk.** Automated build, automated quality audit, human review only when the audit flags something.

The promise given at checkout is under fifteen minutes of the clinic's attention. It is not a promise that every channel is answering patients fifteen minutes later, because two of them depend on actions outside Healdesk's control.

## The shared spine

Every package runs through the same five stages. Only the connection steps differ.

### Stage 0, before they pay

The demo already scraped the clinic's site into a structured profile: services, prices, hours, providers, policies, FAQs. That profile carries into the wizard, so the clinic arrives at a form that is already 80 percent filled with its own words. The purchase flow also reads the website the buyer gives, so a buyer who skipped the demo arrives pre-filled too.

**When the scrape fails, or there is nothing to scrape.** Some sites block crawlers, some return unusable markup, and some clinics have no website at all. None of that should end the onboarding.

- A three-field fallback form: top services with prices, opening hours, and the one thing patients ask most. That alone produces a working agent, and the rest is filled in afterwards from the portal.
- A clinic with no website is a strong candidate for voice, not a weak one. Its front desk is the phone. Web chat is simply not sold to it.
- Scrape failures surface in the internal queue with the site that broke, so a pattern in a lead segment is visible rather than silent.

**The demo instance.** The pre-sale demo runs on the same scrape and the same engine, under its own cost caps, abuse limits and a short purge cycle for anything typed into it. That specification lives in the demo and sales-cycle documents; what matters here is that the profile built during the demo carries into the wizard, so nothing is asked twice.

### Stage 1, payment

Stripe Checkout charges the setup fee only. Monthly billing starts the day the assistant first answers a patient. Until then the subscription carries a $0 monthly line, so nothing is a trial, and until every channel in the package is in service the monthly price is that of the channels in service. The agreement (a business associate agreement, or a data protection agreement for a practice HIPAA does not cover) is accepted inline before checkout completes, with version, timestamp and IP stored. On the first paid invoice the account is created and the browser lands in setup. Provisioning is gated on the invoice being paid, never on the checkout session alone. A channel is sold only once it is ready, so there are no opening dates: one that is not ready comes off the product list. The setup fee is never refunded, and the purchase page says so before payment. The clinic then has 30 days to finish setup. While no channel is answering patients it gets a reminder every five days, six in all, and if none is by the end of the 30th day, the subscription is cancelled with nothing refunded and the account is closed, keeping only the signed agreement and the billing records the law requires.

### Stage 2, the wizard, under fifteen minutes

Four steps, in this order, because each one is more likely to be abandoned than the last.

| Step | What the clinic does | Time |
| --- | --- | --- |
| 1. Confirm the basics | Reviews the pre-filled name, what patients call the practice, address, hours, services and prices. Edits anything wrong | 3 to 5 min |
| 2. Set behaviour | Tone, greeting, deposit toggles, voice coverage mode, the direct line and the urgent-help number | 3 min |
| 3. Connect the calendar | One Google login | 30 sec |
| 4. Connect the channels | One login per channel bought. Skippable individually | 1 to 3 min |

Step 1 carries the most value and the least friction, which is why it comes first. If the buyer was not sure whether the practice bills any health insurance electronically, step 1 asks again, and the answer is recorded as the practice's notice. Payment gateway connection is folded into step 2 as a toggle: clinics that want deposits connect their gateway, clinics that do not skip it and the agent books without one.

**Leaving and coming back.** Every step saves as it is completed. A clinic that stops at step three can close the tab and resume from the link in its welcome email, and the portal shows exactly where it stopped. Whatever was already connected stays live in the meantime. Abandonment is not a broken account, it is a partially live one.

**More than one location.** Healdesk is sold per location, one per purchase. Each location has its own hours, its own number, its own calendar and its own agent configuration. More locations are added from Billing at the plan's price again plus its setup fee once, on the same subscription and renewal date, with the allowances pooled. When the website lists several locations, the wizard's first screen asks which one this setup is for.

### Stage 3, the build, no clinic involvement

The profile compiles into a system prompt with the clinic's do-not-say list and the standard clinical guardrails. Channels are provisioned. An automated test conversation runs benchmark questions against the new agent: a price question, a booking, an off-menu clinical question, a complication report. If it passes, the agent is approved automatically. If anything is flagged, it goes to a short internal review before any channel answers a patient.

No channel goes live before its audit passes. This is the difference between fast and reckless. The clinic watches the build on a tracker on Home, and once every stage is done it can talk to its own assistant in a preview, where nothing reaches patients and nothing is booked.

### Stage 4, handoff

One welcome email: receipt, dashboard link, per-channel status, and only the actions still outstanding. A clinic with nothing outstanding gets no instructions at all.

## Web chatbot onboarding

The simplest path. Nothing outside Healdesk has to approve anything.

| Step | Who | Time |
| --- | --- | --- |
| Confirm the profile | Clinic | In the shared wizard |
| Connect Google Calendar | Clinic, one login | 30 sec |
| Agent built and audited | Automatic | Under a minute |
| Copy the embed snippet | Clinic, or sent to their web person | 1 min |
| Paste it on the site | Clinic or their developer | Out of Healdesk's hands |

### Smoothness details

- The embed snippet is shown on screen, emailed, and available in the dashboard forever. It is one line.
- A "send this to my web person" button emails the snippet with a two-sentence instruction, so a non-technical owner never has to relay it themselves.
- The dashboard detects the first time the widget loads on the clinic's domain and flips the channel to live automatically. Nobody has to confirm it worked.
- A preview link lets the clinic talk to their own bot before it is on their site.

### Realistic timing

Live within minutes of the wizard, except for the paste step. Where a clinic has no website, this channel is not sold.

## Voice agent onboarding

Everything here is automatic except one step, and that one step is the most common place a voice deployment quietly dies.

| Step | Who | Time |
| --- | --- | --- |
| Pick the coverage mode | Clinic, three buttons | 30 sec |
| Confirm opening hours | Clinic, pre-filled from the scrape | 1 min |
| Number allocated in the clinic's area code | Automatic | Seconds |
| Agent built, voice and greeting set, audit run | Automatic | Under a minute |
| **Set call forwarding on the clinic's line** | **Clinic, with their phone carrier** | **5 to 15 min, and it is theirs to do** |
| First test call | Healdesk places it, clinic hears it | Immediate |

### The forwarding step, treated properly

This is the only part of the whole product that requires the clinic to touch something Healdesk cannot reach. It gets its own screen:

- The new Healdesk number is displayed large, with a copy button, once voice is ready for that clinic, and emailed then. Before that, the screen says not to change call forwarding yet.
- The clinic picks its carrier or phone system from a list. Exact dial codes and click paths appear for that carrier, matched to the coverage mode chosen: forward-all for full coverage, busy and no-answer forwarding for overflow, scheduled forwarding for after hours only.
- A "send these instructions to my office manager" button, because the owner buying the product is often not the person who administers the phone line.
- A "book a five-minute call and we will do it with you" option. This is worth a human's time; a clinic that never forwards never sees value and churns in month one.

Two things shrink this step rather than just documenting it. The number is shown only once voice is ready for that clinic, so nobody forwards calls to an assistant that cannot answer yet; from then on the steps can be sent to the office manager in one click. And the assisted option is offered as a normal choice on the screen, not as a rescue after a failure: a five-minute call at a time they pick, presented with equal weight to the do-it-yourself instructions. The cost of that call is trivial against a clinic that never forwards and churns in month one.

### Confirming it worked

The dashboard shows the voice channel as waiting for forwarding until Healdesk receives a first forwarded call. Then it flips to live by itself. Healdesk also triggers a test call within five minutes of the channel going live so the clinic hears its own agent immediately.

A clinic on an active voice plan receiving zero inbound calls for fourteen consecutive days is flagged internally. That is silent churn, and it is almost always forwarding that was set up, then removed or broken.

### Realistic timing

Live the same day if the person who controls the phone line is available. Not two minutes, and the copy must not say two minutes.

## Meta bot onboarding

Healdesk clears Meta's review once, for everyone. No clinic ever submits anything to Meta.

### Instagram and Messenger

One button: log in with Facebook. The clinic picks its Page and its linked Instagram professional account, approves the permissions, and the channel is connected. Healdesk subscribes the webhooks, maps the Page and Instagram IDs to the tenant, and runs the audit.

| Step | Who | Time |
| --- | --- | --- |
| Log in with Facebook, pick Page and Instagram account | Clinic | Under a minute |
| Webhooks subscribed, IDs mapped, agent audited | Automatic | Seconds |
| Live | Automatic | Immediate |

The common snag is not technical: the person doing the wizard may not be an admin of the clinic's Facebook Page. The wizard detects this and offers to send an invite link to whoever is, rather than failing with a permissions error.

A second snag worth pre-empting: an Instagram account that is still personal rather than professional. The wizard checks, and if it is personal it shows the three taps needed to switch, in the Instagram app, with no jargon.

### WhatsApp

Heavier, and honest about it. The clinic connects through Meta's embedded signup inside the wizard, which creates or links its WhatsApp Business account and verifies a number.

| Step | Who | Time |
| --- | --- | --- |
| Embedded signup: pick or create the WhatsApp Business account | Clinic | 2 to 5 min |
| Verify the phone number by SMS or call | Clinic | 2 min |
| **Attach a payment method to their WhatsApp account** | **Clinic** | **2 min, and it is required before a single message can send** |
| Webhooks subscribed, number mapped, audited | Automatic | Seconds |

The payment method step surprises people, so the wizard states it up front rather than at the end: Meta bills the clinic directly for WhatsApp messages, Healdesk does not resell them, and the account cannot send until a card is attached.

One constraint to plan around: a number already in use with the WhatsApp Business app may stay on the app and connect here too, through Meta's coexistence option. US support for coexistence is still to be confirmed. Without it, a number cannot be on two WhatsApp platforms at once. Ask which number the clinic intends to use before they start, not halfway through.

### Realistic timing

Instagram and Messenger: live inside the wizard. WhatsApp: live inside the wizard for a clinic that has its billing details and the right number to hand, later the same day for everyone else.

## Full suite onboarding, all channels at once

The suite is not four onboardings stacked. It is one wizard with four connect buttons, and the channels come alive as each connection lands.

### Order on screen

Fastest first, so the clinic sees something working before it hits anything that needs effort.

1. Profile confirmation
2. Behaviour and escalation settings
3. Google Calendar
4. Facebook login, which connects Instagram and Messenger together
5. Web embed snippet
6. WhatsApp embedded signup
7. Call forwarding

Steps 6 and 7 are the two that can take a clinic beyond the wizard, so they sit last and are explicitly skippable with a one-line note about what stays dark until they are done.

### What the clinic sees at the end

A status board, per channel, honest:

| Channel | Typical state at the end of the wizard |
| --- | --- |
| Web chat | Live, or ready with the snippet waiting to be pasted |
| Instagram | Live |
| Messenger | Live |
| WhatsApp | Live, or waiting on the clinic's billing details |
| Voice | Ready, waiting on call forwarding |

No channel is ever shown as live before it is. A false green light in week one costs more than a missing one.

### The first 48 hours

- Healdesk places a test call and sends a test DM within five minutes of each channel going live, so the clinic experiences its own agent rather than reading that it exists.
- While no channel is live, a reminder goes every five days, six in all, naming the single action outstanding, and for voice the offer of a five-minute call. Once a channel is live, any other channel still not live after 48 hours triggers one reminder of the same kind.
- An account with zero interactions on any channel after 48 hours is flagged internally. Something is wrong with the deployment, not with the clinic.

### Honest headline timing

| Promise | True? |
| --- | --- |
| Fifteen minutes of the clinic's attention | Yes |
| Chat channels answering patients the same session | Yes |
| Voice answering the same day | Usually, if the phone line admin is reachable |
| Everything live in under two minutes | No. Do not say it |

## Changes to the existing onboarding documents

The flow documents already written stand, with five corrections that follow from decisions made since.

| Existing step | Correction |
| --- | --- |
| Wizard step 2: calendar OAuth for Boulevard, Mindbody, Google Calendar | Google Calendar only. The clinic links its own booking system to that calendar. See the booking section for which systems this protects and which it does not |
| Wizard step 3: Stripe Connect as a required step | Folded into the behaviour step as an optional toggle. Clinics that do not want deposits skip it and the agent books without one |
| Delivery engine: email plus SMS | Email only, apart from the one optional payment-link text after a call |
| Omnichannel deployment: bots go live instantly, under two minutes total | True for the chat channels. Not true for voice, which waits on call forwarding, or for WhatsApp, which waits on the clinic attaching billing. Replace with per-channel status |
| Final delivery email: phone number routing instructions | Keep, but promote it. Forwarding is the highest-risk step in the whole onboarding and deserves its own screen, its own carrier-specific instructions and the offer of a call |

One addition the existing documents do not have: **voice coverage mode**. It belongs in the behaviour step, because it changes both the forwarding instructions shown later and what the agent says about availability.

## Account access and credentials

The clinic never creates a password and never receives one: every sign-in is an expiring email link. Each clinic has one email address (a shared inbox such as info@ is fine), which is its sign-in, its billing email, the agreement's notice address and where every notification goes (owner decision, 6 October 2026).

### How they get in

1. Payment completes. The account is created against the clinic's address, and the browser lands on the welcome page, already signed in through a one-time link. Its first screen protects patient details with Face ID, a passkey on that device, and then setup starts. No login screen between paying and starting.
2. The welcome email contains a sign-in link, never credentials. There is no password anywhere: every later sign-in is an expiring email link, and a session lasts 14 days.
3. A passkey, with an authenticator-app backup, is required before anyone opens a conversation or a booking, since that is where patient information sits, and it lapses after 15 minutes idle. Each phone or computer adds its own passkey, so the access log names the device. Toggles, billing and knowledge edits do not require it, except where calls and money go: the direct line, the transfer number, the clinic's address, the payment account and exports.

### Who gets access

One sign-in per clinic in v1, shared by its staff. The three named roles below are deferred past v1 (owner decision, 6 October 2026). Until they arrive, the one sign-in can do everything, and the passkey still guards patient information:

| Role | Gets | Why separate |
| --- | --- | --- |
| Owner | Everything, including billing and cancellation | The person who bought it |
| Manager | Everything except billing | The person who actually runs the front desk day to day |
| Billing contact | Invoices and payment method only | Often a bookkeeper who should not read transcripts |

Dunning and payment warnings go to the clinic's address, like every other email (owner decision, 6 October 2026).

When someone leaves, "Someone left" signs out every session and resets the authenticator backup, and removing a device ends its sessions. Team invitations arrive with the roles.

### Losing access

Sign-in link expired, owner left the business, email no longer monitored: one "I cannot get in" route on the sign-in page. It checks the billing details on file and sends a sign-in link to the clinic's address; it never adds a device. Losing the address itself goes to a human: a call to the clinic's published number, then a change of address that takes effect after 72 hours, with notice to the old address and the new one. This is the single most common support ticket in any portal, and its first case should not need a support conversation.

## Admin portal principles

The user is a clinic owner or a front-desk manager between patients. They are not configuring software, they are changing one thing quickly.

1. **Switches, not settings.** Anything that can be a switch is a switch. Anything that needs a form is a short one with real examples pre-filled.
2. **Every switch says what it does in one line underneath.** Not a tooltip, not a help article. A sentence in plain language, visible without hovering.
3. **Changes take effect immediately and say so.** A small confirmation that names the consequence: "Upsells off. The agent will stop suggesting add-on treatments from now on."
4. **No jargon.** No webhooks, no tokens, no API, no tenant. Channels have the names patients use: phone, website chat, Instagram, Messenger, WhatsApp.
5. **One dangerous action, clearly marked.** Pause the AI. Everything else is reversible and unremarkable.
6. **Mobile first for the switches.** The pause switch and the promotions box will be used from a phone, standing at the desk.
7. **Nothing hidden behind support.** Anything the clinic may reasonably want to change, they can change themselves.

## Portal map

Six screens: Home, Settings, Knowledge, Conversations, Bookings and Billing. Nothing nested more than one level deep, and Help on every screen.

### 1. Home

What happened, and is everything working.

- Per-channel status: live, paused, or waiting on something, with the outstanding action named. Before go-live, the build tracker, then Talk to your AYA: a preview of the clinic's own assistant, where nothing reaches patients and nothing is booked.
- This week in three numbers: conversations handled, appointments booked, deposits collected.
- Anything needing attention: a broken calendar connection, an expired login, an unpaid invoice, a channel that has gone quiet.
- The **AYA is answering** switch in every screen's header. Off pauses for an hour, until tomorrow morning, or until it is switched back, and a banner shows when and from which device it was paused.

### 2. Settings

Every switch on one page, in cards: channels, how the assistant talks, calendar, payments, the safety net, alerts and sign-in. Each bought channel's card shows on or off, its status, and the connect or reconnect button. Voice carries its coverage mode selector. Website chat carries the embed snippet with a copy button. The switches are listed in full in the next section.

### 3. Knowledge

Quick edits, no re-scrape needed.

- **Prices**: a table of services with an editable price and duration.
- **Promotions**: a plain text box. What is written here is what the agent will offer. Empty by default.
- **Quick answers**: two columns, question and answer, for temporary things like parking during building work.
- **Never say**: a list of phrases the agent must never use. Pre-seeded with the clinical defaults and editable.
- **Hours**: including holiday closures, which drive both the agent's answers and the voice forwarding schedule.

### 4. Conversations

Every call, chat and DM, searchable, with the outcome and whether it produced a booking. The words are not kept: each call's and web chat's transcript is emailed to the clinic when it ends, and can be sent again only until its delivery is confirmed; after that a receipt without the words shows when it was sent and delivered. Second factor required to open one. Export available.

### 5. Bookings

What the AI booked, with deposit status, and the queue of anything flagged for manual deposit collection or manual confirmation. This is the screen that proves the product is working, so it should be one click from Home.

### 6. Billing

Current plan, channels included, renewal date, next invoice amount, and before the plan starts, the date by which setup must be finished. Until every channel in the package is in service, the plan is billed at the price of the channels that are. Usage meters: minutes used against included, conversations used against included, any overage in dollars, days left in the cycle. Overage handling switch. Upgrade and add capacity here. Invoices and the payment method deep-link into Stripe's own portal rather than being rebuilt. Cancellation is the Auto-renew switch, not Stripe's portal: off cancels at period end, and before the plan starts it means the plan never starts and nothing more is charged.

## Every switch in the portal

Settings shows the Channels, Behaviour and Escalation switches below as cards on one page. Billing keeps its three switches.

### Channels

| Switch | Options | Default | Effect |
| --- | --- | --- | --- |
| AYA is answering (pause) | On / Off for 1 hour, until tomorrow morning, or until switched back | On | Off stops the assistant answering on every channel at once. Calls fall through to the clinic's own line, the website widget becomes a contact form, DMs go unanswered for staff to see. Nothing is lost, it is fully reversible |
| Phone | On / Off | On | Turns the voice agent on or off on its own |
| Voice coverage | All calls / Overflow and after hours / After hours only | Overflow and after hours | Changes which calls reach the agent. Shows the matching forwarding instructions again whenever it is changed |
| Website chat | On / Off | On |  |
| Instagram | On / Off | On |  |
| Messenger | On / Off | On |  |
| WhatsApp | On / Off | On |  |

### Behaviour

| Switch | Options | Default | Effect |
| --- | --- | --- | --- |
| Tone | Clinical and professional / Warm and welcoming | Warm | Changes how the assistant speaks on every channel |
| Phone greeting | Text field | Pre-filled from the clinic name | The first line a caller hears |
| Chat greeting | Text field | Pre-filled | The first line in chat and DMs |
| What patients call you | Text field, up to 40 characters, plain words | Worked out from the clinic name ("Lumen" for "Lumen Aesthetics & Wellness"), pre-filled in step 1 | The short name the assistant uses after saying the full name once, on every channel. The opening line, emails, the agreement and billing keep the full name. Screened like a greeting: no clinical words, nothing on the never-say list. On Instagram, Messenger and WhatsApp it is used only when it is a part of the full name and names no treatment |
| Suggest add-on treatments | On / Off | Off | On lets the assistant suggest complementary treatments and products during a booking. Off keeps it to what was asked |
| Mention promotions | On / Off | On | Whether the promotions box is used in conversation |
| Take deposits | On / Off | Off until a gateway is connected | Whether the assistant can send a payment link at all |
| Text the payment link after a call | On / Off | Off | Voice only. After a call booking the agent offers to text the caller a hosted payment link, and sends it only if the caller says yes and reads the number back. The switch is usable whenever phone is bought and a gateway is connected; the assistant offers the text only once a sender exists and the clinic's registration is complete |
| What the assistant asks the patient to pay | Deposit only / Full payment | Deposit only | Full payment sends the whole price of the service from the clinic's own list through the same hosted checkout. Greyed out unless a gateway and a calendar are connected and Auto-confirm bookings is on |
| Book by phone without a deposit | On / Off | On | Off means the voice agent will not book a deposit-required service and routes to staff instead |
| Book by chat without a deposit | On / Off | Off | Chat channels can take payment, so the default protects the slot |
| When a deposit cannot be collected | Book and flag / Hold the slot and alert staff / Do not book and alert staff | Book and flag | Applies to any channel that cannot collect in the moment |
| Auto-confirm bookings | On / Off | On | Off makes every AI booking a request that staff approve. Useful for a nervous clinic in week one, and the honest setting for a clinic whose booking system does not read the Google calendar |
| Booking detail | Generic slot / Named provider | Generic | Whether the assistant books into a shared calendar or against a named provider's availability. Named provider requires a calendar per provider and a service-to-provider mapping |
| Connected calendar | Connect / Change / Reconnect | Set in the wizard | Which calendar the assistant writes to. Changing or reconnecting it never requires contacting support |
| Languages | Multi-select | English | Which languages the assistant handles. It answers in the caller's language and stays in it |

### Escalation

| Switch | Options | Default | Effect |
| --- | --- | --- | --- |
| Urgent alerts | The clinic's address | Always on | Where a complication or urgent symptom goes, immediately, as a pointer into the portal |
| Handover requests | The clinic's address | Always on | Where "I want to speak to a person" goes |
| Transfer live calls | On / Off | Off | On lets the voice agent transfer a caller to a real number during opening hours |
| Transfer number | Phone number | Blank | Only used when the above is on |
| Daily summary email | On / Off | On | Sent at the start of each working day: what the assistant handled, booked and escalated, every booking and booking request with its link, and every request still open. The week's first summary carries the weekly recap |

### Billing

| Switch | Options | Default | Effect |
| --- | --- | --- | --- |
| When the monthly allowance runs out | Keep going and bill the extra / Stop and fall back | Keep going | Keep going bills the extra in blocks of 100 minutes or 100 conversations. Stop and fall back means calls forward to the clinic's line and chat becomes a contact form rather than producing a surprise invoice |
| Usage alerts | On / Off | On | Emails at 90 percent and 100 percent of the included amount; at 90 percent the clinic can move up a step or let the next 100 bill at the extra-100 price |
| Auto-renew | On / Off | On | Off is a cancellation at period end, reversible until the date |

Defaults matter more than the switches. A clinic that changes nothing should get a conservative, safe assistant: warm tone, no upselling, no deposits until a gateway is connected, alerts switched on.

## Support chat in the portal

A small chat bubble on every screen. Same engine as the product, pointed at Healdesk's own documentation instead of a clinic's.

Help also offers a support phone line on Healdesk's Retell number, whose agent keeps only basic call attributes (Retell's Basic Attributes Only storage: the caller and the time, no recording or transcript) and emails Healdesk that a call came in, so Healdesk can call back; and email to support@healdesk.io or hello@healdesk.io, one mailbox.

A clinic's email to either address becomes a support case. Healdesk keeps none of its words: the database holds only facts (the topic, the urgency, counts of what looked like patient details). The message itself is received by Amazon under the AWS agreement and held encrypted until the support assistant has read it to draft a reply, sending its text to Anthropic's API under the signed BAA, keeping nothing of it; then it is deleted, normally within minutes. When no draft will be made (drafting switched off, or the request already drafted) it is deleted on arrival. An hourly sweep deletes anything older than six hours (so up to about seven), and Amazon's one-day expiry (up to about two days) is the backstop. A person at Healdesk approves every reply before it goes, and reads the original in Healdesk's own mailbox: Healdesk's console never shows the email itself, but it does show the drafted reply, which is written from the email, so a patient detail the assistant repeated past the automated checks can reach the console, which is not covered by a BAA, and, once the owner connects it, the owner's Slack channel, where the drafted reply (never the clinic's email) is shown to approve with the approval passcode; Slack signs no BAA either (owner, 26 October 2026). The clinic gets a fixed acknowledgement with its reference.

### What it does

- Answers how-to questions: how to change the greeting, why a channel is not live, what a switch does, how to read an invoice.
- Knows the state of the account it is sitting in, so "why is my phone not working" gets "your forwarding has not been set yet, here are your carrier's steps" rather than a generic article.
- Handles the most common ticket categories without a human: forwarding help, reconnecting a calendar, changing a plan, getting a transcript sent again.
- Escalates to a person by email with the account context attached, and says plainly when it is doing that.

### One rule that has to be in the interface

Staff will paste patient details into a support chat if nothing stops them. The input carries a permanent line: this is product support, do not paste patient information here. The support chat is scoped as a non-patient channel and stores nothing: the browser holds the conversation, and an escalation emails Healdesk structured fields, never the chat's text.

### Why it belongs in the portal rather than email

A clinic that cannot find how to turn off upselling at 7pm on a Friday will not open a ticket. It will decide the product is confusing. An in-portal answer in ten seconds is worth more than a fast email reply on Monday.

## What the portal does not have

Every one of these is a deliberate omission. Adding them turns a tool a manager can use into software that needs training.

| Not included | Why |
| --- | --- |
| Prompt or script editing | Guardrails live in the prompt. A clinic editing it can remove them without realising. Tone, greeting, promotions and never-say cover the real need |
| A flow builder | Nobody buying a done-for-you service wants to build conversation trees. If they did, they would buy a builder |
| Per-channel behaviour differences | One assistant, same answers everywhere. Divergence across channels is how a clinic ends up quoting two prices |
| A live chat inbox for staff to take over conversations | Real, but v2. Pause AI covers the emergency case for now, and a half-built inbox is worse than none |
| Outbound campaigns | Not in v1 at all, so the screen would only advertise something they cannot have |
| Raw analytics dashboards | Three numbers on Home and a full conversation list. A clinic owner wants to know it is working, not to slice data |
| Immediate cancellation in-app | Cancellation is at period end, reversible with one click until the date. Immediate cancellation goes through support so a retention conversation happens |
| Direct calendar or EMR configuration | One Google connection. Anything more belongs in the clinic's own system |

## Email

Every email goes to the clinic's one address and can be replied to; replies reach hello@healdesk.io. Anything about a patient is a pointer into the portal: never a name, number, time, service or any words from a conversation. Booking requests go out the moment they are made, at any hour, and the daily summary arrives at the start of each working day. The internal health flags stay internal. An incident report reaches a clinic only when Healdesk's operators send one, within the agreement's deadlines. Product email comes from hello@healdesk.io and marketing from noreply@healdesk.io (owner decisions, 6 October 2026).

## What v1 cannot do

Every line here is a deliberate scope decision with a reason. None of it should appear in sales copy.

| Not in v1 | Why |
| --- | --- |
| Appointment reminders | Outbound. Also blocked on Messenger since the relevant message tags were withdrawn effective 27 April 2026 |
| No-show and cancellation follow-up | Outbound |
| Reactivation of lapsed patients | Outbound |
| Missed-call text-back | Outbound, and requires SMS |
| Post-treatment check-ins and review requests | Outbound |
| Warm-lead follow-up after a conversation ends | Outbound, and structurally impossible on Meta outside the 24-hour window |
| SMS as a channel at all | US carriers block unregistered application messaging outright. Registration is per clinic, tied to each clinic's own tax ID, and takes one to four weeks per client. That does not fit a same-week onboarding |
| Voice sending a booking link | Never. The agent books on the call. A payment link by text after a call is the one optional exception (owner, 28 October 2026) |
| Taking card details by voice or chat | Never. Payment always goes through a hosted checkout the patient opens |
| Live writes into Mindbody or Boulevard | Their APIs require partner approval, per-clinic activation and per-location fees. Phase two |
| Clinical advice, diagnosis, prescribing or treatment plans | Out of bounds permanently, not just in v1 |
| Any PHI on Meta channels | Meta signs no business associate agreement for any WhatsApp or Meta messaging product, and states in its Cloud API terms that it is not a business associate. No vendor can change this |

### The one honest gap

A patient who texts the clinic gets the same experience they get today: a human replies when staff get to it. The AI does not cover SMS in v1. This is worth selling later as a paid add-on precisely because it carries a real per-clinic setup cost.

## Guardrails

Guardrails are enforced in code around the model, not written into a prompt and hoped for.

- No diagnosis, no prescribing, no treatment plans, no outcome guarantees.
- No price that is not in the clinic's configured service list. An unknown price becomes an offer to book a consultation.
- Each clinic's own never-say list is injected into every conversation on every channel.
- Messages matching complication or urgent-symptom patterns short-circuit the model entirely: fixed response, immediate escalation to the clinic's address. The fixed response tells the person to call 911 in an emergency and gives the clinic's urgent-help number. The matching happens before the model sees the message, not after.
- Treatment names never appear in a payment description, a Meta message, or the support chat.
- The clinic cannot edit the prompt, so it cannot remove a guardrail by accident.
- The assistant identifies itself as an AI assistant in its opening line on every channel, and the clinic cannot turn that off

## HIPAA and BAA position

This section is the one a clinic's lawyer will read. It is written to survive that.

### Who is what

| Party | Role under HIPAA | What they sign |
| --- | --- | --- |
| The clinic | Covered entity | A business associate agreement with Healdesk |
| Healdesk, contracting as Viixi FZC | Business associate | That agreement with each clinic, plus its own agreements with every subcontractor below |
| Every vendor in the stack that touches patient data | Subcontractor | A business associate agreement with Healdesk. Required, not optional, under 45 CFR 164.308(b)(2) |

The agreement with the clinic is accepted inline at checkout, with version, timestamp and IP stored against the account. It is a blocking step; checkout does not complete without it. A practice HIPAA does not cover (a veterinary clinic, or a cash-pay practice that answers "No" to billing any health insurance electronically) signs Healdesk's data protection agreement instead, and its client data is controlled exactly as PHI. A practice that is not sure signs the business associate agreement. Veterinary practices are sold only once the veterinary urgent set and an emergency referral number are in place. A veterinary booking may record the animal's name and species.

Two things that are easy to get wrong and expensive to get wrong late:

- Buying a vendor's compliance add-on does not make Healdesk compliant. It covers that vendor's infrastructure. Healdesk still needs its own risk assessment, written policies, workforce training, a named privacy and security contact, incident response and access logs. None of that can be purchased.
- The obligations do not lapse when payment does. They persist through non-payment, suspension and cancellation, until PHI is documented as returned or destroyed.

### What data actually moves

The scoping decision rests on this table, so it is worth being precise rather than optimistic.

| Data | Where it goes | Treat as PHI? |
| --- | --- | --- |
| Caller or messager name, phone number, the treatment they asked about, preferred time | Healdesk database, the clinic's calendar | **Yes.** An identifier plus a fact about care sought from a healthcare provider. Do not assume a callback slip is exempt because it feels administrative |
| Call audio and call transcript | Voice vendor in transit; the transcript emailed to the clinic through Amazon SES with TLS required; Healdesk keeps an encrypted copy only until the clinic's mail server confirms delivery, and deletes it then; a copy with no confirmation 72 hours after it goes, or not delivered within 30 days, is deleted too. Healdesk keeps no other copy. Healdesk keeps no call audio. Our voice provider holds a call's transcript and recording only until we have the transcript, and for no more than a day | Yes |
| Chat and DM transcripts | Web chat: emailed to the clinic like a call's, the encrypted copy kept while the chat is open and until its delivery is confirmed. Meta DMs: not kept | Yes on web. On Meta channels, scoped to stay non-clinical by design |
| Calendar event | The clinic's own Google Calendar, under the clinic's own agreement with Google | Yes, and it is the clinic's system, which is the right place for it |
| Payment amount, generic descriptor, reference id | Stripe or the clinic's gateway | No, provided no clinical context travels with it |
| Anything typed into the portal support chat | Healdesk support | Must be kept non-clinical. The interface says so permanently |
| A clinic's email to support | Amazon SES and S3, encrypted, until the support assistant has read it; its text to the Claude API under the BAA for a draft reply; then deleted, normally within minutes and by the hourly sweep after six hours at the latest (about seven), Amazon's expiry as the backstop. Healdesk's database keeps facts only, never its words; the drafted reply, written from it, is shown in the operator console and, once connected, the owner's Slack channel (neither under a BAA) after automated checks | Treat as possibly PHI: a clinic may paste a patient's details despite the warnings, so every hop that carries the email itself is under an agreement; the drafted reply, which can repeat its words past the checks, is shown in the console and, once connected, the owner's Slack channel, neither of which is, by the owner's decision of 26 October 2026 |

### Vendor position, vendor by vendor

| Vendor | Role | Agreement available | Condition, and what it costs |
| --- | --- | --- | --- |
| Anthropic, Claude API | The assistant's reasoning on every channel | Yes | Anthropic provides a BAA covering its HIPAA-ready services including the first-party API. The organisation's primary owner signs and then arranges it with Anthropic. Note the trade-off: covered models require 30-day data retention and are not available with zero data retention |
| Supabase | Database, transcripts, account records | Yes | Only on Team or Enterprise with the paid HIPAA add-on. Free and Pro have no path at all. Covered projects must be marked high compliance with point-in-time recovery, SSL enforcement, network restrictions, MFA and connection logging. Team is published at $599 a month and the add-on price is not published. Cheaper providers sign the same agreement, so this is no longer the assumed choice. See the infrastructure section |
| Retell | Voice telephony and speech | **Yes, self-serve** | Retell's documentation states the BAA and the DPA are available for self-signing at its click-agreements portal, at no additional fee, and not gated to an enterprise contract. It also documents per-agent retention from 1 day to 2 years and per-agent PII controls. Some third-party comparisons still claim HIPAA is Enterprise-only; the vendor's own documentation is the better source, but confirm the executed agreement names the services in use |
| Payment-link text sender (not chosen) | The one optional text after a call ("Payment by text after a call") | **No, by scoping** (owner, 28 October 2026) | Fixed words and the clinic's own checkout link only, nothing clinical, so no business associate agreement is sought. Registration with the carriers is per clinic, takes one to four weeks, and applies only to a clinic that switches the text on. No sender is chosen and nothing sends a text yet |
| Twilio, if used for numbers | Telephony | Yes | Only on Security or Enterprise Edition, and only for the products on Twilio's eligible list. WhatsApp is explicitly not on that list |
| Google Workspace | The clinic's calendar | Yes, on paid Workspace plans, once the clinic's Workspace admin accepts it | The calendar belongs to the clinic, so this agreement is between the clinic and Google, not Healdesk and Google. The clinic's Workspace admin must accept Google's BAA, and a consumer Gmail calendar has no route to coverage. Google's BAA excludes third-party apps, so Healdesk's access to the calendar is covered by Healdesk's BAA with the clinic. Confirm per clinic |
| Stripe | Payments | **No, on any tier** | Stripe does not sign business associate agreements and does not hold itself out as one. Usable only inside the payment-processing carve-out: money, a generic descriptor and an opaque reference. No treatment name, no diagnosis, no clinical metadata, not in the description, not in the statement descriptor, not in metadata |
| Meta | Instagram, Messenger, WhatsApp | **Never** | Meta states in its Cloud API terms that it is not a business associate, and the WhatsApp Business terms disclaim suitability for healthcare. No vendor sitting in front of Meta changes this. Twilio, which resells WhatsApp, excludes it from its own eligible list for the same reason |
| AWS, where infrastructure sits on it | Hosting | Yes, and already executed | The agreement applies only to the designated HIPAA account and to HIPAA-eligible services, with encryption of all PHI required and audit logging at the highest level |

### Where the chain is complete, and where it is not

Moving voice to Retell closes what was the largest gap. Call audio from a patient to a clinic is PHI, and on Retell that path can sit under a signed agreement without an enterprise contract, which was not true of the alternative.

The chain that has to be complete before any patient data flows:

| Link | Action | State |
| --- | --- | --- |
| Clinic to Healdesk | Accepted inline at checkout | Built into the flow |
| Healdesk to Retell | Self-sign the BAA in Retell's click-agreements portal, then set per-agent retention and PII controls | Not yet done |
| Healdesk to Anthropic | Primary owner signs and activates | Not yet done |
| Healdesk to the database provider | Neon on Scale, or AWS RDS under the agreement already held. Sign, then apply the settings it requires | Not yet done |
| Healdesk to AWS, where used | Already executed, applies to the designated account and eligible services only | Done |
| Clinic to Google | The calendar is the clinic's own, under their agreement with Google | Confirm per clinic |

A single missing link means patient data is being processed without contractual cover, whatever the technical controls look like.

Two gaps stay open by design, and both are handled by scoping rather than by paperwork:

- **Meta.** No agreement exists or ever will. Instagram, Messenger and WhatsApp are scoped to carry no clinical content.
- **Stripe.** No agreement on any tier. Used only inside the payment carve-out: money, a generic descriptor, an opaque reference.

### Rules that follow from all of the above

- Collect the minimum: what a receptionist would write on a callback slip. Nothing clinical, no history, no medication, no diagnosis.
- No clinical detail in any payment artifact, any Meta message, or the support chat.
- Vendor-side call recording and transcript retention kept to the minimum: the voice vendor holds a call's transcript and recording only until Healdesk has the transcript, and for no more than a day, and the call is then deleted there.
- Transcripts are not stored: each is emailed to the clinic through Amazon SES, with TLS required, when its conversation ends, and Healdesk deletes its encrypted copy the moment Amazon SES reports it delivered, keeping a receipt without the words (when it was sent, when it was delivered, how many attempts). A copy never confirmed is deleted 72 hours after it goes; one that cannot be delivered, after 30 days. No other copy is kept anywhere. The conversation record, without the words, keeps a 90-day clock. Demo sandbox transcripts purge on a 7 to 14 day cycle whether or not the lead ever buys.
- Second factor before any conversation or booking can be opened, and an access log of who opened what.
- Offboarding is export first, then destroy, on a clock that matches the agreement text.
- Breach notification runs to the clinic without unreasonable delay and inside 60 days, and vendor notices flow upward into that obligation.
- Non-payment never produces a dead phone line. Every degradation path, whether a usage cap, a suspension or a cancellation, ends with calls forwarding to the clinic's own line. A patient calling a medical clinic must always reach someone

### Five rules that are not optional

**The assistant always says it is an assistant.** On every channel, in the opening line, before anything else. Several US states now regulate generative AI in patient communications and require disclosure, and a voice agent answering a clinic's line without identifying itself is a live exposure separate from HIPAA. This is a guardrail, not a setting: the clinic cannot switch it off, and it cannot be edited out through the greeting field. Confirm the current state-by-state position before launch rather than assuming this one line covers every jurisdiction.

**Patient data will arrive on channels that cannot carry it.** Scoping Instagram, Messenger and WhatsApp as non-clinical is a design intention, not something patients will cooperate with. Someone will type a diagnosis into a DM in the first week. The behaviour has to be built, not hoped for:

- Detect clinical content at the channel boundary, before it is stored.
- Do not persist it, do not echo it back, do not carry it into the conversation summary.
- Have the assistant move the conversation: offer a call or the clinic's own secure route, and say why in one plain sentence.
- Voice has vendor-side redaction available at about a penny a minute. The Meta side needs the equivalent built, because nothing in the platform provides it.

**The model retention rule contradicts minimum retention, and the contradiction has to be disclosed.** Anthropic's agreement covers the first-party API, but its covered models require 30-day data retention and cannot run with zero retention. Everywhere else this document pushes retention down. Both are true at once: state the 30-day window in the clinic-facing agreement, explain why it exists, and do not let a clinic's counsel be the one who discovers it.

**Breach response is a written procedure or it is nothing.** The agreement commits Healdesk to notifying the clinic without unreasonable delay and inside 60 days. That obligation needs a named person, a defined trigger, a log, a template notice and a rule for vendor notices arriving from Retell, Anthropic or the database provider and flowing upward. Write it before signing an agreement that promises it.

**Call recording and transcription consent.** Healdesk keeps no call audio and the voice vendor holds a recording for no more than a day, but transcription of a call is still capture, and consent rules vary by state, with some requiring all parties to consent. Confirm the position for the states being sold into, and where consent is required, make the disclosure line carry it: the assistant says it is an AI assistant and that the call is being transcribed, in the same breath.

### The entity question

Viixi FZC is a UAE company contracting with US covered entities. HIPAA obligations attach to a business associate wherever it sits, so this is not a blocker in principle, but a clinic's counsel can reasonably ask about enforcement, data location and subprocessors. Have the answer prepared before the first agreement is signed, and confirm the free zone licence activity covers software and marketing services.

Nothing in this section is a legal conclusion. The agreement text, the retention clock, refund terms and the entity question need review by counsel, not by this document.

## External gates on the launch date

The code is not the bottleneck. These four queues are, and three of them can be started before a single client exists.

| Gate | Who controls it | Duration | Start now? |
| --- | --- | --- | --- |
| Meta Business Verification of Viixi FZC | Meta | Up to 14 business days by Meta's own figure, with rejections costing a full cycle | Yes, today |
| Meta App Review for the messaging permissions | Meta | Within a week by Meta's general guide, once submitted. The 24-hour figure is WhatsApp's. Needs one screen recording per permission | Submit as soon as a minimal working app exists |
| WhatsApp Tech Provider setup and per-clinic signup | Meta | Longer, and adds per-clinic steps | Start after the first two clear |
| Calendar access | Google | Calendar access needs a pair of sensitive scopes, calendar.events.freebusy and calendar.events.owned, so Google verifies the app first. Brand verification comes first, 2 to 3 business days. Sensitive-scope review then takes about 10 business days, not guaranteed, with reports of several weeks. Until approval, an app In production but unverified shows clinics a warning screen and allows up to 100 Google accounts over the project's life. The 7-day expiry applies only to an app left in Testing | Yes. Submit as soon as the calendar connection works end to end. A small pilot can run unverified. Paid self-serve waits for approval |

### Two things that remove most of the delay

App Review needs one screen recording per permission, each showing the login that grants it and a real message arriving. It does not need the finished product. Build a minimal slice, submit, then keep building while review runs.

All three permissions go in a single bulk submission rather than one at a time, since separate submissions mean separate round trips.

### Verification details that decide pass or fail

Meta compares the trade licence against what is typed into Business Manager. The legal name and registered address must match exactly, and one documented rejection cause is the legal entity name not being visible on the business website. Put the Viixi FZC line in the site footer and on the Terms and Privacy pages before submitting. Domain verification against healdesk.io is the cleanest contact method.

### Channels go live in stages, the product does not

Each account carries a per-channel state rather than a single live flag. Web goes live in minutes, voice within hours once call forwarding is set, Meta when the clinic clicks connect. The dashboard shows each state honestly. Nothing is marked live before it is.

Until Google verification completes, purchase opens by invitation behind an internal switch: a prospect asks for setup, and Healdesk replies with a setup link. Nothing a client sees calls this a pilot or suggests the company is new, and no client-facing copy promises timing before purchase.

## Commercial position

### What v1 can prove, and what it cannot

The original wedge was closed-loop attribution: this recovered call became a booked, attended, collected treatment. V1 writes into Google Calendar, which knows nothing about attendance or money. So that claim is not available yet, and claiming it anyway is the fastest way to lose a clinic in month two.

What v1 can show honestly, and what the Home screen and the weekly email should carry:

| Claim | Evidence v1 actually has |
| --- | --- |
| Conversations handled | Direct count, per channel |
| Appointments booked by the assistant | Direct count, with the booking record |
| Calls answered that would previously have rung out | Direct, because the agent only sees forwarded or after-hours calls in two of the three coverage modes |
| Deposits collected | Direct, where the clinic connected a gateway |
| Estimated value booked | Bookings multiplied by the clinic's own configured service prices. Label it as booked value, never as revenue |
| Attended and collected | **Not available in v1.** Needs read access to the clinic's point of sale or records system |

One cheap bridge worth building: a single outcome control on each booking in the portal, letting the clinic mark showed, no-show or cancelled. It is one click, it makes the numbers real, and it is the first half of the attribution product when phase two arrives.

### The guarantee

The setup fee is never refunded: provisioning work starts the moment it is paid, and a clinic that does not finish its own steps has still cost that work. It has 30 days to finish setup, after which an account with no channel live is closed. That makes the first month the place where risk has to be reversed.

The guarantee is tied to something Healdesk controls and can measure: calls and messages answered. Not to revenue, not to bookings, not to anything that depends on the clinic's own demand, pricing or follow-through. Promising revenue outcomes on a $400-a-month plan to a clinic whose ad spend you do not control is a refund queue waiting to happen.

The shape: if the assistant does not answer every call and message routed to it during the first month, which runs from the plan start, the first month's retainer is refunded. It is a promise about reliability, which is exactly what a clinic doubts before buying and exactly what the product guarantees.

The exact wording and the refund window still need to be settled with counsel and written identically into the pricing page and the service agreement. The setup fee is never refundable, and both say so.

### Why this rather than the alternatives

The sales conversation restarts from zero without a stated position. The honest one:

| Alternative | What it costs | Where it loses |
| --- | --- | --- |
| Hiring a receptionist | Far more than any plan here, and they work one shift | Does not cover evenings, weekends, lunch, or two calls at once. Leaves when they leave |
| A human answering service | Comparable monthly cost | Takes a message. Does not know the treatment menu, cannot quote a price, cannot book, cannot take a deposit |
| The booking platform's bundled AI | Included in a platform the clinic already pays for | Tied to that platform, usually chat only, rarely handles the phone, and no help at all for a clinic that is not on it |
| A general AI receptionist product | Similar price | Built for any small business. Does not know contraindications, does not screen clinically, no medical guardrails, no business associate agreement posture |
| Doing nothing | Free | The calls still come in. They just go to voicemail |

The defensible position for this product: it is built for cash-pay clinics specifically, it answers every channel with one brain rather than one tool per channel, it books and takes deposits rather than taking messages, and it is set up to carry patient data under a signed agreement rather than hoping the question never comes up.

## Unit economics and infrastructure

The pricing table was set before the cost stack was known. That has to be closed before the pricing page ships.

### The database decision, and why it is not $599 a month

The assumption that a compliant database starts at Supabase Team plus an unpublished HIPAA add-on is wrong. Several providers sign the same agreement for a fraction of it.

| Option | Cost | Agreement | Notes |
| --- | --- | --- | --- |
| **Neon, Scale plan** | Usage-based, no monthly minimum on Scale | Self-serve in the console, at no additional cost | Core Postgres, branching, read replicas, backups and point-in-time recovery are inside the covered boundary. Some features, including its Data API, sit outside it and must not touch patient data |
| **AWS RDS** | Roughly $30 to $80 a month at this size | Already executed | Covers only the designated account and HIPAA-eligible services, with encryption required. This is the agreement Healdesk already holds |
| **Render** | No longer carries the $250 monthly minimum on its newer Scale plans | Sign, then Render redeploys the workspace onto access-restricted hosts | Straightforward, slightly more expensive than Neon at low volume |
| **Self-hosted Postgres on AWS** | $20 to $50 a month | Under the existing AWS agreement | Cheapest on paper. Patching, backups, point-in-time recovery, access logging and the security controls become Healdesk's own work, and that work is not free |
| Supabase Team plus HIPAA add-on | $599 a month plus an unpublished add-on | Yes | The most expensive path on this list. Only worth it if Supabase's auth, storage and realtime are genuinely load-bearing |

Recommendation: **Neon on Scale, or AWS RDS under the agreement already in hand.** Both are self-serve, both are an order of magnitude cheaper, and neither puts a four-figure fixed cost in front of the first client.

One correction on the zero-PHI idea that gets suggested around this: routing transcripts straight into the clinic's own records system so the database never holds patient data is sound in principle, but it does not work in v1. There is no records-system integration in v1, and the portal promises the clinic searchable conversation records, which means Healdesk still holds patient data. The transcripts themselves now go to the clinic by email and are not kept (owner, 13 October 2026). Keep the principle, which is to hold the minimum and redact at the boundary, and use a database that carries an agreement, because it will hold patient data.

### What still has to be computed

| Input | Known | Missing |
| --- | --- | --- |
| Voice cost per minute | Retell's own share with a custom LLM is about $0.085 to $0.12 a minute, plus $2 per number a month and $8 a month per concurrent call beyond 20. These are pricing-page figures, unconfirmed. Pay-as-you-go now runs on prepaid credits, and calls stop at a $0 balance | The Claude cost per minute, which is separate and must be measured, then the blended figure on the actual configuration |
| PII redaction | About a penny a minute | Whether it is on for every clinic or only covered ones |
| Chat cost per conversation | Not established | The largest unknown in the product. The clinic profile rides in the system prompt on every turn, so a long conversation is not cheap. Needs measuring on real traffic before the top tier's 2,000 included conversations can be priced |
| Concurrency | 20 concurrent calls included on the voice platform's pay-as-you-go, extra slots about $8 each a month | Whether 20 is enough at 15 to 20 clinics |
| WhatsApp | From 1 October 2026, service messages cost $0.0034 per delivered message in North America, after 1,000 free per number each month | A per-clinic counter to track it |
| Overage prices | Set provisionally by the owner on 13 October 2026 (the pricing sheet), billed per started block of 100 at each product's extra-100 price: $104 for voice minutes, $52 for Web Chat conversations, $78 for Meta Chat conversations. An extra block costs 30 percent more than moving up a step. Included amounts are the step each clinic picks: 100 to 1,500 voice minutes and chat conversations a month, in steps of 100, at $80, $40 (Web Chat) and $60 (Meta Chat, which includes the website) per 100 | Measured cost times target margin, from pilot traffic (launch step 3.5). Until then the rates are a judgement, and the pricing page marks them provisional |

### The exercise to run

For each of the five packages, at the steps clinics actually pick, model three cases: light use, expected use, and the chosen step fully consumed. The third is the one that matters, because it is the worst case the pricing promises. Then:

- Set overage prices from measured cost, not from what feels sellable.
- State the infrastructure breakeven openly. With a cheap database it is low, on the order of the first one or two clients rather than five.
- Decide whether to keep the deep annual discount. Twenty percent off is a large concession on a product whose variable cost scales with success.

Three inputs are needed before any of this can be filled in: expected minutes and conversations per clinic per month, the target gross margin, and whether the fixed platform cost is absorbed or reflected in a plan floor.

## Copy and pricing changes this scope requires

The current product sheet and site promise things v1 does not do. These need changing before the first batch sends, not after the first sale.

### Remove

- Automated follow-ups and win-backs
- Post-treatment care check-ins and review generation
- Missed-call text-back
- Appointment reminders and no-show sequences
- SMS or texting as a channel
- Payment links by text beyond the one optional text after a call, and any text a patient did not ask for
- Any claim of going live across every channel in under two minutes
- Any unqualified claim that the product is HIPAA compliant. The accurate line is that Healdesk signs a business associate agreement and handles patient data under it

### Replace with

- Answers every call, message and DM, day or night
- Books straight into the calendar during the conversation
- Takes the deposit in chat where the clinic wants one
- Screens and routes anything clinical to the right person

### Set-up promise

Per channel, not global, and it describes the step rather than the time: website chat goes live once the snippet is pasted, phone once call forwarding is set, Instagram and Messenger once the clinic connects them, WhatsApp once its account has a payment method. No timing is promised before purchase, and a channel is sold only once it is ready, so there are no opening dates. A missed set-up promise in week one is the most expensive thing on this list, because it lands exactly where post-purchase doubt is highest.

### Pricing consequences

AYA Meta Chat is priced on the assumption that inbound conversation is free. From 1 October 2026 Meta charges for service replies inside the WhatsApp window: $0.0034 per delivered message in North America, after 1,000 free per number each month. Count billable WhatsApp messages per clinic from day one rather than reconstructing them from invoices later.

## Open items

| Item | What resolves it |
| --- | --- |
| Boulevard sync direction, unverified | Ask Boulevard whether an event created in a linked Google Calendar blocks that slot in Boulevard. Until confirmed in writing, Boulevard clinics run manual booking mode |
| Exact custom LLM WebSocket contract Retell expects | Retell opens a WebSocket to the Healdesk endpoint per call. Pull the message schema from Retell's documentation before the voice proxy is built, since the whole proxy shape depends on it |
| Whether Stripe Connect is the only gateway in v1 | Decide whether the manual invoice fallback ships alongside it for clinics with no online payment setup |
| Meta's published WhatsApp service-message rates from 1 October 2026 | Resolved 1 October: $0.0034 per delivered service message in North America, after 1,000 free per number each month. Now in the unit economics table |
| Prepared answer for a US clinic asking about a non-US business associate | Counsel, plus confirmation that the free zone licence activity covers software and marketing services |
| Refund window, data destruction timeline, business associate agreement text | Legal review |
| Retell BAA not yet signed | Self-sign it in Retell's click-agreements portal, confirm the executed text names the services in use, then set per-agent retention and PII controls. Do this before the first clinic agreement is signed |
| Supabase HIPAA add-on price | Not published. Ask Supabase for a written quote, on top of the Team plan at $599 a month |
| Anthropic business associate agreement not yet activated | The primary owner signs it and arranges activation with Anthropic. Note that covered models require 30-day retention and cannot run with zero data retention, which changes the retention design |

### Phase two, already scoped

- SMS as a paid add-on, with per-clinic carrier registration quoted honestly at one to four weeks
- Live calendar writes into Mindbody and Boulevard
- Outbound: reminders, follow-ups and reactivation, once there is a reason to carry the registration and template overhead
