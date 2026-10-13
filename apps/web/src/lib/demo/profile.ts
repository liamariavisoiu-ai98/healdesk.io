import { isSpecialtyId, type SpecialtyId } from "@healdesk/catalog";

/**
 * A clinic's public website, structured: what the personalised demo knows.
 *
 * ## Business data, never patient data
 *
 * Everything here was published by the clinic on its own website: services,
 * listed prices, opening hours, the names of its providers, its FAQs and its
 * booking and cancellation policies. That is why it may live on the no-PHI
 * side, in the marketing Sheet (root CLAUDE.md, "The demo's scraped clinic
 * profile (business data)"). Nothing typed into the demo is ever written
 * back into it.
 *
 * It is also the profile the spec's "never ask twice" rule wants carried into
 * the onboarding wizard (docs/v1-product-spec.md, "Stage 0, before they
 * pay"). The checkout reads the website again and sends that read into the
 * purchase; when that read fails, the buyer's demo's profile goes in its
 * place (lib/demo/to-clinic-profile.ts), inside the same signed request to
 * apps/app, never a second store on this side.
 *
 * ## Why empty strings rather than nulls in the schema
 *
 * The structuring call constrains the model to `PROFILE_SCHEMA` with
 * structured outputs. Every field is required and unknowns are `""` or `[]`,
 * which keeps the schema to the plainest features the constraint supports.
 * `normalizeProfile()` turns the blanks into nulls and caps every list, so a
 * page with four hundred menu items cannot produce a row the Sheet refuses
 * (a cell holds at most 50,000 characters).
 */

export type ClinicService = {
  name: string;
  description: string | null;
  /** As the site states it: "$450", "from $12/unit", "free consult". Never computed. */
  price: string | null;
  duration: string | null;
};

export type ClinicProfile = {
  clinicName: string;
  /** One line on what the clinic is, in its own words. */
  summary: string | null;
  specialty: SpecialtyId | null;
  /** The clinic's published front-desk number. Display only; never dialled. */
  phone: string | null;
  address: string | null;
  hours: { days: string; hours: string }[];
  /** Where `hours` came from: the clinic's Google listing (preferred), its website, or nowhere. */
  hoursSource: "google" | "website" | null;
  /** The Google listing's name when the hours are Google's, e.g. "Peachy West SoHo". */
  hoursPlace: string | null;
  services: ClinicService[];
  providers: { name: string; title: string | null }[];
  faqs: { question: string; answer: string }[];
  /** Deposits, cancellation, late arrival, consult fees, payment plans. */
  policies: string[];
  /** How booking works today according to the site: an online tool, a phone line, a form. */
  booking: string | null;
  /** Memberships, current offers, awards: what a receptionist would mention. */
  highlights: string[];
};

const LIMITS = {
  services: 40,
  providers: 15,
  faqs: 20,
  policies: 12,
  highlights: 8,
  hours: 10,
  /** Per free-text field. */
  text: 600,
} as const;

/** The JSON schema the structuring call is constrained to. */
export const PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "clinic_name",
    "summary",
    "specialty",
    "phone",
    "address",
    "hours",
    "services",
    "providers",
    "faqs",
    "policies",
    "booking",
    "highlights",
  ],
  properties: {
    clinic_name: { type: "string" },
    summary: { type: "string" },
    specialty: {
      type: "string",
      enum: [
        "med-spa",
        "plastic-surgery",
        "fertility",
        "dental",
        "glp1",
        "hair-restoration",
        "veterinary",
        "massage-chiro",
        "",
      ],
    },
    phone: { type: "string" },
    address: { type: "string" },
    hours: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["days", "hours"],
        properties: { days: { type: "string" }, hours: { type: "string" } },
      },
    },
    services: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "price", "duration"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          price: { type: "string" },
          duration: { type: "string" },
        },
      },
    },
    providers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "title"],
        properties: { name: { type: "string" }, title: { type: "string" } },
      },
    },
    faqs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "answer"],
        properties: { question: { type: "string" }, answer: { type: "string" } },
      },
    },
    policies: { type: "array", items: { type: "string" } },
    booking: { type: "string" },
    highlights: { type: "array", items: { type: "string" } },
  },
} as const;

function text(value: unknown, max: number = LIMITS.text): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The model's output (or a stored row) as a `ClinicProfile`, blanks to null,
 * every list capped. Accepts both the schema's snake_case and the stored
 * camelCase, so the same function reads a fresh extraction and a Sheet cell.
 */
