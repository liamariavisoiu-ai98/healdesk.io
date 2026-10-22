import { copyViolations } from "./copy-guard.ts";
import { siteHost } from "./outreach.ts";

/**
 * Splits the lead spreadsheet into the tabs the owner works from.
 *
 * Every row keeps every column it had: the hook, the best service, the offer,
 * the closing question, the hours, the booking platform and the rest of what
 * the scrape found. Two columns are added that Instantly needs
 * (`greeting_name`, `enrichment_note`) and one for the second-contact tab
 * (`primary_contact`). The emails themselves are written in Instantly from
 * templates.ts, so no email body is stored here.
 *
 * Three tabs, because the clinics are not equally well known:
 *
 *   main             a contact whose hook rests on a measured fact (hours,
 *                    closed days, sites) and whose service we found
 *   lowEnrichment    a contact with no hours, or no service, or neither; the
 *                    copy still reads correctly, since every branch has a
 *                    fallback, but it is the weaker send and is judged separately
 *   unreadable       a site that would not load; there is no preview to offer
 *
 * A second contact sits in the same tab as the primary contact at its clinic,
 * because the enrichment belongs to the clinic, not the person. The `list`
 * column says which kind a row is, and `primary_contact` names the other person,
 * so the owner can hold either back.
 */

type Lead = Record<string, string>;

/**
 * What to put after the greeting: the name as a person would be addressed, or "there".
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

/** "x.com not loading", or a plain question when the page loaded but said little. */
export function unreadableSubject(lead: Lead): string {
  const host = lead.site_host || siteHost(lead.website ?? "");
  const thin = /couldn't find much/i.test(lead.hook ?? "");
  const subject = thin ? `Quick question about ${host}` : `${host} not loading`;
  return host && subject.length <= 40 ? subject : "Your website";
}

/**
 * Why a row belongs in the low-enrichment tab, or "" when it is a main row.
 *
 * Main means the hook stands on something measured about this clinic and
 * names its service. Without hours the hook falls back to "your booking page
 * works for people who've decided" or "every appointment starts with a phone
 * call"; without a service it says "appointments". Both read correctly and
 * both are weaker.
 */
export function lowEnrichmentReason(r: Lead): string {
  const reasons: string[] = [];
  // A closing time counts only when Google supplied it: the hooks read Google's
  // hours, so a time scraped from the clinic's own page would put a row in the
  // main tab whose hook then falls back to the generic sentence.
  const closesEarly = r.hours_source === "google" && r.closes_at ? Number(r.closes_at.slice(0, 2)) <= 17 : false;
  const measured = Boolean(r.gap_hours || r.closed_days || closesEarly || r.site_count);
  if (!measured) reasons.push("no opening hours found");
  if (!r.top_service) reasons.push("no service found on the site");
  return reasons.join("; ");
}

/** The columns a recipient reads, which the copy guard checks. */
const SENT = ["hook", "top_offer", "closing_question", "subject_line", "scenario"] as const;

export type LeadTabs = {
  main: Lead[];
  lowEnrichment: Lead[];
  unreadable: Lead[];
  refused: string[];
};

/** Split the spreadsheet's rows into its three tabs. Excluded rows are in none. */
export function splitLeads(rows: readonly Lead[]): LeadTabs {
  const main: Lead[] = [];
  const lowEnrichment: Lead[] = [];
  const unreadable: Lead[] = [];
  const refused: string[] = [];

  const primaryByClinic = new Map<string, string>();
  for (const r of rows) if (r.list === "primary" && r.clinic_id) primaryByClinic.set(r.clinic_id, r.email ?? "");

  for (const r of rows) {
    if (r.exclude_reason) continue;
    if (r.list !== "primary" && r.list !== "second-contact" && r.list !== "unreadable") continue;

    const out: Lead = { ...r, greeting_name: greetingName(r.first_name ?? "", r.last_name ?? "") };
    if (r.list === "unreadable") {
      out.greeting = out.greeting || "Hi";
      out.subject_line = unreadableSubject(r);
      out.enrichment_note = "site could not be read: one email, no preview";
      out.primary_contact = "";
    } else {
      out.enrichment_note = lowEnrichmentReason(r);
      out.primary_contact = r.list === "second-contact" ? primaryByClinic.get(r.clinic_id ?? "") ?? "" : "";
    }

    for (const col of SENT) for (const label of copyViolations(out[col] ?? "")) refused.push(`${r.email} ${col}: ${label}`);

    if (r.list === "unreadable") unreadable.push(out);
    else (out.enrichment_note ? lowEnrichment : main).push(out);
  }

  // Strongest first: a measured window, then a clinic-specific subject.
  const strength = (r: Lead) => ((r.hook ?? "").includes(" hours ") ? 2 : 0) + ((r.subject_line ?? "").startsWith("AYA for") ? 0 : 1);
  main.sort((a, b) => strength(b) - strength(a));
  return { main, lowEnrichment, unreadable, refused };
}
