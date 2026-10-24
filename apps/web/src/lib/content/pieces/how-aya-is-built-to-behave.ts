import type { Piece } from "@/lib/content/types";

/**
 * Piece 2: AYA's behaviour in one dated place, every claim phrased as design
 * because AYA has not yet answered a real patient. Written to the owner's rule
 * of 19 October 2026: the copy states the product as designed and on, and
 * whatever production does not do yet is an item in LAUNCH_PROMISES
 * (lib/admin/seo/launch.ts), shown at /admin/seo, never a hedge here. Direct
 * booking, the deposit link in website chat, the urgent alert, the never-say
 * list on the Meta channels, the direct-line fallbacks and recording off at
 * the voice provider are described as designed; check each against that list
 * before this page goes live.
 */
export const piece: Piece = {
  slug: "how-aya-is-built-to-behave",
  family: "standards",
  title: "How AYA is built to behave",
  description:
    "How AYA, healdesk's AI receptionist, is designed to disclose itself, book, handle deposits, keep data and hand over when it stops answering.",
  answer:
    "AYA is built to say it is an AI assistant in its first line on every channel, to speak only in reply, and to give no diagnosis, prescription or price outside the clinic's list. " +
    "It writes bookings only to the clinic's Google Calendar and never takes a card number, and because it has not yet answered a real patient, every statement on this page describes its design.",
  stage: "draft",
  legal: false,
  published: "2026-10-19",
  lastReviewed: "2026-10-19",
  sections: [
    {
      id: "what-this-page-describes",
      heading: "What does this page describe?",
      blocks: [
        {
          kind: "p",
          text:
            "This page states how AYA, the AI receptionist healdesk sells, is designed to behave on phone calls, website chat, Instagram, Messenger and WhatsApp. " +
            "AYA has not yet answered a real patient, so each statement describes the product as built on the review date at the top, not a record of live use. " +
            "The page is revised when the product changes, and each revision moves that date. " +
            "Where healdesk's terms, privacy policy or pricing page state the same point, the sources below link to them.",
        },
      ],
    },
    {
      id: "opening-line",
      heading: "Does AYA tell people it is an AI?",
      blocks: [
        {
          kind: "p",
          text:
            "AYA is built to open its side of every conversation it holds by saying it is an AI assistant, before it says anything else. " +
            "On a call the same line says the call is transcribed, that healdesk keeps no audio and that the voice provider holds a recording for no more than a day. On Instagram, Messenger and WhatsApp it says the channel is not secure. " +
            "The line is fixed in the product, so the clinic cannot switch it off or edit it out through the greeting it writes, which follows the line. " +
            "The record of each call notes when the line was given. " +
            "A call AYA does not hold, because it passes the call to the clinic's direct line or cannot take calls, hears only a fixed line saying so.",
          cite: ["terms"],
        },
        {
          kind: "table",
          caption: "AYA's opening lines as built on 24 October 2026, with [practice name] standing for the clinic's name",
          head: ["Channel", "Opening line"],
          rows: [
            [
              "Phone",
              "Hi, thanks for calling [practice name]! I'm the AI assistant. This call is transcribed by our providers, who keep the recording for a day at most.",
            ],
            [
              "Website chat",
              "You're chatting with an AI assistant for [practice name]. Ask for a person any time and I'll pass your details to the practice team, who will get back to you within a day.",
            ],
            [
              "Instagram, Messenger and WhatsApp",
              "Hi! I'm an AI assistant for [practice name]. This channel isn't secure, so please don't share medical details here — I can take your number and the practice will continue by phone.",
            ],
          ],
        },
      ],
    },
    {
      id: "what-aya-will-not-do",
      heading: "What will AYA not do?",
      blocks: [
        {
          kind: "p",
          text:
            "AYA is instructed to give no diagnosis, prescription, treatment plan or promise of an outcome, and no view on whether someone is a good candidate for a treatment. " +
            "It is instructed to leave anything medical about a person to the clinic's clinicians and to offer to pass the person's details on. " +
            "On calls and website chat it is built to quote only the prices on the clinic's configured list. " +
            "A reply there that names any other dollar amount in figures is replaced, before it is sent, by an offer to pass on a request for a consultation. " +
            "It is instructed never to claim to be human.",
          cite: ["terms"],
        },
      ],
    },
    {
      id: "contact-first",
      heading: "Does AYA ever contact a patient first?",
      blocks: [
        {
          kind: "p",
          text:
            "AYA is built to speak only in reply, inside a conversation the other person started. " +
            "It places no calls and sends no text messages, reminders, follow-up sequences, win-back messages or review requests. " +
            "A call that the voice provider reports as outbound is ended as soon as AYA learns of it. " +
            "On Instagram, Messenger and WhatsApp it replies only inside the 24-hour window that Meta opens when the person writes. " +
            "When staff decide a booking request taken there, the person gets one fixed line saying the practice will call, sent only inside that window.",
          cite: ["terms", "meta-whatsapp-window", "meta-messenger-window"],
        },
      ],
    },
    {
      id: "urgent-messages",
      heading: "What happens when someone describes a complication or an urgent symptom?",
      blocks: [
        {
          kind: "p",
          text:
            "A message that matches the product's list of complication and urgent-symptom phrases is answered before the AI model sees it, on every channel. " +
            "The reply is a fixed line: it says AYA is an AI assistant that cannot help with anything urgent, tells the person to call 911 in an emergency, and gives the clinic's urgent-help number. " +
            "The clinic sets that number during setup, and where it is left empty AYA gives the clinic's direct line or main number instead. " +
            "On a call, AYA is designed to put the caller through to the urgent-help number or the direct line after the 911 line. " +
            "Where the clinic has neither, AYA gives the 911 line alone, since the caller is already on the main number. " +
            "At the same moment the product alerts the contact the clinic named for urgent messages, by email, so a person at the clinic knows to act. " +
            "The list is a filter of known wordings, so a message it does not recognise reaches the model, which is instructed to pass anything medical to the clinic.",
        },
      ],
    },
    {
      id: "booking",
      heading: "Where does AYA book, and what happens when the calendar connection breaks?",
      blocks: [
        {
          kind: "p",
          text:
            "Google Calendar is the only place the product is built to write a booking, on every channel. " +
            "It writes nothing into Mindbody, Boulevard or any other booking system, and a clinic whose system reads Google Calendar for conflicts links that system to the same calendar. " +
            "\"Auto-confirm bookings\" is on by default, and a clinic that turns it off has every booking taken as a request for its staff to approve. " +
            "For a clinic whose booking system does not read Google Calendar for conflicts, or whose sync with Google Calendar healdesk has not confirmed, AYA takes a booking request instead of booking.",
          cite: ["terms"],
        },
        {
          kind: "p",
          text:
            "AYA is designed to book during the conversation, holding the chosen time for 60 seconds before it says anything confirming. " +
            "Every write carries a key, so a retried request or a duplicate message returns the original booking instead of making a second one. " +
            "When the Google Calendar connection stops working, AYA switches to taking a booking request in the same turn, and staff confirm the time themselves. " +
            "A request that staff confirm is written to the clinic's Google Calendar while that connection works.",
        },
      ],
    },
    {
      id: "payments",
      heading: "How does AYA handle payments and deposits?",
      blocks: [
        {
          kind: "p",
          text:
            "AYA is built never to take a card number, on any channel. " +
            "On calls and website chat, a card number that reaches it as a run of digits is cut before the AI model sees it or the emailed transcript carries it. " +
            "The person is then asked not to share card details, and on Instagram, Messenger and WhatsApp no such filter runs. " +
            "On a call AYA cannot take payment, so where a service needs a deposit it is designed to book and flag the deposit for the clinic's staff to collect. " +
            "On Instagram, Messenger and WhatsApp it sends no payment link.",
          cite: ["terms"],
        },
        {
          kind: "p",
          text:
            "In website chat, where the clinic takes deposits, AYA is designed to send a hosted payment link on the clinic's own connected payment account, so the deposit is paid to the clinic. " +
            "The payment processor receives an amount, the description \"Appointment deposit\" and an opaque reference, with no treatment name, patient or appointment time. " +
            "Each description is checked against the clinic's own service names before a link is made, and a match stops the link.",
          cite: ["terms"],
        },
      ],
    },
    {
      id: "meta-channels",
      heading: "How does AYA handle Instagram, Messenger and WhatsApp?",
      blocks: [
        {
          kind: "p",
          text:
            "Meta signs no business associate agreement, so these channels are built to carry nothing clinical. " +
            "Each message a person sends there is checked for clinical content before the AI model sees it. " +
            "A message the check flags as clinical gets a fixed line instead, which moves the person to a call and says why in one sentence, and neither it nor a summary of it is kept. " +
            "AYA there is instructed to name no treatment, appointment time, provider or promotion, and a reply the filters refuse is replaced by a fixed line before it is sent.",
          cite: ["terms"],
        },
        {
          kind: "p",
          text:
            "Every message sent on these channels passes through one function that drops it if the person last wrote more than 24 hours earlier, whatever the AI model asked for. " +
            "The checks are filters designed to catch clinical wording, and no filter catches every wording, so clinics are asked not to invite patients to send clinical information there. " +
            "A booking request taken there holds a first name, a phone number and preferred times, each checked before it is stored, and the identifier Meta attaches to the conversation.",
          cite: ["terms", "privacy"],
        },
      ],
    },
    {
      id: "when-aya-is-not-answering",
      heading: "Where do calls go when AYA is not answering?",
      blocks: [
        {
          kind: "p",
          text:
            "AYA answers only the calls a clinic forwards to it, in the coverage mode the clinic picks: all calls, overflow and after hours, or after hours only. " +
            "The default forwards calls that go unanswered or find the line busy, plus every call outside opening hours. " +
            "The clinic keeps its published number and can remove the forwarding at any time without healdesk, as the guide to [conditional call forwarding](/guides/conditional-call-forwarding) explains.",
          cite: ["terms"],
        },
        {
          kind: "p",
          text:
            "A forwarded call is designed to go to the clinic's direct line whenever AYA is paused, suspended for non-payment, cancelled, or past its allowance under the \"Stop and fall back\" setting. " +
            "The direct line is a number that reaches a person and is not itself forwarded to AYA, and the clinic gives it during setup. " +
            "A call on which the AI model fails twice running, or that arrives when the product cannot load the clinic's settings, is transferred the same way.",
          cite: ["terms"],
        },
        {
          kind: "p",
          text:
            "Every one of these paths is designed to end with the caller reaching a person at the clinic, so a patient who calls is never left with a line that cannot take the call. " +
            "Website chat is designed to show the clinic's contact form whenever the assistant is not answering, and when the AI model fails it asks the visitor to try again or contact the practice.",
        },
      ],
    },
    {
      id: "what-aya-keeps",
      heading: "What does AYA keep, and for how long?",
      blocks: [
        {
          kind: "p",
          text:
            "When a call or a website chat ends, its transcript is emailed to the clinic, and healdesk keeps no lasting copy of its own. " +
            "The one encrypted copy held so that a failed email can be sent again is deleted as soon as the clinic's mail server confirms delivery. " +
            "A copy whose delivery is never confirmed is deleted 72 hours after it was sent, and an email that cannot be delivered is retried for at most 30 days after the transcript was queued. " +
            "A record of each conversation, without what was said, is deleted 90 days after it took place.",
          cite: ["privacy"],
        },
        {
          kind: "p",
          text:
            "AYA is designed to leave healdesk with no call audio. The voice provider transcribes each call and holds its transcript and recording only until healdesk has the transcript, and for no more than a day. The product creates each clinic's voice agent with that one-day limit and is designed to have the provider delete the call once healdesk has its own copy. " +
            "healdesk keeps no message from Instagram, Messenger or WhatsApp, apart from the details of a booking request, and what Meta keeps of a message is outside healdesk's control. " +
            "Under the business associate agreement healdesk is to sign with the AI model provider before any patient's information reaches it, the provider keeps conversation content for up to 30 days. " +
            "The exceptions are content the law requires it to keep and content its automated trust-and-safety systems flag, and flagged content may be kept for up to two years.",
          cite: ["privacy", "terms"],
        },
      ],
    },
    {
      id: "business-associate-agreement",
      heading: "Does healdesk sign a business associate agreement?",
      blocks: [
        {
          kind: "p",
          text:
            "healdesk signs a business associate agreement and handles patient data under it. " +
            "A practice accepts the agreement at checkout, and under 45 CFR 164.502(e) a covered entity may let a business associate handle patient information only with satisfactory assurances documented in a written agreement. " +
            "healdesk processes no real patient information for a practice until every agreement in the chain is in place, its own with the practice and one with each provider that will handle the data. " +
            "A med spa, hair restoration, massage or chiropractic practice that bills no insurance electronically is designed to sign healdesk's data protection agreement instead, with HIPAA Security Rule safeguards. " +
            "The guide [Is a cash-pay clinic covered by HIPAA?](/guides/is-a-cash-pay-clinic-covered-by-hipaa) sets out whether HIPAA covers a cash-pay practice.",
          cite: ["terms", "ecfr-164-502"],
        },
      ],
    },
    {
      id: "what-a-clinic-can-change",
      heading: "Can a clinic change what AYA says?",
      blocks: [
        {
          kind: "p",
          text:
            "A clinic edits the facts AYA works from, not the instructions around them. " +
            "It sets its services and prices, opening hours, policies, promotions, quick answers, greetings and never-say list, and it cannot edit the fixed instructions that carry the rules on this page. " +
            "On every channel, the clinic's never-say list and built-in entries go into every conversation, and a reply that contains any entry is replaced by a fixed line before it is sent. " +
            "On Instagram, Messenger and WhatsApp a fixed list of prohibitions applies as well, covering treatment names, appointment details, promotions and clinical guidance.",
        },
      ],
    },
    {
      id: "price",
      heading: "Can a clinic see AYA's price before a sales call?",
      blocks: [
        {
          kind: "p",
          text:
            "AYA's prices are published on the [pricing](/pricing) page, per product and per location, with a one-time setup fee for each product. " +
            "On 19 October 2026 the page listed AYA Voice at $80 a month per 100 voice minutes, and AYA Web Chat at $40 and AYA Meta Chat at $60 per 100 conversations. " +
            "Their setup fees were $697, $259 and $697, a clinic picks its monthly step in units of 100, and annual billing is 20% off. " +
            "Past the chosen step, each started block of 100 is billed at $104 for voice minutes, $52 for AYA Web Chat and $78 for AYA Meta Chat conversations, prices the page marks as provisional.",
          cite: ["pricing"],
        },
      ],
    },
  ],
  aya: [
    "This page states in one place how AYA is designed to behave.",
    "It changes when the product does, and the date at the top of the page says when it was last checked against the product.",
  ],
  sources: [
    {
      id: "terms",
      title: "Terms of service",
      publisher: "healdesk",
      url: "https://healdesk.io/terms",
      kind: "company",
      checked: "2026-10-19",
    },
    {
      id: "privacy",
      title: "Privacy policy",
      publisher: "healdesk",
      url: "https://healdesk.io/privacy",
      kind: "company",
      checked: "2026-10-19",
    },
    {
      id: "pricing",
      title: "AI receptionist pricing",
      publisher: "healdesk",
      url: "https://healdesk.io/pricing",
      kind: "company",
      checked: "2026-10-19",
    },
    {
      id: "meta-whatsapp-window",
      title: "Service messages",
      publisher: "Meta for Developers",
      url: "https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages",
      kind: "company",
      checked: "2026-10-19",
    },
    {
      id: "meta-messenger-window",
      title: "Messenger Platform and IG Messaging API policy",
      publisher: "Meta for Developers",
      url: "https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy",
      kind: "company",
      checked: "2026-10-19",
    },
    {
      id: "ecfr-164-502",
      title: "45 CFR 164.502(e), Disclosures to business associates",
      publisher: "Electronic Code of Federal Regulations",
      url: "https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-E/section-164.502",
      kind: "regulation",
      checked: "2026-10-19",
    },
  ],
  related: [
    "questions-to-ask-an-ai-receptionist-vendor",
    "does-an-ai-receptionist-have-to-say-it-is-an-ai",
    "is-a-cash-pay-clinic-covered-by-hipaa",
    "conditional-call-forwarding",
  ],
};
