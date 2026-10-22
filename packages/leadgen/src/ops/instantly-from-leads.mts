/**
 * Refresh the copy in an existing all-leads.csv and split it into the tabs.
 *
 *   npx tsx src/ops/instantly-from-leads.mts <all-leads.csv> [out-dir]
 *
 * For a list that was enriched before the preview sequence existed. It does not
 * crawl or call any API. Every row keeps every column it had (the scrape, the
 * hours, the best service, the booking platform). The columns that carry
 * copy are rebuilt with today's generator from those same facts: hook, offer,
 * closing question, angle, capability, and the new subject, scene, chat
 * surface, greeting, client word, short company name and bare domain.
 *
 * Writes leads-main.csv, leads-low-enrichment.csv and leads-unreadable.csv (a
 * second contact sits in the tab its clinic's enrichment puts it in), plus templates.json (the four touches and the
 * unreadable email, for the spreadsheet's Templates tab). The emails are
 * written in Instantly from those templates.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BOOKING_PLATFORMS } from "../enrich/booking.ts";
import { splitLeads } from "../enrich/instantly.ts";
import { TEMPLATES, UNREADABLE_TEMPLATE } from "../enrich/templates.ts";
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
      ...r, hook: u.hook, top_offer: u.offer, closing_question: u.closingQuestion, assistant_term: u.assistantTerm,
      company_short: companyShort(r.company), site_host: domain, greeting: "Hi",
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
    ...r,
    angle: out.angle, hook: out.hook, service_phrase: out.servicePhrase, top_service: out.topService,
    top_offer: out.topOffer, closing_question: out.closingQuestion, capability: out.capability,
    assistant_term: out.assistantTerm, channels: out.channels,
    // New columns, after the ones the old file had.
    booking_mode: out.bookingMode, company_short: companyShort(r.company), site_host: siteHost(r.website),
    greeting: out.greeting, subject_line: out.subjectLine, chat_surface: out.chatSurface,
    scenario: out.scenario, client_term: out.clientTerm,
  });
}

const tabs = splitLeads(rebuilt);
if (tabs.refused.length) {
  console.error(`Refusing to write: ${tabs.refused.length} sent phrase(s) v1 cannot claim.\n  ${tabs.refused.slice(0, 10).join("\n  ")}`);
  process.exit(1);
}
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "leads-main.csv"), toCsv(tabs.main));
await writeFile(join(outDir, "leads-low-enrichment.csv"), toCsv(tabs.lowEnrichment));
await writeFile(join(outDir, "leads-unreadable.csv"), toCsv(tabs.unreadable));
await writeFile(join(outDir, "templates.json"), JSON.stringify([...TEMPLATES, UNREADABLE_TEMPLATE], null, 2));
console.log(`read ${rows.length} rows, rebuilt ${rebuilt.length}, left out ${skipped} (no email, no segment, excluded)`);
console.log(`main ${tabs.main.length}  low enrichment ${tabs.lowEnrichment.length}  unreadable ${tabs.unreadable.length}`);
