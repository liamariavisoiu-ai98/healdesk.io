import type { GlossaryEntry, Source } from "@/lib/content/types";

/**
 * The glossary: terms a clinic owner meets when choosing an AI receptionist,
 * each defined in one sentence that stands on its own, so it can be quoted
 * without the page around it. Definitions are generic and never describe
 * healdesk. Entries that state a rule of law or of a platform cite the
 * primary text, opened on 19 October 2026 (eCFR through its own API, the
 * federal wiretap statute on Cornell's LII because uscode.house.gov renders by
 * script, Washington's statute because California's legislature site refused
 * the fetcher). Plain-language terms carry no citation.
 */

export const glossaryReviewed = "2026-10-19";

export const glossary: readonly GlossaryEntry[] = [
  {
    term: "After-hours coverage",
    definition:
      "The arrangement for handling a business's calls while it is closed, such as forwarding them to an answering service or sending them to voicemail.",
    see: "/guides/conditional-call-forwarding",
  },
  {
    term: "AI answering service",
    definition: "An answering service in which AI software, rather than a human agent, takes the calls a business forwards to it.",
    see: "/standards/questions-to-ask-an-ai-receptionist-vendor",
  },
  {
    term: "AI disclosure law",
    definition:
      "A law that requires a business or professional to tell people, in the situations it specifies, that they are dealing with an AI system rather than a human.",
    see: "/guides/does-an-ai-receptionist-have-to-say-it-is-an-ai",
  },
  {
    term: "AI receptionist",
    definition:
      "Software that answers a business's phone calls or messages with an AI model, typically to answer questions, take messages and book appointments alongside or in place of front-desk staff.",
    see: "/standards/questions-to-ask-an-ai-receptionist-vendor",
  },
  {
    term: "All-party consent",
    definition:
      "A rule under which a private conversation may be recorded or intercepted only with the consent of everyone taking part, as Washington's law requires for private telephone communications.",
    cite: ["rcw-9-73-030"],
    see: "/guides/ai-call-transcription-consent-by-state",
  },
  {
    term: "Answering service",
    definition:
      "A third party that answers a business's calls on its behalf, usually when staff are busy or the business is closed, and passes on messages or requests.",
    see: "/guides/conditional-call-forwarding",
  },
  {
    term: "Booking request (manual booking)",
    definition:
      "A request for an appointment at a preferred time that staff confirm or decline later, used in place of direct booking when the scheduling system cannot be checked or written to automatically.",
  },
  {
    term: "Business associate",
    definition:
      "Under HIPAA, a person or organisation outside a covered entity's workforce that creates, receives, maintains or transmits protected health information on its behalf, or provides listed services, such as accounting, involving that information.",
    cite: ["ecfr-160-103"],
    see: "/guides/is-a-cash-pay-clinic-covered-by-hipaa",
  },
  {
    term: "Business associate agreement",
    definition:
      "The written contract or other written arrangement HIPAA requires before a covered entity lets a business associate handle protected health information on its behalf, setting out the uses and disclosures it permits and requires.",
    cite: ["ecfr-164-502", "ecfr-164-504"],
    see: "/guides/is-a-cash-pay-clinic-covered-by-hipaa",
  },
  {
    term: "Conditional call forwarding",
    definition:
      "Forwarding that sends a call to another number only when a set condition is met: the line is busy, the call goes unanswered, or the phone cannot be reached.",
    see: "/guides/conditional-call-forwarding",
  },
  {
    term: "Covered entity",
    definition:
      "Under HIPAA, a health plan, a health care clearinghouse, or a health care provider that transmits health information electronically in connection with a transaction covered by the HIPAA rules, such as a claim.",
    cite: ["ecfr-160-103"],
    see: "/guides/is-a-cash-pay-clinic-covered-by-hipaa",
  },
  {
    term: "Deposit",
    definition:
      "An amount paid in advance to secure an appointment, which the practice's own policy decides whether to credit, refund or keep after a late cancellation or no-show.",
  },
  {
    term: "Hosted payment link",
    definition:
      "A link to a payment page run by a payment processor, on which a customer pays by card without passing card details to the business's staff or messaging channel.",
  },
  {
    term: "Meta's 24-hour messaging window",
    definition:
      "The period, generally 24 hours after a person messages a business on Messenger, Instagram or WhatsApp, in which the business may reply freely, after which Meta allows only set message types.",
    cite: ["meta-messenger-window", "meta-whatsapp-window"],
  },
  {
    term: "No-show",
    definition: "An appointment that the patient neither attends nor cancels in advance.",
    see: "/research/phone-booking-and-missed-call-statistics",
  },
  {
    term: "One-party consent",
    definition:
      "A rule allowing a call to be intercepted when one party to it has given prior consent, as federal law provides unless the interception is for a criminal or tortious purpose.",
    cite: ["usc-2511"],
    see: "/guides/ai-call-transcription-consent-by-state",
  },
  {
    term: "Overflow calls",
    definition:
      "Calls that staff cannot take because the line is busy or nobody answers in time, which can be forwarded to another line or to an answering service.",
    see: "/guides/conditional-call-forwarding",
  },
  {
    term: "Protected health information",
    definition:
      "Under HIPAA, individually identifiable information about a person's health, care or payment for care, transmitted or kept in any form or medium, apart from exceptions such as certain education and employment records.",
    cite: ["ecfr-160-103"],
    see: "/guides/is-a-cash-pay-clinic-covered-by-hipaa",
  },
  {
    term: "Slot hold",
    definition:
      "A short reservation placed on an open appointment time while a booking is completed, so that nobody else can take the same time in the meantime.",
  },
  {
    term: "Standard transaction",
    definition:
      "Under HIPAA, an exchange of information between two parties for a financial or administrative purpose in health care, such as a claim, that complies with the standard and operating rules adopted for it.",
    cite: ["ecfr-160-103", "ecfr-162-103"],
    see: "/guides/is-a-cash-pay-clinic-covered-by-hipaa",
  },
  {
    term: "Transcription",
    definition:
      "The conversion of spoken words into written text, by software or by a person, either while a call is in progress or afterwards from a recording.",
    see: "/guides/ai-call-transcription-consent-by-state",
  },
  {
    term: "Unconditional call forwarding",
    definition:
      "Forwarding that sends all incoming calls to another number at once, so the original line does not ring until the forwarding is cancelled.",
    see: "/guides/conditional-call-forwarding",
  },
  {
    term: "WhatsApp Business Platform",
    definition:
      "Meta's service that lets businesses communicate with customers on WhatsApp at scale, through a Cloud API that lets software send messages and place calls programmatically.",
    cite: ["meta-whatsapp-platform"],
  },
];

