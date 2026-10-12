/**
 * The subprocessor register.
 *
 * The BAA every clinic signs promises "a current list of these subcontractors
 * at healdesk.io/subprocessors" and notice before a new one handles patient
 * information. This module is that list; app/subprocessors/page.tsx renders
 * it. It is also the honest version of the vendor table in
 * docs/hipaa-compliance.md, corrected against what has actually been signed
 * and against docs/v1-product-spec.md ("Vendor position, vendor by vendor").
 *
 * Two kinds of row, and the page says which is which:
 *
 *   1. `handlesPhi: true`: receives patient information and works under a
 *      Business Associate Agreement with us. `baa` says whether it is signed.
 *   2. `handlesPhi: false`, `baa.state: "not-needed"`: never receives patient
 *      information. It hosts or measures this website, or sends email that
 *      carries none.
 *
 * Three things in the patient's path have no row, because they are the
 * clinic's own services, which it connects under its own accounts, not our
 * subcontractors (BAA 1.3.0's clause headed "Where Practice is not a covered
 * entity"): its Google Calendar, the payment processor account a deposit is
 * taken through, and its Instagram, Messenger and WhatsApp accounts. The page
 * says so above the register, in a note for each.
 *
 * Change of 12 October 2026 (LEGAL_VERSION 2026-10-12.1, release gate 13 of
 * docs/counsel/agreement-changes.md § 12.14): Meta is no longer a row. It
 * was the one row of a third kind, "none-by-design", in the patient's path
 * with no agreement possible; it is now the note beside the calendar and the
 * payment processor, scoped rather than covered, as BAA 1.3.0's clause headed
 * "What healdesk is not authorised to do" describes it.
 *
 * `baa` is a fact about paper, not a hope. "pending" means the agreement has
 * not yet been requested; "requested" means it has, with the date; "signed"
 * means a countersigned document exists and its date is written here. The
 * state moves forward only when the paper does.
 *
 * `region` is empty where it has not been confirmed. The page prints that
 * plainly rather than a guess.
 *
 * Changes of 30 September 2026, to match the v1 spec:
 *   - Retell is the product's voice vendor. Its BAA is self-serve and not yet
 *     signed (spec, "Where the chain is complete").
 *   - Synthflow stays only as the vendor that places the one demo call a
 *     visitor asks for on this website. It never carries a patient call.
 *
 * Changes of 5 October 2026: the demo call moved from Synthflow to Retell
 * (lib/retell-demo-call.ts), on a separate agent from the product's. Its row
 * is "Retell (the website demo call)", beside the product's own Retell row,
 * as Anthropic has one row per organisation.
 * Published as LEGAL_VERSION 2026-10-06.4.
 *
 * Change of 7 October 2026 (LEGAL_VERSION 2026-10-07.3): the website demo
 * Retell row also covers the demo line printed on the site (site.demoLine),
 * answered by AYA's inbound agent.
 *   - Cal.com is gone: v1 writes bookings only to the clinic's own Google
 *     Calendar, and nothing into Cal.com.
 *   - Google Calendar is not a row. The calendar is the clinic's own, under
 *     the clinic's own agreement with Google, not a vendor of ours; the page
 *     says so above the register.
 *   - The database provider is not chosen yet (Neon on its Scale plan, or AWS
 *     RDS under the AWS BAA already held). Add a row for Neon, with its
 *     agreement, if that is the choice.
 *
 * Changes of 3 October 2026 (docs/counsel/agreement-changes.md § 8):
 *   - Anthropic is two rows. The product's model runs in a HIPAA-ready
 *     organisation under its BAA; the website demo runs in a separate
 *     organisation with no BAA and no patient information. One row with
 *     scope "both" told a visitor that the BAA's retention applied to what
 *     they typed into the demo.
 *   - Stripe is our own billing only. A deposit is taken through the clinic's
 *     own payment processor account, so that leg left the register for a
 *     note above it.
 *
 * Change of 6 October 2026: Calendly is a row. "Get in touch" in the navbar
 * books a call with us in its scheduler, framed on our page, so a visitor's
 * name and email reach it from this website. It handles no patient
 * information, so it needed no notice to clinics (LEGAL_VERSION 2026-10-06.2).
 *
 * Change of 6 October 2026, later (the website read, app/api/clinic-site):
 * the website's Anthropic organisation also reads a clinic's public website
 * at checkout, so its row is "this website" rather than "the website demo",
 * and says what the read sends: public page text, never patient information
 * (LEGAL_VERSION 2026-10-06.3).
 */

export type BaaStatus =
  | { state: "signed"; on: string }
  | { state: "requested"; on: string }
  /** Not yet requested. No patient information is sent until it is signed. */
  | { state: "pending" }
  | { state: "not-needed"; because: string };

export type Subprocessor = {
  name: string;
  purpose: string;
  /** What, concretely, the vendor receives. */
  data: string;
  /** Where it processes. Empty until confirmed. */
  region: string;
  handlesPhi: boolean;
  baa: BaaStatus;
  /** Which side of the product it serves. */
  scope: "product" | "marketing-site" | "both";
};

