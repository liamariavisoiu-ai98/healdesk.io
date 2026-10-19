import type { Piece } from "@/lib/content/types";

/**
 * Piece 3: the yardstick. One section per question, each with its sourced
 * reason and what a complete answer includes. It names no AI receptionist
 * vendor and makes no claim about one; AYA's own answers live on piece 2,
 * which the closing note links to. Every reason was rechecked on
 * 19 October 2026. HHS's statement that it recognises no private HIPAA
 * "certification" was dropped because hhs.gov could not be opened that day.
 */
export const piece: Piece = {
  slug: "questions-to-ask-an-ai-receptionist-vendor",
  family: "standards",
  title: "Questions to ask any AI receptionist vendor",
  description:
    "Eight questions a clinic can put to any AI receptionist vendor, each with the reason to ask it and what a complete answer includes.",
  answer:
    "A clinic can test any AI receptionist vendor with eight questions, on AI disclosure, business associate agreements, first contact, price, booking, failure, complications and what is kept. " +
    "Each section below gives the reason to ask, with its source where a law, a survey or a platform's documentation supplies one, and what a complete answer includes.",
  stage: "draft",
  legal: false,
  published: "2026-10-19",
  lastReviewed: "2026-10-19",
  sections: [
    {
      id: "does-it-say-it-is-an-ai",
      heading: "Does the AI receptionist say it is an AI in its first sentence?",
      blocks: [
        {
          kind: "p",
          text:
            "A Pew Research Center survey of 3,488 US adults, published in August 2026, found that most want to be told when a healthcare provider uses AI in their care. " +
            "Pew reports that 72% of US adults say it is extremely or very important that a doctor or other healthcare provider tells them if they are using AI in their healthcare. " +
            "Asked about specific tasks, 56% said a provider or its office should tell them when AI schedules a medical appointment, the lowest share of any task, and 33% said it should not. " +
            "Several states also have disclosure rules that can reach an assistant answering a clinic's phone or chat, which [Does an AI receptionist have to say it is an AI?](/guides/does-an-ai-receptionist-have-to-say-it-is-an-ai) sets out. " +
            "What a caller must be told about transcription is covered in [AI call transcription consent by state](/guides/ai-call-transcription-consent-by-state).",
          cite: ["pew-2026"],
        },
        { kind: "h3", text: "What a complete answer includes" },
        {
          kind: "list",
          items: [
            "The exact words of the first line on each channel: phone, website chat, Instagram, Messenger and WhatsApp.",
            "Whether that line comes before anything else is said, the clinic's own greeting included.",
            "Whether the clinic can switch the line off or edit it out, and who else can change it.",
            "On calls, whether the same line says the call is transcribed or recorded.",
            "Whether the record of each conversation notes when the line was given.",
          ],
        },
      ],
    },
    {
      id: "business-associate-agreement",
      heading: "Who signs a business associate agreement, and with whom?",
      blocks: [
        {
          kind: "p",
          text:
            "Under 45 CFR 164.502(e), a covered entity may let a business associate create, receive, maintain or transmit protected health information on its behalf if it obtains satisfactory assurance that the information will be safeguarded. " +
            "Those assurances must be documented in a written contract or other written arrangement that meets the requirements of 45 CFR 164.504(e). " +
            "A business associate may in turn let a subcontractor handle the information if it obtains the same kind of assurances from that subcontractor. " +
            "Whether HIPAA reaches a cash-pay practice at all is the subject of [Is a cash-pay clinic covered by HIPAA?](/guides/is-a-cash-pay-clinic-covered-by-hipaa).",
          cite: ["ecfr-164-502", "ecfr-164-504"],
        },
        { kind: "h3", text: "What a complete answer includes" },
        {
          kind: "list",
          items: [
            "Whether the vendor signs a business associate agreement, and whether it does so before any patient information reaches it.",
            "Who signs on each side, and whether the agreement covers each location and every channel the clinic buys.",
            "Which subcontractors handle patient information, such as the voice, AI model, hosting and database providers, and whether each has signed an agreement with the vendor.",
            "Which channels no agreement can cover because the platform that runs them signs none, and how the vendor keeps clinical content off them.",
            "What the vendor offers a practice that HIPAA does not cover.",
          ],
        },
      ],
    },
    {
      id: "contact-first",
      heading: "Does the AI receptionist ever contact a patient first?",
      blocks: [
        {
          kind: "p",
          text:
            "The Federal Communications Commission ruled in February 2024 that the Telephone Consumer Protection Act's restrictions on calls using an \"artificial or prerecorded voice\" cover current AI technologies that generate human voices. " +
            "Such calls need the prior express consent of the person called, unless they serve an emergency purpose or an exemption applies (FCC 24-17). " +
            "The ruling treats AI-generated voices as \"artificial\" because a person is not speaking them. " +
            "Reminders, call-backs to missed calls, reactivation campaigns and review requests are each a contact that the patient did not start, and the ruling concerns those made as calls in an AI-generated voice.",
          cite: ["fcc-24-17"],
        },
        { kind: "h3", text: "What a complete answer includes" },
        {
          kind: "list",
          items: [
            "Whether the product ever places a call or sends a text message, email or social message that the patient did not start.",
            "Which features do so: reminders, confirmations, call-backs to missed calls, reactivation of past patients, follow-ups after a visit and review requests.",
            "For each such feature, what consent the vendor collects, how it records that consent, and whether the vendor or the clinic is responsible for it.",
            "Whether those features can be switched off, and whether they are off by default.",
          ],
        },
      ],
    },
    {
      id: "price",
      heading: "Can I see the price before a sales call?",
      blocks: [
        {
          kind: "p",
          text:
            "A price can be compared with another only when both name the unit they count, such as calls, minutes, conversations or a flat monthly fee. " +
            "What is billed past the included amount, any one-time setup fee and whether the price applies per location each change what a clinic pays in its first year. " +
            "A price published on a vendor's own site can be compared with others before anyone books a call.",
        },
        { kind: "h3", text: "What a complete answer includes" },
        {
          kind: "list",
          items: [
            "The price of each product or channel, and the unit it counts.",
            "Any setup fee, and whether any of it is refunded if the clinic leaves.",
            "What happens past the included amount: the price per unit or per block, and whether the service stops answering or keeps going.",
            "Whether prices are per location, and what annual billing changes.",
            "The date the prices were set.",
          ],
        },
      ],
    },
    {
      id: "booking",
      heading: "Where does it book, and what happens when that connection breaks?",
      blocks: [
        {
          kind: "p",
          text:
            "An AI receptionist that books into a clinic's own calendar or booking system does so through a connection the clinic grants, and that connection can stop working. " +
            "Google's documentation for its APIs lists the reasons a refresh token, the credential behind such a connection, might stop working. " +
            "Two of them are that the user has revoked the app's access and that the token has not been used for six months. " +
            "A booking written into a calendar that the clinic's own booking system does not read for conflicts can also be booked over by staff or by that system's online booking.",
          cite: ["google-oauth"],
        },
        { kind: "h3", text: "What a complete answer includes" },
        {
          kind: "list",
          items: [
            "Which calendar or booking system it writes to, and whether it writes anywhere else.",
            "Whether it holds a time before confirming it to the caller, and for how long.",
            "Whether a retried request or a duplicate message can create a second booking.",
            "What it does in the same conversation when the connection fails: books anyway, takes a request, or tells the caller.",
            "How the clinic learns that the connection has failed, and whether it can reconnect without contacting support.",
            "Which booking systems read the calendar it writes to, and what it does for a clinic whose system does not.",
          ],
        },
      ],
    },
    {
      id: "when-it-is-down",
      heading: "Where does a call go if the AI receptionist is down?",
      blocks: [
        {
          kind: "p",
          text:
            "Under call forwarding, conditional or unconditional, the clinic's own line sends some or all of its calls to the vendor's number, as the [guide to call forwarding](/guides/conditional-call-forwarding) explains. " +
            "Once forwarded, a call rings the vendor's system, so whatever that system does during an outage, a pause or a suspension is what the clinic's callers hear. " +
            "The same holds for a chat window on the clinic's website that stops answering.",
        },
        { kind: "h3", text: "What a complete answer includes" },
        {
          kind: "list",
          items: [
            "Where a forwarded call goes when the service is paused, suspended for non-payment, past its usage allowance or cancelled.",
            "Where it goes when the vendor's own system, or one of its providers, fails.",
            "Whether that destination is a number that reaches a person and is not forwarded back to the vendor.",
            "What a website chat visitor sees when the assistant is not answering.",
            "How the clinic is told, and how it removes the forwarding itself.",
          ],
        },
      ],
    },
    {
      id: "complications",
      heading: "What happens when a caller describes a complication?",
      blocks: [
        {
          kind: "p",
          text:
            "California's AB 1979, approved on 30 September 2026 as Chapter 854 of the Statutes of 2026, adds section 22758.5 to the Business and Professions Code with effect from 1 January 2027. " +
            "It bars a health facility, clinic, physician's office or group practice office from using a tool that includes artificial intelligence to independently perform a clinical function the law reserves for a licensed person. " +
            "It also bars using such a tool to direct, guide, supervise or instruct unlicensed staff in performing such a function.",
          cite: ["ca-ab-1979", "ca-const-iv-8"],
        },
        {
          kind: "p",
          text:
            "The section does not apply to automated decision systems used for documentation and communication that involve no professional judgment. " +
            "The definition of clinical decision support, which the section uses only for its duty to preserve a licensed provider's independent judgment, leaves out booking, cancelling and rescheduling appointments where that needs no professional licence. " +
            "It does not list which replies to a patient describing a complication count as a clinical function.",
          cite: ["ca-ab-1979"],
        },
        { kind: "h3", text: "What a complete answer includes" },
        {
          kind: "list",
          items: [
            "Whether complication and urgent-symptom messages are caught before the AI model answers, or left to the model.",
            "The exact words the person hears or reads in reply, including any instruction to call 911.",
            "Who at the clinic is told, by what route, and how quickly.",
            "Whether a call can be transferred to a clinician or an urgent line, and when.",
            "Whether the product ever comments on symptoms, aftercare or whether to seek care.",
          ],
        },
      ],
    },
    {
      id: "what-it-keeps",
      heading: "What does the AI receptionist keep, and for how long?",
      blocks: [
        {
          kind: "p",
          text:
            "A business associate agreement must require the business associate, when the contract ends, to return or destroy all the protected health information it still holds and keep no copies, if that is feasible. " +
            "Where return or destruction is not feasible, the agreement must extend its protections to the information and limit further uses and disclosures to the purposes that make it infeasible (45 CFR 164.504(e)(2)(ii)(J)). " +
            "What a vendor holds when the contract ends depends on what it keeps while the contract runs, including recordings, transcripts, summaries and copies held by its own providers.",
          cite: ["ecfr-164-504"],
        },
        { kind: "h3", text: "What a complete answer includes" },
        {
          kind: "list",
          items: [
            "Whether call audio is recorded, and if it is, where it is kept and for how long.",
            "Whether transcripts and summaries are kept, by the vendor and by each of its providers, the AI model provider included, and for how long.",
            "What is kept from Instagram, Messenger and WhatsApp messages.",
            "What the clinic receives, and in what form, when it leaves.",
            "How and when the vendor destroys what it holds, and whether it confirms that in writing.",
          ],
        },
      ],
    },
  ],
  aya: [
    "AYA's monthly prices and setup fees are on the [pricing](/pricing) page, so the price question is answered before any sales call.",
    "AYA is built to say it is an AI assistant in its first line on every channel, and to contact no patient first.",
    "We sign a business associate agreement and handle patient data under it.",
    "AYA has not yet answered a real patient, so these describe how it is designed rather than a record of live use.",
  ],
  sources: [
    {
      id: "pew-2026",
      title: "Americans want transparency when AI is used in their healthcare",
      publisher: "Pew Research Center",
      url: "https://www.pewresearch.org/short-reads/2026/08/25/americans-want-transparency-when-ai-is-used-in-their-healthcare/",
      kind: "research",
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
    {
      id: "ecfr-164-504",
      title: "45 CFR 164.504(e), Business associate contracts",
      publisher: "Electronic Code of Federal Regulations",
      url: "https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-E/section-164.504",
      kind: "regulation",
      checked: "2026-10-19",
    },
    {
      id: "fcc-24-17",
      title:
        "Implications of Artificial Intelligence Technologies on Protecting Consumers from Unwanted Robocalls and Robotexts, Declaratory Ruling, FCC 24-17",
      publisher: "Federal Communications Commission",
      url: "https://docs.fcc.gov/public/attachments/FCC-24-17A1.pdf",
      kind: "government",
      checked: "2026-10-19",
    },
    {
      id: "google-oauth",
      title: "Using OAuth 2.0 to Access Google APIs: Refresh token expiration",
      publisher: "Google for Developers",
      url: "https://developers.google.com/identity/protocols/oauth2#expiration",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "ca-ab-1979",
      title: "AB 1979, Health care services: artificial intelligence (Chapter 854, Statutes of 2026)",
      publisher: "California Legislature",
      url: "https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260AB1979",
      kind: "statute",
      checked: "2026-10-19",
    },
    {
      id: "ca-const-iv-8",
      title:
        "California Constitution, Article IV, § 8(c), effective date of statutes",
      publisher: "California Legislature",
      url: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CONS&sectionNum=SEC.%208.&article=IV",
      kind: "statute",
      checked: "2026-10-19",
    },
  ],
  related: [
    "how-aya-is-built-to-behave",
    "does-an-ai-receptionist-have-to-say-it-is-an-ai",
    "is-a-cash-pay-clinic-covered-by-hipaa",
    "ai-call-transcription-consent-by-state",
    "conditional-call-forwarding",
  ],
};
