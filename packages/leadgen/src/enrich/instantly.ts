import { copyViolations } from "./copy-guard.ts";
import { siteHost } from "./outreach.ts";

/**
 * The two files the owner uploads to Instantly, built from all-leads.csv.
 *
 * The sequence itself is docs/outreach/sequences.md. This module holds the
 * same four touches as data and renders them once per lead, so a row arrives
 * with its subject and four bodies already written. The spintax is resolved
 * here rather than left to Instantly: each {{RANDOM}} block picks one variant
 * by a hash of the address, so the list varies sentence by sentence, while
 * one clinic's thread is fixed and reproducible. Nothing depends on how
 * Instantly orders spintax against merge tags inside a variable.
 *
 * The individual merge columns ride along too, for anyone who prefers to keep
 * the template in Instantly and the spintax there (the doc has that version).
 *
 * Two files, because not every clinic was enriched equally. A row whose hook
 * rests on a measured fact (its hours, its closed days, its sites) goes in the
 * main file; a row where we found no service or no hours goes in the
 * low-enrichment file. Its copy still reads correctly, since every branch has
 * a fallback, but it is the weaker send, so it runs as its own campaign and is
 * judged on its own reply rate.
 *
 * The CAN-SPAM footer is not in the bodies. It belongs to the sending
 * mailbox, so it goes in each mailbox's Instantly signature (footers.md).
 */

type Spin = readonly string[];
type Part = string | Spin | ((r: Lead) => string);
type Lead = Record<string, string>;

const v = (name: string) => (r: Lead) => r[name] ?? "";

/** Touch 1's body, from sequences.md. Paragraphs are separated by "\n\n". */
const TOUCH_1: Part[][] = [
  [v("hook")],
  [
    ["So I built", "So I put together", "So I set up"],
    " a private preview of AYA, our AI assistant, trained on ",
    v("site_host"),
    " and dressed in your branding. ",
    [
      "One link: call her, then chat with her as she'd appear on",
      "It's one link. Call her, then chat with her as she'd look on",
      "One link lets you call her, then chat with her as she'd appear on",
    ],
    " ",
    v("chat_surface"),
    ".",
  ],
  [
    v("closing_question"),
    " ",
    [
      'Reply "yes" and you\'ll have it in two minutes.',
      'A "yes" gets it to you in two minutes.',
      'Just reply "yes" and it\'s yours in two minutes.',
    ],
  ],
];

const TOUCH_2: Part[][] = [
  [
    v("scenario"),
    " ",
    [
      "So your team starts the day with every inquiry handled, not a stack of voicemails.",
      "So you can stay with the person in front of you while she handles it.",
      "So the morning starts with inquiries handled, not voicemails to return.",
    ],
  ],
  [
    [
      "In website chat she can also send your deposit link.",
      "On your website chat she can send your deposit link too.",
      "She can also send your deposit link in website chat.",
    ],
    " ",
    [
      "That's what your preview does, with your own services.",
      "Your preview does exactly that, with your own services.",
      "That's your preview, running on your own services.",
    ],
    " ",
    ["Want it?", "Should I send it?", "Want me to send it over?"],
  ],
];

const TOUCH_3: Part[][] = [
  [
    [
      "Two quick things before you try her.",
      "Two things worth knowing before you try her.",
      "Before you try her, two quick things.",
    ],
    " She never gives medical advice and only quotes the prices you set. And we sign a business associate agreement and handle ",
    v("client_term"),
    "' data under it.",
  ],
  [
    [
      "Don't take my word for how natural she sounds. Call her yourself.",
      "The best test is to call her and hear how natural she sounds.",
      "Call her yourself and judge how natural she sounds.",
    ],
  ],
  [
    ["If someone else at", "If another person at", "In case someone else at"],
    " ",
    v("company_short"),
    " ",
    [
      "looks after the phones, who should I send the preview to?",
      "handles the phones, who's best to send the preview to?",
    ],
  ],
];

const TOUCH_4: Part[][] = [
  [
    [
      "I'm tidying up previews this week.",
      "I'm clearing out old previews this week.",
      "I'm closing out this week's previews.",
    ],
    " ",
    ["Should I archive the one for", "Want me to archive the one for"],
    " ",
    v("company_short"),
    ", ",
    ["or send it over first?", "or would you like it first?"],
  ],
];