export const SUBPROCESSORS: readonly Subprocessor[] = [
  {
    name: "Amazon Web Services",
    purpose: "Hosting the product and its storage, in the AWS account designated under our AWS agreement",
    data: "Patient information the product holds: contacts, conversations, appointments, transcripts (no call audio is kept)",
    region: "United States (single region)",
    handlesPhi: true,
    // The AWS Business Associate Addendum, accepted click-through in AWS
    // Artifact. There is no countersigned copy: the executed download is the
    // generic form, and the Artifact "Active" row is the record. The account
    // memo is docs/policies/aws-hipaa-account.md. It covers only the
    // designated account and HIPAA-eligible services.
    baa: { state: "signed", on: "2026-09-22" },
    scope: "product",
  },
  {
    name: "Retell",
    purpose: "The voice agent's telephony and speech: answers the calls a clinic forwards to it, and transcribes them",
    data: "Caller audio and caller number during the call, and the call transcript. Call recording is kept off",
    // Not confirmed. Fill in once the agreement and the account settings are.
    region: "",
    handlesPhi: true,
    // Self-serve in Retell's click-agreements portal, not yet signed. Confirm
    // the executed text names the services in use, then set per-agent
    // retention and PII controls (spec, "Open items").
    baa: { state: "pending" },
    scope: "product",
  },
  {
    name: "Anthropic (the product)",
    purpose: "The language model behind every channel of the product, in a HIPAA-ready Anthropic organisation used only for the product",
    data: "Conversation text and the clinic's public service information. Under the BAA Anthropic keeps inputs for 30 days, which its covered models require, except content its trust-and-safety systems flag or the law requires it to keep, which it may hold for up to two years. No training on any of it",
    region: "United States",
    handlesPhi: true,
    baa: { state: "pending" },
    scope: "product",
  },
  {
    name: "Anthropic (this website)",
    purpose: "The language model behind the chat demo on this website, and behind reading a clinic's public website at checkout so setup starts pre-filled, in a separate Anthropic organisation from the product's",
    data: "What you type into the demo, and the public service information of the specialty being demonstrated; at checkout, the text of up to eight public pages of the website you give us. No training on any of it",
    region: "United States",
    handlesPhi: false,
    baa: {
      state: "not-needed",
      because: "A separate organisation from the product's, with no BAA: the demo is for clinic owners and staff, not a patient channel, the website read sends only a clinic's own public pages, and no patient information is sent to it.",
    },
    scope: "marketing-site",
  },
  {
    name: "Stripe",
    purpose: "Billing the clinic for its healdesk subscription",
    data: "Clinic name, billing contact, card details (held by Stripe, never by healdesk)",
    region: "United States",
    handlesPhi: false,
    baa: {
      state: "not-needed",
      because:
        "Our own billing carries business contact and payment details only. Deposits go through the clinic's own payment processor account, not this one; see the note above the register.",
    },
    scope: "marketing-site",
  },
  {
    name: "Retell (the website demo call)",
    purpose: "Places the one demo call a visitor asks for on this website and answers the demo line on it, on separate agents from the product's, and runs the conversation on Anthropic's Claude model",
    data: "For a call you asked for: the number you typed, the first name you gave and the specialty you were viewing. For a call to the demo line: your number. Either way, the call's audio and words while it is live. Retell keeps no recording or transcript of either call, only its basic record (time, length, how it ended), for 30 days",
    // Not confirmed in writing, as for the product's row above.
    region: "",
    handlesPhi: false,
    baa: {
      state: "not-needed",
      because: "Demo calls to clinic owners and staff who asked for one; never a patient call.",
    },
    scope: "marketing-site",
  },
  {
    name: "Calendly",
    purpose: "Books the call a visitor asks for through \"Get in touch\" on this website, in Calendly's scheduler shown on our page",
    data: "The name and email you give when booking, anything you add in its form, and the time you pick; Calendly also records your visit to its scheduling page",
    region: "United States",
    handlesPhi: false,
    baa: { state: "not-needed", because: "Calls with clinic owners and staff who asked for one; it asks for no patient information and needs none." },
    scope: "marketing-site",
  },
  {
    name: "Resend",
    purpose: "Transactional email: invitations, agreement copies, account and billing notices",
    data: "Recipient address and non-patient content only",
    region: "United States",
    handlesPhi: false,
    baa: { state: "not-needed", because: "It carries only email that holds no patient information: the product refuses to send anything else through it (apps/app/src/lib/reporting)." },
    scope: "both",
  },
  {
    name: "Vercel",
    purpose: "Hosting this marketing website",
    data: "Page requests, the demo gate email, contact-form submissions",
    region: "United States",
    handlesPhi: false,
    baa: { state: "not-needed", because: "The marketing site holds no patient information; the product is hosted elsewhere." },
    scope: "marketing-site",
  },
  {
    name: "Google (Google Sheets / Drive)",
    purpose: "The marketing site's lead register: demo leads, funnel events, the demo-call consent record and setup requests, in a Google Sheet",
    data: "Work email, business or personal domain, specialty demoed, referrer host, campaign code, the marketing-consent record; for a setup request, the requester's name, the clinic's name, website and email, the channels wanted, and the IP address it came from",
    region: "United States (Google Cloud; not region-pinned for a Google account)",
    handlesPhi: false,
    baa: { state: "not-needed", because: "Business contact data only; a separate store from the product's; no patient information ever reaches it." },
    scope: "marketing-site",
  },
  {
    name: "PostHog (US cloud)",
    purpose: "Funnel analytics on this website, after consent",
    data: "Page views and named funnel steps; no form contents, no email, no chat text",
    region: "United States",
    handlesPhi: false,
    baa: { state: "not-needed", because: "Runs only on the marketing site and only after the cookie notice is accepted." },
    scope: "marketing-site",
  },
  {
    name: "Apify",
    purpose: "Reading a practice's public website when we research it before a first email",
    data: "Publicly published pages of the practice's own website",
    region: "United States",
    handlesPhi: false,
    baa: { state: "not-needed", because: "Public web pages only." },
    scope: "marketing-site",
  },
] as const;

export const PHI_SUBPROCESSORS = SUBPROCESSORS.filter((s) => s.handlesPhi);
