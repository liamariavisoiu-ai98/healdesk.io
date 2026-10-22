/**
 * Rebuild the Instantly files from an existing all-leads.csv.
 *
 *   npx tsx src/ops/instantly-from-leads.mts <all-leads.csv> [out-dir]
 *
 * For a list that was enriched before the preview sequence existed. It does not
 * crawl or call any API. It rebuilds the hook, the offer, the closing question,
 * the subject and the scene with today's generator from the facts the old file
 * already holds (hours, service, booking platform, social channels, sites),
 * then renders the touches exactly as `npm run enrich` does and writes four
 * files: instantly-main.csv, instantly-low-enrichment.csv,
 * instantly-second-contacts.csv (a later wave) and instantly-unreadable.csv
 * (one email, no preview, for sites that would not load).
 *
 * What the old file cannot give back: job titles (the new copy no longer
 * depends on one) and the crawl's raw page links. Whether a clinic books
 * online is inferred from its platform, its booking confidence and the angle
 * the old run gave it. Where those disagree the row is treated as bookable,
 * since the wrong guess in that direction costs a weaker line, not a false
 * "every appointment starts with a phone call".
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BOOKING_PLATFORMS } from "../enrich/booking.ts";
import { buildInstantlyFiles } from "../enrich/instantly.ts";
import { buildOutreachRow, companyShort, siteHost } from "../enrich/outreach.ts";
import { buildUnreadableRow } from "../enrich/unreadable.ts";

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
  const header = (rows.shift() ?? []).map((h) => h.replace(/^\uFEFF/, "").trim());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function toCsv(rows: Row[]): string {
  if (!rows.length) return "";
  const header = Object.keys(rows[0]!);
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [header.join(","), ...rows.map((r) => header.map((h) => esc(r[h] ?? "")).join(","))].join("\n") + "\n";
}

const PLATFORM_ID = new Map(BOOKING_PLATFORMS.map((p) => [p.name.toLowerCase(), p.id]));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function parseGap(window: string, hours: string) {
  const m = /^(\w+) (\d\d:\d\d) to (\w+) (\d\d:\d\d)$/.exec(window.trim());
  if (!m || !hours) return null;
  return { hours: Number(hours), startsDay: m[1]!, startsAt: m[2]!, endsDay: m[3]!, endsAt: m[4]! };
}

const [input, outDir = "."] = process.argv.slice(2);
if (!input) {
  console.error("usage: npx tsx src/ops/instantly-from-leads.mts <all-leads.csv> [out-dir]");
  process.exit(1);
}

const rows = parseCsv(await readFile(input, "utf8"));
const rebuilt: Row[] = [];
let skipped = 0;

for (const r of rows) {
  if (!r.email) { skipped += 1; continue; }

  // A site that would not load has no facts to rebuild from. It gets the one
  // honest email from unreadable.ts, in the wording the old run's hook shows.
  if (r.list === "unreadable") {
    const reason = /couldn't find much/i.test(r.hook ?? "") ? "too little text" : "no pages fetched";
    const domain = siteHost(r.website);
    const u = buildUnreadableRow({ domain } as never, { jobTitle: "", email: r.email }, reason);
    rebuilt.push({
      list: "unreadable", clinic_id: r.clinic_id, email: r.email, first_name: r.first_name, last_name: r.last_name,
      company: r.company, company_short: companyShort(r.company), site_host: domain, website: r.website,
      phone: r.phone || r.phone_from_list || "", city: r.city, state: r.state, segment: "",
      hook: u.hook, top_offer: u.offer, closing_question: u.closingQuestion, exclude_reason: "",
    });
    continue;
  }
  if ((r.list !== "primary" && r.list !== "second-contact") || !r.segment) { skipped += 1; continue; }

  const platformName = r.booking_platform ?? "";
  const platformId = platformName ? PLATFORM_ID.get(platformName.toLowerCase()) ?? slug(platformName) : undefined;
  const bookable =
    Boolean(platformName) ||
    r.booking_confidence === "high" ||
    r.booking_confidence === "medium" ||
    ["has-booking", "closed-weekends", "closes-early"].includes(r.angle ?? "");

  const hasHours = r.hours_source === "google";
  const closedDays = (r.closed_days ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  const hours = hasHours
    ? {
        closedDays,
        closedHoursPerWeek: r.closed_hours_per_week ? Number(r.closed_hours_per_week) : null,
        closesAt: r.closes_at || undefined,
        gap: parseGap(r.gap_window ?? "", r.gap_hours ?? ""),
        match: "strong",
      }
    : undefined;

  const sites = r.site_count ? Number(r.site_count) : undefined;
  const label = {
    clinicId: r.clinic_id, segment: r.segment, confidence: r.classifier_confidence || "medium", evidence: "",
    opensAt: r.opens_at || null, closesAt: r.closes_at || null, hoursByDay: null,
    topService: r.top_service || null, offersOnlineBooking: bookable, mentionsWeightLoss: r.mentions_weight_loss === "yes",
    isChainOrFranchise: false, chainTier: r.chain_tier || undefined, siteCount: sites,
  };
  const social = (r.social_channels ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const out = buildOutreachRow(label as never, bookable ? ({ platform: platformId, platformName: platformName || null, hasOnlineBooking: true } as never) : undefined, hours as never, {
    jobTitle: "", email: r.email, social, company: r.company,
  });
  if (out.excludeReason) { skipped += 1; continue; }

  rebuilt.push({
    list: r.list, clinic_id: r.clinic_id, email: r.email, first_name: r.first_name, last_name: r.last_name,
    company: r.company, company_short: companyShort(r.company), site_host: siteHost(r.website),
    website: r.website, phone: r.phone || r.phone_from_list || "", city: r.city, state: r.state,
    segment: r.segment, booking_mode: out.bookingMode, greeting: out.greeting, subject_line: out.subjectLine,
    hook: out.hook, chat_surface: out.chatSurface, closing_question: out.closingQuestion, scenario: out.scenario,
    client_term: out.clientTerm, top_service: out.topService, gap_hours: out.gapHours, closed_days: out.closedDays,
    closes_at: hasHours ? r.closes_at ?? "" : "", site_count: r.site_count ?? "", exclude_reason: "",
  });
}

const files = buildInstantlyFiles(rebuilt);
if (files.refused.length) {
  console.error(`Refusing to write: ${files.refused.length} sent phrase(s) v1 cannot claim.\n  ${files.refused.slice(0, 10).join("\n  ")}`);
  process.exit(1);
}
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "instantly-main.csv"), toCsv(files.main));
await writeFile(join(outDir, "instantly-low-enrichment.csv"), toCsv(files.lowEnrichment));
await writeFile(join(outDir, "instantly-second-contacts.csv"), toCsv(files.secondContacts));
await writeFile(join(outDir, "instantly-unreadable.csv"), toCsv(files.unreadable));
console.log(`read ${rows.length} rows, rebuilt ${rebuilt.length}, left out ${skipped} (no email, no segment, excluded)`);
console.log(`main ${files.main.length}  low enrichment ${files.lowEnrichment.length}  second contacts ${files.secondContacts.length}  unreadable ${files.unreadable.length}`);