export const TOUCHES = [TOUCH_1, TOUCH_2, TOUCH_3, TOUCH_4] as const;

/**
 * The one email for a clinic whose site would not load.
 *
 * Its three sentences come from buildUnreadableRow (unreadable.ts): what we saw
 * ("I went to look at x.com but couldn't get it to load properly"), what AYA
 * does, and a question. There is no preview to offer, because a preview is
 * built from the clinic's site, and no second touch, because there is nothing
 * specific to say in it. See the note at the top of unreadable.ts.
 */
export const UNREADABLE_TOUCH: Part[][] = [[v("hook")], [v("top_offer")], [v("closing_question")]];

/** "x.com not loading", or a plain question when the page loaded but said little. */
export function unreadableSubject(lead: Lead): string {
  const host = lead.site_host || siteHost(lead.website ?? "");
  const thin = /couldn't find much/i.test(lead.hook ?? "");
  const subject = thin ? `Quick question about ${host}` : `${host} not loading`;
  return host && subject.length <= 40 ? subject : "Your website";
}

/** Every fixed variant, for the copy guard. */
export function allVariants(): string[] {
  return TOUCHES.flat(2).flatMap((p) => (Array.isArray(p) ? [...p] : typeof p === "string" ? [p] : []));
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/**
 * What to put after "Hi": the name as a person would be addressed, or "there".
 *
 * Real exports carry "Dr. Jacob", "Jill M.", "Matthew J", "AJ" and "🏆 Jason".
 * "Hi Dr. Jacob," is wrong (a doctor is Dr. and the surname), "Hi Jill M.," is
 * a database talking, and an emoji is a spam signal. A doctor with no usable
 * surname, a lone initial or anything left empty becomes "there": a plain
 * greeting beats a wrong one.
 */
export function greetingName(first: string, last = ""): string {
  const clean = (x: string) =>
    x.replace(/[^\p{L}\p{M}.'’ -]/gu, "").replace(/\s+/g, " ").trim();
  const f = clean(first);
  const l = clean(last).replace(/\.$/, "");
  const doctor = /^(?:dr|doctor)\.?\s*/i.test(f);
  const given = f.replace(/^(?:dr|doctor)\.?\s*/i, "").replace(/\s+[A-Za-z]\.?$/, "").replace(/\.$/, "").trim();
  if (doctor) {
    // A surname, not a credential: the last-name field often holds "L.Ac",
    // "LMT", "DDS" or "BSEE". Only a capitalised word of three letters or more,
    // with no dots and some lower case, passes.
    const surname = l.split(" ").pop() ?? "";
    const CREDENTIAL = /^(?:l\.?ac|lmt|bsee|dds|dmd|md|do|dc|dpt|dpm|dvm|np|pa|rn|phd|od|lcsw|cpa|facs|faad|ms|msn|dnp|aprn|cnm|pt)$/i;
    return /^[A-Z][a-z'’-]{2,}$|^[A-Z][a-z]+[A-Z][a-z]+$/.test(surname) && /[aeiouy]/i.test(surname) && !CREDENTIAL.test(surname)
      ? `Dr. ${surname}`
      : "there";
  }
  if (given.length < 2) return "there";
  if (given.length <= 3 && given === given.toUpperCase()) return "there";
  return given;
}

/** One touch for one lead: a greeting line, then its paragraphs. */
export function renderTouch(touch: Part[][], lead: Lead, touchNo: number): string {
  const seed = (lead.email ?? "").toLowerCase();
  let block = 0;
  const paragraphs = touch.map((parts) =>
    parts
      .map((p) => {
        if (typeof p === "string") return p;
        if (typeof p === "function") return p(lead);
        block += 1;
        return p[hash(`${seed}|${touchNo}|${block}`) % p.length]!;
      })
      .join(""),
  );
  const greeting = `${lead.greeting || "Hi"} ${greetingName(lead.first_name ?? "", lead.last_name ?? "")},`;
  return [greeting, ...paragraphs].join("\n\n");
}

/**
 * Why a row belongs in the low-enrichment file, or "" when it is a main row.
 *
 * Main means the hook stands on something measured about this clinic and
 * names its service. Without hours the hook falls back to "your booking page
 * works for people who've decided" or "every appointment starts with a phone
 * call"; without a service it says "appointments". Both read correctly and
 * both are weaker.
 */
export function lowEnrichmentReason(r: Lead): string {
  const reasons: string[] = [];
  const closesEarly = r.closes_at ? Number(r.closes_at.slice(0, 2)) <= 17 : false;
  const measured = Boolean(r.gap_hours || r.closed_days || closesEarly || r.site_count);
  if (!measured) reasons.push("no opening hours found");
  if (!r.top_service) reasons.push("no service found on the site");
  return reasons.join("; ");
}

/** The columns Instantly receives, in order. The first six are its own lead fields. */
const COLUMNS = [
  "email", "first_name", "last_name", "company_name", "website", "phone",
  "subject_1", "body_1", "body_2", "body_3", "body_4",
  "greeting", "subject_line", "hook", "chat_surface", "closing_question", "scenario",
  "client_term", "company_short", "site_host",
  "city", "state", "segment", "booking_mode", "enrichment_note", "primary_contact",
] as const;

export type InstantlyFiles = {
  main: Lead[];
  lowEnrichment: Lead[];
  /** Another contact at a clinic already in main or lowEnrichment: send in a later wave. */
  secondContacts: Lead[];
  /** Clinics whose site would not load: one email, no preview. */
  unreadable: Lead[];
  refused: string[];
};

/**
 * Split all-leads.csv into the files Instantly receives.
 *
 * primary         -> main, or lowEnrichment when no hours or no service were found
 * second-contact  -> secondContacts, with the primary contact at the same clinic
 *                    named so the two are never in flight together
 * unreadable      -> unreadable, one email
 */
export function buildInstantlyFiles(rows: readonly Lead[]): InstantlyFiles {
  const main: Lead[] = [];
  const lowEnrichment: Lead[] = [];
  const secondContacts: Lead[] = [];
  const unreadable: Lead[] = [];
  const refused: string[] = [];

  const primaryByClinic = new Map<string, string>();
  for (const r of rows) if (r.list === "primary" && r.clinic_id) primaryByClinic.set(r.clinic_id, r.email ?? "");

  const check = (email: string | undefined, lead: Lead, cols: string[]) => {
    for (const col of cols) for (const label of copyViolations(lead[col] ?? "")) refused.push(`${email} ${col}: ${label}`);
  };
  const shape = (r: Lead, lead: Lead): Lead =>
    Object.fromEntries(
      COLUMNS.map((c) => [
        c,
        c === "company_name" ? r.company_short || r.company || "" : c === "website" ? r.site_host || siteHost(r.website ?? "") || r.website || "" : lead[c] ?? "",
      ]),
    );

  for (const r of rows) {
    if (r.exclude_reason) continue;

    if (r.list === "unreadable") {
      const lead: Lead = { ...r, enrichment_note: "site could not be read: one email, no preview" };
      lead.subject_1 = unreadableSubject(r);
      lead.body_1 = renderTouch(UNREADABLE_TOUCH, lead, 1);
      lead.body_2 = lead.body_3 = lead.body_4 = "";
      check(r.email, lead, ["subject_1", "body_1"]);
      unreadable.push(shape(r, lead));
      continue;
    }
    if (r.list !== "primary" && r.list !== "second-contact") continue;

    const note = lowEnrichmentReason(r);
    const lead: Lead = { ...r, enrichment_note: note };
    lead.subject_1 = r.subject_line ?? "";
    if (r.list === "second-contact") lead.primary_contact = primaryByClinic.get(r.clinic_id ?? "") ?? "";
    TOUCHES.forEach((t, i) => (lead[`body_${i + 1}`] = renderTouch(t, lead, i + 1)));
    check(r.email, lead, ["subject_1", "body_1", "body_2", "body_3", "body_4"]);

    const out = shape(r, lead);
    if (r.list === "second-contact") secondContacts.push(out);
    else (note ? lowEnrichment : main).push(out);
  }

  // Strongest first: a measured window, then a service, then a booking platform.
  const strength = (r: Lead) => ((r.hook ?? "").includes(" hours ") ? 2 : 0) + ((r.subject_line ?? "").startsWith("AYA for") ? 0 : 1);
  main.sort((a, b) => strength(b) - strength(a));
  return { main, lowEnrichment, secondContacts, unreadable, refused };
}
