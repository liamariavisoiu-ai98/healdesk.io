#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { crawlSites, type CrawlResult } from "./crawl.ts";
import { dedupe, type LeadRow } from "./dedupe.ts";
import { labelClinics, labelClinicsBatched, type Label } from "./label.ts";
import { buildReport, formatReport } from "./report.ts";
import { SEGMENT_LABELS, type Segment } from "./segments.ts";

/**
 * Turn a raw contact list into a segmented, deduped, evidence-backed clinic list.
 *
 *   npm run enrich -w @healdesk/leadgen -- --input ~/Downloads/healdesk_leads.csv
 *
 * Needs APIFY_TOKEN and ANTHROPIC_API_KEY.
 *
 * ## Every stage checkpoints to disk
 *
 * Crawling ~4,500 domains costs real money and real time, and classification
 * costs more. A pipeline that loses that work because stage three threw is a
 * pipeline nobody runs twice. So each stage writes its output and skips itself
 * if that output already exists — re-running is free, and `--force` redoes a
 * single stage without redoing the ones before it.
 *
 * ## Nothing here writes to the product database
 *
 * Output is CSV and JSON under packages/leadgen/data/, which is gitignored.
 * Scraped business data is not patient data, but it is also not something that
 * belongs in version control, and the PHI boundary stays where it is.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, "../../data");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * A CSV parser that handles quoted fields containing commas and newlines.
 *
 * Deliberately not a split(","). Clinic names contain commas ("Radiance Med
 * Spa, LLC") often enough that a naive split silently shifts every subsequent
 * column on those rows — and the damage shows up as a handful of clinics with
 * a phone number in the state field, which nobody notices until the segment
 * tally is already wrong.
 */
