/**
 * The subprocessor register.
 *
 * The BAA every clinic signs promises "a current list of these subcontractors
 * at healdesk.io/subprocessors" and notice before a new one handles patient
 * information. This module is that list; app/subprocessors/page.tsx renders
 * it. It is also the honest version of the vendor table in
 * docs/hipaa-compliance.md, corrected against what has actually been signed.
 *
 * `handlesPhi` is the column that matters. A vendor that never receives
 * patient information — Stripe bills the clinic, Resend sends the invitation,
 * PostHog measures the marketing site — is listed so the picture is complete,
 * and marked so a compliance reader does not go looking for a BAA that is
 * not needed.
 *
 * `baa` is a fact about paper, not a hope. "pending" means the agreement has
 * not yet been requested; "requested" means it has, with the date; "signed"
 * means a countersigned document exists and its date is written here. The
 * state moves forward only when the paper does.
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
  region: string;
  handlesPhi: boolean;
  baa: BaaStatus;
  /** Which side of the product it serves. */
  scope: "product" | "marketing-site" | "both";
};

export const SUBPROCESSORS: readonly Subprocessor[] = [
  {
    name: "Amazon Web Services",
    purpose: "Hosting the product, its database, encryption keys, storage",
    data: "All patient information the product holds: contacts, conversations, appointments, transcripts (no audio is kept)",
    region: "United States (single region)",
    handlesPhi: true,
    baa: { state: "pending" },
    scope: "product",
  },
  {
    name: "Synthflow",
    purpose: "The voice agent: answers forwarded calls, transcribes them, sends the post-call summary. On this website, places the one demo call a visitor asks for",
    data: "Caller audio, transcript, caller number, call outcome. For the demo call: the number you typed and the call audio",
    region: "United States workspace",
    handlesPhi: true,
    baa: { state: "pending" },
    scope: "both",
  },
  {
    name: "Anthropic",
    purpose: "The language model behind web chat and message handling, and behind the chat demo on this website",
    data: "Chat messages and the clinic's public service information; on this website, what you type into the demo. No training on any of it",
    region: "United States",
    handlesPhi: true,
    baa: { state: "pending" },
    scope: "both",
  },
  {
    name: "Cal.com",
    purpose: "Scheduling for clinics that have no booking system of their own",
    data: "Booking name, contact number, appointment time",
    region: "United States",
    handlesPhi: true,
    baa: { state: "pending" },
    scope: "product",
  },
  {
    name: "Stripe",
    purpose: "Billing the clinic for its subscription",
    data: "Clinic name, billing contact, card details (held by Stripe, never by healdesk)",
    region: "United States",
    handlesPhi: false,
    baa: { state: "not-needed", because: "Receives the clinic's billing identity only; never patient information." },
    scope: "both",
  },
  {
    name: "Resend",
    purpose: "Transactional email: invitations, agreement copies, report delivery notices",
    data: "Recipient address and non-patient content only; reports are aggregate figures",
    region: "United States",
    handlesPhi: false,
    baa: { state: "not-needed", because: "The product refuses to send patient information over email; see apps/app/src/lib/reporting." },
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
    name: "Neon",
    purpose: "The marketing site's database: demo leads and rate-limit counters",
    data: "Work email, business or personal domain, specialty demoed, referrer host, campaign code, the marketing-consent record",
    region: "United States",
    handlesPhi: false,
    baa: { state: "not-needed", because: "Business contact data only; a separate database from the product's." },
    scope: "marketing-site",
  },
  {
    name: "PostHog (EU cloud)",
    purpose: "Funnel analytics on this website, after consent",
    data: "Page views and named funnel steps; no form contents, no email, no chat text",
    region: "European Union",
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