export function normalizeProfile(raw: unknown, fallbackName: string): ClinicProfile {
  const r = record(raw);
  const specialty = r.specialty;
  return {
    clinicName: text(r.clinic_name ?? r.clinicName, 120) ?? fallbackName,
    summary: text(r.summary, 300),
    specialty: isSpecialtyId(specialty) ? specialty : null,
    phone: text(r.phone, 40),
    address: text(r.address, 200),
    hours: list(r.hours)
      .map(record)
      .map((h) => ({ days: text(h.days, 60), hours: text(h.hours, 80) }))
      .filter((h): h is { days: string; hours: string } => Boolean(h.days && h.hours))
      .slice(0, LIMITS.hours),
    hoursSource: r.hoursSource === "google" || r.hoursSource === "website" ? r.hoursSource : null,
    hoursPlace: text(r.hoursPlace, 120),
    services: list(r.services)
      .map(record)
      .map((s) => ({
        name: text(s.name, 120),
        description: text(s.description, 280),
        price: text(s.price, 120),
        duration: text(s.duration, 60),
      }))
      .filter((s): s is ClinicService => Boolean(s.name))
      .slice(0, LIMITS.services),
    providers: list(r.providers)
      .map(record)
      .map((p) => ({ name: text(p.name, 100), title: text(p.title, 120) }))
      .filter((p): p is { name: string; title: string | null } => Boolean(p.name))
      .slice(0, LIMITS.providers),
    faqs: list(r.faqs)
      .map(record)
      .map((f) => ({ question: text(f.question, 200), answer: text(f.answer, 500) }))
      .filter((f): f is { question: string; answer: string } => Boolean(f.question && f.answer))
      .slice(0, LIMITS.faqs),
    policies: list(r.policies)
      .map((p) => text(p, 300))
      .filter((p): p is string => Boolean(p))
      .slice(0, LIMITS.policies),
    booking: text(r.booking, 300),
    highlights: list(r.highlights)
      .map((h) => text(h, 200))
      .filter((h): h is string => Boolean(h))
      .slice(0, LIMITS.highlights),
  };
}

/** True when the extraction found enough to hold a conversation about this clinic. */
export function isUsableProfile(profile: ClinicProfile): boolean {
  return profile.services.length > 0 || profile.faqs.length > 0 || profile.hours.length > 0;
}

/**
 * The profile as reference text, for the chat system prompt and the voice
 * agent's `{{clinic_knowledge}}` variable.
 *
 * Plain labelled lines rather than JSON: both models read it as a front-desk
 * crib sheet, and a phone turn pays for every token of it on every turn.
 * `maxChars` drops whole sections from the bottom (highlights first,
 * services last) rather than cutting one mid-line.
 */
export function profileToKnowledge(profile: ClinicProfile, maxChars = 12_000): string {
  const sections: string[] = [];
  const push = (title: string, lines: string[]) => {
    if (lines.length > 0) sections.push(`${title}:\n${lines.join("\n")}`);
  };

  const basics = [
    `Clinic: ${profile.clinicName}`,
    profile.summary ? `About: ${profile.summary}` : "",
    profile.address ? `Address: ${profile.address}` : "",
    profile.phone ? `Front-desk phone: ${profile.phone}` : "",
    profile.booking ? `How booking works today: ${profile.booking}` : "",
  ].filter(Boolean);
  sections.push(basics.join("\n"));

  push(
    "Services (prices exactly as the website lists them; no price means the site lists none)",
    profile.services.map((s) =>
      [
        `- ${s.name}`,
        s.price ? ` — ${s.price}` : "",
        s.duration ? ` (${s.duration})` : "",
        s.description ? `: ${s.description}` : "",
      ].join(""),
    ),
  );
  push("Opening hours", profile.hours.map((h) => `- ${h.days}: ${h.hours}`));
  push("Providers", profile.providers.map((p) => `- ${p.name}${p.title ? `, ${p.title}` : ""}`));
  push("Policies", profile.policies.map((p) => `- ${p}`));
  push("FAQs from the website", profile.faqs.map((f) => `- Q: ${f.question}\n  A: ${f.answer}`));
  push("Worth mentioning", profile.highlights.map((h) => `- ${h}`));

  // Drop from the end until it fits; the basics and services are first.
  while (sections.length > 2 && sections.join("\n\n").length > maxChars) sections.pop();
  const joined = sections.join("\n\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
}