export const glossarySources: readonly Source[] = [
  {
    id: "ecfr-160-103",
    title: "45 CFR 160.103 Definitions",
    publisher: "Electronic Code of Federal Regulations",
    url: "https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-160/subpart-A/section-160.103",
    kind: "regulation",
    checked: "2026-10-19",
  },
  {
    id: "ecfr-162-103",
    title: "45 CFR 162.103 Definitions",
    publisher: "Electronic Code of Federal Regulations",
    url: "https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-162/subpart-A/section-162.103",
    kind: "regulation",
    checked: "2026-10-19",
  },
  {
    id: "ecfr-164-502",
    title: "45 CFR 164.502 Uses and disclosures of protected health information: General rules",
    publisher: "Electronic Code of Federal Regulations",
    url: "https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-E/section-164.502",
    kind: "regulation",
    checked: "2026-10-19",
  },
  {
    id: "ecfr-164-504",
    title: "45 CFR 164.504 Uses and disclosures: Organizational requirements",
    publisher: "Electronic Code of Federal Regulations",
    url: "https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-E/section-164.504",
    kind: "regulation",
    checked: "2026-10-19",
  },
  {
    id: "usc-2511",
    title: "18 U.S.C. § 2511",
    publisher: "Legal Information Institute, Cornell Law School",
    url: "https://www.law.cornell.edu/uscode/text/18/2511",
    kind: "statute",
    checked: "2026-10-19",
  },
  {
    id: "rcw-9-73-030",
    title: "RCW 9.73.030",
    publisher: "Washington State Legislature",
    url: "https://app.leg.wa.gov/RCW/default.aspx?cite=9.73.030",
    kind: "statute",
    checked: "2026-10-19",
  },
  {
    id: "meta-messenger-window",
    title: "Send a message - Messenger Platform",
    publisher: "Meta for Developers",
    url: "https://developers.facebook.com/docs/messenger-platform/send-messages/",
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
    id: "meta-whatsapp-platform",
    title: "About the WhatsApp Business Platform",
    publisher: "Meta for Developers",
    url: "https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform",
    kind: "company",
    checked: "2026-10-19",
  },
];
