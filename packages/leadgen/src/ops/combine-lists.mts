/**
 * One file from the first list's low-enrichment tab and the Apollo list.
 *
 *   npx tsx src/ops/combine-lists.mts <out.csv> --first leads-low-enrichment.csv --apollo apollo-contacts-compiled.csv
 *
 * The two lists have different columns. The first came through the enrichment
 * (hours, booking platform, hooks, scenes); the second is a raw Apollo export
 * with a specialty and a top service. The result has one set of core columns
 * (email, name, title, company, website, phone, specialty, top service) and
 * then every other column either file had, blank where it does not apply.
 *
 *  - `source` says where a row came from.
 *  - A contact in both lists keeps the first list's row, because it has the
 *    copy, and says so in `source`.
 *  - An Apollo row has the mechanical fields the templates need (greeting,
 *    greeting_name, company_short, site_host, client_term) and none of the copy
 *    that needs hours or a crawl (hook, scene, subject, closing question): its
 *    `enrichment_note` says so.
 *  - A contact with no email address stays, last, for the phone.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { greetingName } from "../enrich/instantly.ts";
import { clientTerm, companyShort, greetingFor, siteHost } from "../enrich/outreach.ts";
import { guessSpecialty, SPECIALTIES } from "../enrich/specialty.ts";

type Row = Record<string, string>;

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.length)) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const header = (rows.shift() ?? []).map((h) => h.replace(/^﻿/, "").trim());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function toCsv(rows: Row[], header: string[]): string {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [header.join(","), ...rows.map((r) => header.map((h) => esc(r[h] ?? "")).join(","))].join("\n") + "\n";
}

const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args.splice(at, 2)[1] : undefined; };
const firstPath = flag("--first");
const apolloPath = flag("--apollo");
const [out] = args;
if (!out || !firstPath || !apolloPath) {
  console.error("usage: npx tsx src/ops/combine-lists.mts <out.csv> --first leads-low-enrichment.csv --apollo apollo-contacts-compiled.csv");
  process.exit(1);
}

/** The label the first list's pipeline segment corresponds to; other-medical and blank are guessed. */
const LABEL_BY_SEGMENT = new Map<string, { label: string; topService: string }>();
for (const s of SPECIALTIES) if (s.segment !== "other-medical" && !LABEL_BY_SEGMENT.has(s.segment)) LABEL_BY_SEGMENT.set(s.segment, { label: s.label, topService: s.topService });

const CORE = [
  "source", "specialty", "top_service", "segment", "specialty_basis",
  "email", "first_name", "last_name", "title", "company", "company_short", "website", "site_host", "phone", "city", "state",
  "enrichment_note", "list", "already_in_first_list", "size_flag",
  "greeting", "greeting_name", "subject_line", "hook", "chat_surface", "closing_question", "scenario", "client_term", "top_offer",
  "booking_mode", "primary_contact",
];
/** Apollo columns carried into the core ones; not repeated under their own names. */
const APOLLO_MAPPED = new Set(["First Name", "Last Name", "Email", "Company Name", "Website", "Company City", "Company State", "Title",
  "specialty", "top_service", "segment", "specialty_basis", "already_in_list", "size_flag"]);

const first = parseCsv(readFileSync(firstPath, "utf8"));
const apollo = parseCsv(readFileSync(apolloPath, "utf8"));

const combined: Row[] = [];
const inFirst = new Set<string>();

for (const r of first) {
  inFirst.add(r.email.toLowerCase());
  const unreadable = r.list === "unreadable";
  let label: string, top: string, basis = "first list's classifier";
  const mapped = LABEL_BY_SEGMENT.get(r.segment);
  if (mapped) { label = mapped.label; top = r.top_service || mapped.topService; }
  else {
    const g = guessSpecialty({ company: r.company, title: "", industry: "medical practice", keywords: r.classifier_evidence ?? "" });
    label = g.label; top = r.top_service || g.topService; basis = g.basis;
  }
  combined.push({
    ...r,
    source: unreadable ? "First list: unreadable site" : "First list: low enrichment",
    specialty: label, top_service: top, specialty_basis: basis,
    title: "", already_in_first_list: "", size_flag: "",
  });
}

let both = 0;
for (const a of apollo) {
  const email = (a.Email ?? "").toLowerCase();
  if (email && inFirst.has(email)) {
    const held = combined.find((r) => r.email.toLowerCase() === email)!;
    held.source = `${held.source} (also in Apollo list)`;
    held.title = held.title || a.Title;
    both += 1;
    continue;
  }
  const segment = a.segment;
  const company = a["Company Name"];
  const host = siteHost(a.Website ?? "");
  const phone = (a["Work Direct Phone"] || a["Corporate Phone"] || a["Company Phone"] || a["Mobile Phone"] || "").replace(/^'/, "");
  const noEmail = !email;
  const clinic = segment !== "not-a-target";
  const row: Row = {
    source: "Second list: Apollo",
    specialty: a.specialty, top_service: a.top_service, segment, specialty_basis: a.specialty_basis,
    email: a.Email, first_name: a["First Name"], last_name: a["Last Name"], title: a.Title,
    company, company_short: companyShort(company), website: host, site_host: host, phone,
    city: a["Company City"], state: a["Company State"],
    enrichment_note: noEmail
      ? "no email address: phone or LinkedIn only"
      : clinic ? "Apollo export only: not enriched, no hook, scene or subject yet" : "not a clinic prospect",
    list: "apollo", already_in_first_list: a.already_in_list, size_flag: a.size_flag,
    greeting: greetingFor(clinic ? segment : "other-medical", a.Email || company),
    greeting_name: greetingName(a["First Name"], a["Last Name"]),
    client_term: clientTerm(clinic ? segment : "other-medical"),
  };
  for (const [k, v] of Object.entries(a)) if (!APOLLO_MAPPED.has(k)) row[k] = v;
  combined.push(row);
}

// First-list low enrichment, then the Apollo clinics by specialty, then what is not a prospect,
// then the first list's unreadable-site block (a different email), then contacts with no email.
const rank = (r: Row) =>
  !r.email ? 4 : r.source.startsWith("First list: unreadable") ? 3 : r.source.startsWith("First list") ? 0 : r.segment === "not-a-target" ? 2 : 1;
combined.sort((x, y) => rank(x) - rank(y) || (rank(x) === 1 ? x.specialty.localeCompare(y.specialty) : 0));

const extra = new Set<string>();
for (const r of combined) for (const k of Object.keys(r)) if (!CORE.includes(k)) extra.add(k);
const header = [...CORE, ...extra];
writeFileSync(out, toCsv(combined, header));

const bySource = new Map<string, number>();
for (const r of combined) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
console.log(`${combined.length} rows, ${header.length} columns; ${both} contacts were in both lists`);
for (const [k, n] of bySource) console.log(`  ${String(n).padStart(5)}  ${k}`);
console.log(`  ${String(combined.filter((r) => !r.email).length).padStart(5)}  with no email`);
