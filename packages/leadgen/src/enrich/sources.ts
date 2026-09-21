import type { LeadRow } from "./dedupe.ts";

/**
 * Bring every input file to the one column set dedupe() reads.
 *
 * The first list arrived with a bespoke header — `website`, `phone`,
 * `first_name`, `jobTitle` and so on — and dedupe() was written against it.
 * The second list is a raw Apollo export: `Website`, `Company Phone`, `First
 * Name`, `Title`. Fed in unchanged, every one of its rows reads as having no
 * domain, no phone and no name, so dedupe() files all 3,700 of them under
 * "unusable" and the run continues with zero new clinics. Nothing throws. The
 * report says "3,700 rows → 0 clinics", the CSVs come out identical to last
 * time, and the batch looks processed.
 *
 * So the format is detected from the header and the mapping is explicit, and
 * a file that matches neither stops the run rather than being guessed at.
 */

export type SourceFormat = "canonical" | "apollo";

/** The columns dedupe() actually reads. Anything else is carried through. */
const CANONICAL_REQUIRED = ["website", "Email"] as const;

const APOLLO_MAP: ReadonlyArray<readonly [canonical: string, apollo: string[]]> = [
  ["website", ["Website"]],
  // The company's number first: it is the line patients dial. The direct
  // line is a person's desk and moves when they do.
  ["phone", ["Company Phone", "Corporate Phone", "Work Direct Phone"]],
  ["companyName", ["Company Name", "Company Name for Emails"]],
  // Apollo carries the contact's own city as `City` and the account's as
  // `Company City`. The clinic is what gets crawled and emailed about, and a
  // practice manager who lives one town over is not a second location.
  ["city", ["Company City", "City"]],
  ["state", ["Company State", "State"]],
  ["Email", ["Email"]],
  ["first_name", ["First Name"]],
  ["Last Name", ["Last Name"]],
  ["jobTitle", ["Title"]],
  ["linkedIn", ["Person Linkedin Url"]],
  ["category", ["Industry"]],
];

export function detectSourceFormat(header: readonly string[]): SourceFormat | null {
  const has = new Set(header.map((h) => h.trim()));

  if (CANONICAL_REQUIRED.every((h) => has.has(h))) return "canonical";
  if (has.has("Apollo Contact Id")) return "apollo";
  if (["Website", "Company Name", "Email", "Title"].every((h) => has.has(h))) {
    return "apollo";
  }
  return null;
}

/**
 * Apollo exports phone numbers as `'+1 804-464-3801` — the leading apostrophe
 * is a spreadsheet-ism that stops Excel turning the number into arithmetic.
 * normalisePhone() strips it for matching, but the raw value is what lands in
 * the `phone_from_list` column, and an apostrophe in front of a number in a
 * sending tool's merge field is exactly the kind of thing nobody notices until
 * it has gone out.
 */
function cleanPhone(raw: string): string {
  return (raw ?? "").trim().replace(/^'+/, "").trim();
}

function firstFilled(row: LeadRow, keys: readonly string[]): string {
  for (const key of keys) {
    const value = (row[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

export function normaliseRow(row: LeadRow, format: SourceFormat): LeadRow {
  if (format === "canonical") {
    return { ...row, phone: cleanPhone(row.phone ?? "") };
  }

  const out: LeadRow = {};
  for (const [canonical, candidates] of APOLLO_MAP) {
    out[canonical] = firstFilled(row, candidates);
  }
  out.phone = cleanPhone(out.phone ?? "");
  return out;
}

/**
 * Normalise a whole file and stamp every row with where it came from.
 *
 * The stamp survives dedupe as `Contact.source` and `Clinic.sources`, and
 * comes out in the CSV. Without it, once two lists are merged there is no way
 * to tell which batch a clinic arrived in — which is the first thing anyone
 * asks when a batch turns out to be worse than the last.
 */
export function normaliseRows(
  rows: LeadRow[],
  format: SourceFormat,
  source: string,
): LeadRow[] {
  return rows.map((row) => ({ ...normaliseRow(row, format), source }));
}
