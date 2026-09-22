/**
 * Convert an Apollo export into the input schema the enrichment reads.
 *
 * Apollo's export carries ~60 columns under its own names; the pipeline reads
 * fourteen under different ones. The first batch was converted by hand before
 * this repo existed, so the second arrived in raw Apollo form and nothing knew
 * how to read it.
 *
 * Run from packages/leadgen:
 *   npx tsx src/ops/apollo-to-input.mts <apollo.csv> <out.csv>
 *
 * The output is safe to concatenate with an existing input CSV: dedupe keys on
 * the normalised domain and the clinic id is sha256 of that key, so a clinic
 * present in both batches lands on the SAME id and reuses the crawl, labels
 * and hours already paid for. Only genuinely new domains cost anything.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , src, dest] = process.argv;
if (!src || !dest) {
  console.error("usage: apollo-to-input.mts <apollo.csv> <out.csv>");
  process.exit(1);
}

/** Minimal RFC4180 reader. Apollo quotes freely and embeds commas and newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(cell); cell = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function toCsv(rows: Record<string, string>[], cols: string[]): string {
  const esc = (v: string) =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => esc(r[c] ?? "")).join(",")),
  ].join("\n") + "\n";
}

const parsed = parseCsv(readFileSync(src, "utf8"));
const header = parsed[0]!;
const idx = new Map(header.map((h, i) => [h.trim(), i]));
const get = (row: string[], name: string) => (row[idx.get(name) ?? -1] ?? "").trim();

/**
 * The batch-1 header exactly, including the two columns Apollo has no source
 * for. Concatenating two CSVs whose headers differ silently shifts every
 * column after the first divergence, so the shape has to match even where the
 * values are empty.
 */
const OUT_COLS = [
  "Email", "Email Provider", "first_name", "Last Name", "jobTitle", "linkedIn",
  "companyName", "website", "city", "phone", "state", "country", "category",
  "company_name",
];

/**
 * Apollo prefixes phone numbers with an apostrophe so Excel keeps them as
 * text. It is a spreadsheet artefact, not part of the number, and it survives
 * all the way into phone_from_list in the outreach CSV if nothing removes it.
 */
function cleanPhone(v: string): string {
  return v.replace(/^['\u2019]+/, "").trim();
}

const out: Record<string, string>[] = [];
let noEmail = 0;
let noWebsite = 0;
let unverified = 0;

for (const row of parsed.slice(1)) {
  if (row.length < 2) continue;

  const email = get(row, "Email").toLowerCase();
  if (!email) { noEmail++; continue; }

  // Apollo's own verification verdict. "Unavailable" and "Extrapolated" mean
  // it guessed the pattern rather than confirmed the mailbox, and a bounce on
  // a three-week-old sending domain costs more than the lead is worth.
  const status = get(row, "Email Status");
  if (status && status !== "Verified") { unverified++; continue; }

  const website = get(row, "Website");
  if (!website) noWebsite++;

  out.push({
    Email: email,
    "Email Provider": "",
    first_name: get(row, "First Name"),
    "Last Name": get(row, "Last Name"),
    jobTitle: get(row, "Title"),
    linkedIn: get(row, "Person Linkedin Url"),
    companyName: get(row, "Company Name"),
    website,
    // Company location beats contact location. Apollo fills both and they
    // diverge: "City" is where the PERSON is, which for a multi-site group or
    // a remote owner is not where the clinic is. The clinic's city feeds the
    // Google Places lookup, and the wrong metro returns the wrong business.
    city: get(row, "Company City") || get(row, "City"),
    phone: cleanPhone(get(row, "Corporate Phone") || get(row, "Company Phone")),
    state: get(row, "Company State") || get(row, "State"),
    country: get(row, "Company Country") || get(row, "Country"),
    category: get(row, "Industry"),
    company_name: "",
  });
}

writeFileSync(dest, toCsv(out, OUT_COLS));
console.log(`read    ${parsed.length - 1} Apollo rows`);
console.log(`dropped ${noEmail} with no email, ${unverified} not Verified`);
console.log(`wrote   ${out.length} rows -> ${dest}`);
console.log(`         ${noWebsite} of them have no website and will key on phone or name+city`);
