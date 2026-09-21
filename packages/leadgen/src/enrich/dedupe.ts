import { createHash } from "node:crypto";

/**
 * One row per CLINIC, not one row per contact.
 *
 * A purchased or scraped list counts people. A segment tally, a send schedule
 * and a market-size estimate all want businesses — and the ratio between them
 * is not constant across segments, so counting rows silently reweights every
 * downstream decision.
 *
 * The healdesk list is mild: 4,919 rows over roughly 4,500 domains. But the
 * duplicates are not random. A clinic large enough to have two contacts in a
 * database is a clinic with an office manager as well as an owner, which biases
 * the count toward exactly the multi-location practices that are the slowest
 * sale — so leaving them in tilts the niche choice toward the wrong end of the
 * market.
 *
 * ## Match order
 *
 * Website domain first, phone second, normalised name + city third. Domain is
 * the strongest signal in this list because it is 100% populated and a practice
 * almost never shares one. Phone is only 21% populated here so it can only ever
 * be a fallback. Name matching is last and deliberately conservative: "Radiance
 * Med Spa" in two different cities is two businesses, so the city is part of
 * the key.
 */

export type LeadRow = Record<string, string>;

export type Clinic = {
  /** Stable id derived from the winning match key, so re-runs are comparable. */
  id: string;
  /** Which key matched. Useful for auditing a merge that looks wrong. */
  matchedOn: "domain" | "phone" | "name+city";
  domain: string;
  companyName: string;
  website: string;
  city: string;
  state: string;
  phone: string;
  /** Every contact at this clinic, best-first. */
  contacts: Contact[];
  /** The category column from the source, where it had one. */
  sourceCategory: string;
  /**
   * Which input files this clinic appeared in, in the order they were given.
   *
   * More than one means the lists overlapped. That number is the first thing
   * worth knowing about a second batch — a batch that is mostly clinics we
   * already have is not 3,700 new prospects, whatever its row count says.
   */
  sources: string[];
};

export type Contact = {
  email: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  linkedIn: string;
  /** Higher is better. See rankContact(). */
  seniority: number;
  /** The input file this person came from. Empty on rows that carried none. */
  source: string;
};

/**
 * Who to actually email at a clinic that has several contacts.
 *
 * The owner decides and the owner is the one missing the calls — in a
 * single-location practice they are usually the same person. An office manager
 * is a good second because they feel the problem daily. A marketing agency
 * contact is the worst: they do not own the phone line and will not champion a
 * spend they do not control.
 */
export function rankContact(jobTitle: string): number {
  const t = jobTitle.toLowerCase();

  if (/\b(owner|founder|ceo|president|principal)\b/.test(t)) return 100;
  if (/\b(md|do|dr|physician|surgeon|dermatolog|injector|np|pa-c)\b/.test(t)) return 90;
  if (/\b(practice manager|office manager|operations|coo|director)\b/.test(t)) return 80;
  if (/\b(manager|administrator|coordinator)\b/.test(t)) return 60;
  if (/\b(marketing|social|content|seo)\b/.test(t)) return 30;
  if (/\b(front desk|receptionist|assistant)\b/.test(t)) return 20;

  return 50;
}

/** Registrable-ish host: strips scheme, www, path, port, and lowercases. */
export function normaliseDomain(url: string): string {
  const raw = (url ?? "").trim().toLowerCase();
  if (!raw) return "";

  const host = raw
    .replace(/^[a-z]+:\/\//, "")
    .split("/")[0]!
    .split("?")[0]!
    .split(":")[0]!;

  return host.startsWith("www.") ? host.slice(4) : host;
}

/** Digits only, US-normalised. Returns "" when there is nothing usable. */
export function normalisePhone(phone: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length === 10 ? digits : "";
}

/** Lowercased, punctuation and legal suffixes removed, collapsed whitespace. */
export function normaliseName(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(llc|inc|pllc|pc|pa|ltd|co|corp|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export type DedupeReport = {
  inputRows: number;
  clinics: number;
  mergedBy: Record<Clinic["matchedOn"], number>;
  /** Rows dropped because they had no usable key at all. */
  unusable: number;
  /**
   * Per input file: rows read, and clinics that file was the FIRST to name.
   * The second number is what a new batch actually adds.
   */
  bySource: Record<string, { rows: number; newClinics: number }>;
  /** Clinics that appeared in more than one input file. */
  overlap: number;
};

export function dedupe(rows: LeadRow[]): {
  clinics: Clinic[];
  report: DedupeReport;
} {
  const byKey = new Map<string, Clinic>();
  const report: DedupeReport = {
    inputRows: rows.length,
    clinics: 0,
    mergedBy: { domain: 0, phone: 0, "name+city": 0 },
    unusable: 0,
    bySource: {},
    overlap: 0,
  };

  for (const row of rows) {
    const source = (row.source ?? "").trim();
    const tally = (report.bySource[source] ??= { rows: 0, newClinics: 0 });
    tally.rows += 1;

    const website = row.website ?? "";
    const domain = normaliseDomain(website);
    const phone = normalisePhone(row.phone ?? "");
    const name = normaliseName(row.companyName ?? row.company_name ?? "");
    const city = (row.city ?? "").trim().toLowerCase();

    let key: string;
    let matchedOn: Clinic["matchedOn"];

    if (domain) {
      key = `d:${domain}`;
      matchedOn = "domain";
    } else if (phone) {
      key = `p:${phone}`;
      matchedOn = "phone";
    } else if (name && city) {
      key = `n:${name}|${city}`;
      matchedOn = "name+city";
    } else {
      // No domain, no phone, no name+city. Nothing here identifies a business,
      // and a row we cannot key is a row we cannot dedupe or crawl.
      report.unusable += 1;
      continue;
    }

    const contact: Contact = {
      email: (row.Email ?? "").trim().toLowerCase(),
      firstName: (row.first_name ?? "").trim(),
      lastName: (row["Last Name"] ?? "").trim(),
      jobTitle: (row.jobTitle ?? "").trim(),
      linkedIn: (row.linkedIn ?? "").trim(),
      seniority: rankContact(row.jobTitle ?? ""),
      source,
    };

    const existing = byKey.get(key);
    if (existing) {
      // Same person twice in the source is common; email is the identity.
      if (!existing.contacts.some((c) => c.email === contact.email)) {
        existing.contacts.push(contact);
      }
      // Fill blanks from later rows — the first row for a clinic is not
      // necessarily the most complete one.
      existing.phone ||= row.phone?.trim() ?? "";
      existing.city ||= (row.city ?? "").trim();
      existing.state ||= (row.state ?? "").trim();
      existing.sourceCategory ||= (row.category ?? "").trim();
      if (!existing.sources.includes(source)) {
        existing.sources.push(source);
        if (existing.sources.length === 2) report.overlap += 1;
      }
      continue;
    }

    report.mergedBy[matchedOn] += 1;
    tally.newClinics += 1;
    byKey.set(key, {
      id: createHash("sha256").update(key).digest("hex").slice(0, 16),
      matchedOn,
      domain,
      companyName: (row.companyName ?? row.company_name ?? "").trim(),
      website: website.trim(),
      city: (row.city ?? "").trim(),
      state: (row.state ?? "").trim(),
      phone: (row.phone ?? "").trim(),
      contacts: [contact],
      sourceCategory: (row.category ?? "").trim(),
      sources: [source],
    });
  }

  const clinics = [...byKey.values()];
  for (const clinic of clinics) {
    clinic.contacts.sort((a, b) => b.seniority - a.seniority);
  }

  report.clinics = clinics.length;
  return { clinics, report };
}