function parseCsv(text: string): LeadRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const header = (rows.shift() ?? []).map((h) => h.replace(/^﻿/, "").trim());
  return rows
    .filter((r) => r.some((cell) => cell.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function toCsv(rows: Record<string, string>[]): string {
  if (!rows.length) return "";
  const header = Object.keys(rows[0]!);
  const escape = (v: string) =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

  return [
    header.join(","),
    ...rows.map((r) => header.map((h) => escape(r[h] ?? "")).join(",")),
  ].join("\n");
}

async function checkpoint<T>(
  name: string,
  force: boolean,
  produce: () => Promise<T>,
): Promise<T> {
  const path = join(DATA, `${name}.json`);

  if (!force && existsSync(path)) {
    console.log(`  ${name}: reusing ${path}`);
    return JSON.parse(await readFile(path, "utf8")) as T;
  }

  const result = await produce();
  await mkdir(DATA, { recursive: true });
  await writeFile(path, JSON.stringify(result, null, 2));
  console.log(`  ${name}: wrote ${path}`);
  return result;
}

async function main(): Promise<void> {
  const input = arg("input");
  if (!input) {
    console.error(
      "Missing --input.\n" +
        "  npm run enrich -w @healdesk/leadgen -- --input ~/Downloads/healdesk_leads.csv\n\n" +
        "Stages: dedupe → crawl → label → report. Each checkpoints to\n" +
        "packages/leadgen/data/. Re-running is free; --force-crawl or\n" +
        "--force-label redoes one stage without redoing the earlier ones.\n\n" +
        "Add --batch on the full run: half the token price, since a job you\n" +
        "read tomorrow morning has no reason to pay for low latency.",
    );
    process.exit(1);
  }

  const inputPath = input.replace(/^~/, process.env.HOME ?? "~");

  // ---- 1. Dedupe -----------------------------------------------------------
  console.log("\n[1/4] dedupe");
  const { clinics, report: dedupeReport } = await checkpoint(
    "01-clinics",
    flag("force-dedupe"),
    async () => {
      const raw = await readFile(inputPath, "utf8");
      const rows = parseCsv(raw);
      const result = dedupe(rows);
      console.log(
        `  ${result.report.inputRows} rows → ${result.report.clinics} clinics ` +
          `(${result.report.unusable} unusable)`,
      );
      return result;
    },
  );

  // ---- 2. Crawl ------------------------------------------------------------
  console.log("\n[2/4] crawl");
  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken && !existsSync(join(DATA, "02-crawl.json"))) {
    console.error("  APIFY_TOKEN is not set, and there is no cached crawl.");
    process.exit(1);
  }

  const limit = Number(arg("limit") ?? Number.POSITIVE_INFINITY);
  const targets = clinics
    .filter((c) => c.domain)
    .slice(0, Number.isFinite(limit) ? limit : undefined)
    .map((c) => ({ clinicId: c.id, domain: c.domain }));

  const crawls = await checkpoint<CrawlResult[]>(
    "02-crawl",
    flag("force-crawl"),
    () =>
      crawlSites(targets, {
        token: apifyToken!,
        onProgress: (done, total) =>
          process.stdout.write(`\r  crawled ${done}/${total}`),
      }).then((r) => {
        process.stdout.write("\n");
        return r;
      }),
  );

  const crawlFailed = crawls.filter((c) => c.error).length;
  console.log(`  ${crawls.length - crawlFailed} readable, ${crawlFailed} not`);

  // ---- 3. Label ------------------------------------------------------------
  console.log("\n[3/4] label");
  // No key check here, on purpose.
  //
  // An earlier version refused to start unless ANTHROPIC_API_KEY was set, which
  // rejected the credential most people actually have: the OAuth profile written
  // by `ant auth login`, which the SDK finds on its own. Pre-flighting a check
  // the SDK already does, using a narrower rule than the SDK uses, only ever
  // produces false rejections — so let the SDK resolve, and explain properly if
  // nothing resolves.
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // Batch is half price and this job has no latency requirement — but batches
  // can take up to 24h, so the sample run wants the streaming path for fast
  // feedback and the full run wants the discount.
  const label = flag("batch") ? labelClinicsBatched : labelClinics;
  if (flag("batch")) {
    console.log("  using the Batch API — half price, may take up to 24h");
  }

  const labels = await checkpoint<Label[]>("03-labels", flag("force-label"), () =>
    label(crawls, {
      apiKey: anthropicKey,
      maxCalls: Number(arg("max-llm") ?? crawls.length),
      onProgress: (done, total) =>
        process.stdout.write(`\r  labelled ${done}/${total}`),
    }).then((r) => {
      process.stdout.write("\n");
      return r;
    }),
  );

  // ---- 4. Report and export ------------------------------------------------
  console.log("\n[4/4] report\n");
  const report = buildReport(clinics, labels, dedupeReport.inputRows, crawlFailed);
  console.log(formatReport(report));

  await writeFile(join(DATA, "report.json"), JSON.stringify(report, null, 2));

  // One CSV per segment, contact-ready. The whole point of the exercise is that
  // the campaign can be pointed at one of these files without further work.
  const byId = new Map(clinics.map((c) => [c.id, c]));
  const bySegment = new Map<Segment, Record<string, string>[]>();

  for (const label of labels) {
    const clinic = byId.get(label.clinicId);
    if (!clinic) continue;

    // Best contact only. A second email to the same clinic within a cold
    // sequence reads as a blast and burns the domain, not just the lead.
    const contact = clinic.contacts[0];
    if (!contact?.email) continue;

    const bucket = bySegment.get(label.segment) ?? [];
    bucket.push({
      clinic_id: clinic.id,
      company: clinic.companyName,
      website: clinic.website,
      domain: clinic.domain,
      city: clinic.city,
      state: clinic.state,
      phone: clinic.phone,
      email: contact.email,
      first_name: contact.firstName,
      last_name: contact.lastName,
      job_title: contact.jobTitle,
      segment: label.segment,
      confidence: label.confidence,
      evidence: label.evidence,
      phone_dependent: label.offersOnlineBooking ? "no" : "yes",
      weight_loss: label.mentionsWeightLoss ? "yes" : "no",
      chain: label.isChainOrFranchise ? "yes" : "no",
      contacts_at_clinic: String(clinic.contacts.length),
    });
    bySegment.set(label.segment, bucket);
  }

  const outDir = join(DATA, "segments");
  await mkdir(outDir, { recursive: true });

  console.log("\n  segment files:");
  for (const [segment, rows] of bySegment) {
    const path = join(outDir, `${segment}.csv`);
    await writeFile(path, toCsv(rows));
    console.log(
      `    ${SEGMENT_LABELS[segment].padEnd(38)} ${String(rows.length).padStart(5)}  ${path}`,
    );
  }

  console.log(
    "\n  Rank on the high-confidence column, not the total — and read the\n" +
      "  warnings above before choosing. See docs/leadgen-enrichment.md.\n",
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);

  // The one failure worth explaining rather than dumping. Everything else is
  // better served by the raw error.
  if (/api[_ -]?key|authentication|401|credential/i.test(message)) {
    console.error(
      "\nNo Anthropic credentials found.\n\n" +
        "  Either log in once — no key to store:\n" +
        "    ant auth login --no-browser\n\n" +
        "  Or export a key from console.anthropic.com:\n" +
        "    export ANTHROPIC_API_KEY=sk-ant-...\n\n" +
        `  (underlying error: ${message})`,
    );
    process.exit(1);
  }

  console.error("\nenrichment failed:", error);
  process.exit(1);
});
