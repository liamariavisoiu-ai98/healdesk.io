#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { detectBooking } from "./booking.ts";
import { buildOutreachRow } from "./outreach.ts";
import { fetchPlaceHours, type PlaceHours } from "./places.ts";
import { probeDomains, type DnsFinding } from "./dns-probe.ts";
import { crawlSites, type CrawlResult } from "./crawl.ts";
import { dedupe, type LeadRow } from "./dedupe.ts";
import { labelClinics, labelClinicsBatched, type Label } from "./label.ts";
import { buildReport, formatReport } from "./report.ts";
import { isPlatformId } from "@healdesk/catalog";
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
  if (index === -1) return undefined;

  const value = process.argv[index + 1];
  // `--limit` with nothing after it, or followed by another flag, used to read
  // as "no limit given" — reinstating the exact failure numericArg exists to
  // prevent, one level lower down. A flag that was typed but has no value is a
  // mistake, and the only safe response to a mistake that spends money is to
  // stop.
  if (value === undefined || value.startsWith("--")) {
    console.error(`--${name} was given without a value.`);
    process.exit(1);
  }
  return value;
}

/**
 * A numeric flag, or a usage error — never a silent fallback.
 *
 * `Number("2OO")` is NaN, and `Number.isFinite(NaN)` is false, so a typo in
 * `--limit` used to mean "no limit at all". Someone asking for a 200-domain
 * sample would have crawled all 4,512. A flag that cannot be parsed is a
 * mistake, and the only safe response to it is to stop.
 */
function numericArg(name: string): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return undefined;

  if (!/^\d+$/.test(raw)) {
    console.error(
      `--${name} must be a whole number, got "${raw}". Refusing to guess: the ` +
        `wrong guess here spends money.`,
    );
    process.exit(1);
  }
  return Number(raw);
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
        "read tomorrow morning has no reason to pay for low latency.\n\n" +
        "--concurrency N runs N Apify batches at once. Default 1. Set it to the\n" +
        "plan's concurrent-run cap (free 5, Starter 32) — above that Apify\n" +
        "queues the excess rather than running it.",
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

  const limit = numericArg("limit") ?? Number.POSITIVE_INFINITY;
  const crawlPath = join(DATA, "02-crawl.json");

  // Incremental, not all-or-nothing.
  //
  // Whatever has already been crawled is kept and only the remainder is
  // fetched, so growing a 200-domain sample into the full 4,512 costs the
  // 4,312 difference rather than starting again. The same mechanism makes the
  // long run resumable: interrupt it at any point and the next invocation
  // continues from where it stopped.
  const already: CrawlResult[] =
    !flag("force-crawl") && existsSync(crawlPath)
      ? (JSON.parse(await readFile(crawlPath, "utf8")) as CrawlResult[])
      : [];

  // A site that failed is worth one more attempt — timeouts are frequently
  // transient, and the first sample lost two obvious clinics that way. A site
  // that returned real content is never re-fetched; it is already paid for.
  const done = new Set(already.filter((c) => !c.error).map((c) => c.clinicId));
  // Everything ever attempted, successful or not — the retry marker below
  // needs "have we tried this before", not "did it work".
  const attempted = new Set(already.map((c) => c.clinicId));
  const retrying = already.length - done.size;

  const targets = clinics
    .filter((c) => c.domain)
    .slice(0, Number.isFinite(limit) ? limit : undefined)
    .filter((c) => !done.has(c.id))
    // Marked per target rather than counted, so the crawler can tell which
    // probe rows are first attempts and which are known-bad retries.
    .map((c) => ({
      clinicId: c.id,
      domain: c.domain,
      isRetry: attempted.has(c.id),
    }));

  if (already.length) {
    console.log(
      `  ${done.size} already crawled, ${retrying} being retried, ` +
        `${targets.length} new`,
    );
  }

  let crawls: CrawlResult[];
  if (targets.length === 0) {
    console.log("  nothing left to crawl");
    crawls = already;
  } else {
    if (!apifyToken) {
      console.error("  APIFY_TOKEN is not set and there is more to crawl.");
      process.exit(1);
    }

    // Everything not being re-attempted survives, whatever the current --limit.
    //
    // Keying on `done` dropped every previously-FAILED row that fell outside
    // the limit: they were neither kept nor re-crawled, so a narrow run
    // silently deleted them from the only record of what had been attempted —
    // and the next full run paid to crawl them again.
    const attempting = new Set(targets.map((t) => t.clinicId));
    const keep = already.filter((c) => !attempting.has(c.clinicId));
    const write = async (partial: CrawlResult[]) => {
      await mkdir(DATA, { recursive: true });
      // Written to a temp file and renamed, because rename is atomic on one
      // filesystem. Writing in place means an interrupt mid-write leaves a
      // truncated JSON document — and this file is the only record of pages
      // that have already been paid for.
      const tmp = `${crawlPath}.tmp`;
      await writeFile(tmp, JSON.stringify([...keep, ...partial], null, 2));
      await rename(tmp, crawlPath);
    };

    const fresh = await crawlSites(targets, {
      token: apifyToken,
      // Sequential by default. --concurrency raises it to match the Apify plan:
      // free allows 5 concurrent actor runs, Starter 32. Setting it above the
      // plan's cap gets the excess queued or rejected, not run.
      concurrency: numericArg("concurrency") ?? 1,
      // Archive every page. ~54 MB gzipped for the full list, against ~$24 to
      // re-crawl it — so any fingerprint found later is a free local re-scan
      // rather than a second paid crawl.
      htmlDir: join(DATA, "html"),

      onProgress: (n, total) => process.stdout.write(`\r  crawled ${n}/${total}`),
      // Persisted per batch, so an interruption costs one batch rather than
      // everything fetched so far.
      onBatch: write,
    });
    process.stdout.write("\n");

    await write(fresh);

    // Sorted back into clinic order before it is used.
    //
    // Each half is internally ordered, but the file is [previously kept] then
    // [newly crawled], so a clinic's position depends on which run first
    // succeeded for it. Everything downstream keys by clinicId so nothing is
    // wrong — but two runs of the same list produce differently ordered files,
    // which makes diffing them to see what actually changed far harder than it
    // needs to be.
    const order = new Map(clinics.map((c, i) => [c.id, i]));
    crawls = [...keep, ...fresh].sort(
      (a, b) => (order.get(a.clinicId) ?? 0) - (order.get(b.clinicId) ?? 0),
    );
  }

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

  // Incremental for the same reason the crawl is, and this one is sharper: the
  // checkpoint used to return the cached file whole. Crawling 4,512 clinics
  // after a 200-clinic sample would have handed back the 200 stale labels and
  // never classified the other 4,312 — with no error, and a report whose
  // segment shares described the sample while claiming to describe the list.
  const labelPath = join(DATA, "03-labels.json");
  const batchIdPath = join(DATA, "03-batch-id.txt");

  // --force-label means re-classify. Leaving the batch id in place made it
  // resume the previous batch and return exactly the labels the flag was asked
  // to discard — the flag silently doing the opposite of its name.
  if (flag("force-label") && existsSync(batchIdPath)) {
    rmSync(batchIdPath);
    console.log("  --force-label: discarded the resumable batch id");
  }
  const priorLabels: Label[] =
    !flag("force-label") && existsSync(labelPath)
      ? (JSON.parse(await readFile(labelPath, "utf8")) as Label[])
      : [];

  // Anything previously unreadable is re-labelled, since the crawl above may
  // have just succeeded where it failed before.
  const settled = new Map(
    priorLabels.filter((l) => l.segment !== "unknown").map((l) => [l.clinicId, l]),
  );
  const needLabel = crawls.filter((c) => !settled.has(c.clinicId));

  console.log(
    `  ${settled.size} already labelled, ${needLabel.length} to classify`,
  );

  let labels: Label[];
  if (needLabel.length === 0) {
    labels = [...settled.values()];
  } else {
    // Batch is half price and this job has no latency requirement — but a
    // batch can take up to 24h, so the sample run wants the streaming path for
    // immediate feedback and the full run wants the discount.
    const label = flag("batch") ? labelClinicsBatched : labelClinics;
    if (flag("batch")) {
      console.log("  using the Batch API — half price, may take up to 24h");
    }

    const fresh = await label(needLabel, {
      apiKey: anthropicKey,
      maxCalls: numericArg("max-llm") ?? needLabel.length,
      batchIdFile: batchIdPath,
      onProgress: (n, total) => process.stdout.write(`\r  labelled ${n}/${total}`),
    });
    process.stdout.write("\n");

    labels = [...settled.values(), ...fresh];
    await mkdir(DATA, { recursive: true });
    await writeFile(labelPath, JSON.stringify(labels, null, 2));

    // Only now is the batch genuinely safe to forget. Deleting the id before
    // this write meant a crash in between lost a paid-for batch entirely.
    if (existsSync(batchIdPath)) rmSync(batchIdPath);
  }

  // ---- 3b. DNS sweep ------------------------------------------------------
  //
  // Only over the clinics still reported as having no booking, because that is
  // the only population where it can add anything — and it keeps the query
  // count to the blind spot rather than the whole list.
  //
  // Free and cooperation-free: public DNS, no request to the clinic's servers,
  // nothing to breach. Measured yield is modest — 14 of 311 on the sample, and
  // an adversarial review put the genuinely-new-and-in-segment share nearer
  // 1.5% — so it supplements the signature table rather than replacing it.
  let dnsFindings: DnsFinding[] = [];
  if (!flag("no-dns")) {
    const undetected = crawls
      .filter((c) => !c.error && !detectBooking(c.links ?? []).hasOnlineBooking)
      .map((c) => c.domain);

    if (undetected.length) {
      console.log(`\n[3b/4] dns sweep over ${undetected.length} undetected clinics`);
      dnsFindings = await checkpoint<DnsFinding[]>(
        "03b-dns",
        flag("force-dns"),
        () =>
          probeDomains(undetected, {
            concurrency: numericArg("dns-concurrency") ?? 12,
            onProgress: (n, t) => process.stdout.write(`\r  probed ${n}/${t}`),
          }).then((f) => {
            process.stdout.write("\n");
            return f;
          }),
      );
      console.log(`  ${dnsFindings.length} platforms found in DNS`);
    }
  }

  // ---- 3c. Google hours ---------------------------------------------------
  //
  // The website is a dead end for hours — 12% of homepages state any, 0% carry
  // schema.org openingHours, because the structured form lives in the <head>
  // the crawler strips. Google is where clinics actually publish them, and
  // publishes them per-day including the explicit closed days the outreach
  // turns on.
  //
  // Scoped to clinics that will actually be emailed, so nothing is spent
  // looking up hours for a device manufacturer.
  let places: PlaceHours[] = [];
  if (flag("hours")) {
    const wanted = clinics.filter((c) => {
      const l = labels.find((x) => x.clinicId === c.id);
      return l && l.segment !== "not-a-target" && l.segment !== "unknown";
    });

    console.log(`\n[3c/4] google hours for ${wanted.length} clinics`);
    places = await checkpoint<PlaceHours[]>("03c-hours", flag("force-hours"), () =>
      fetchPlaceHours(
        wanted.map((c) => ({
          clinicId: c.id,
          company: c.companyName,
          city: c.city,
          state: c.state,
          domain: c.domain,
        })),
        {
          token: apifyToken!,
          onProgress: (n, t) => process.stdout.write(`\r  looked up ${n}/${t}`),
        },
      ).then((r) => {
        process.stdout.write("\n");
        return r;
      }),
    );

    const strong = places.filter((p) => p.match === "strong").length;
    const withHours = places.filter((p) => p.hoursByDay).length;
    console.log(
      `  ${strong} matched on website, ${withHours} have hours ` +
        `(${Math.round((100 * withHours) / Math.max(places.length, 1))}%)`,
    );
  }

  // ---- 4. Report and export ------------------------------------------------
  console.log("\n[4/4] report\n");
  const report = buildReport(
    clinics,
    labels,
    dedupeReport.inputRows,
    crawlFailed,
    crawls,
  );
  console.log(formatReport(report));

  await writeFile(join(DATA, "report.json"), JSON.stringify(report, null, 2));

  // One CSV per segment, contact-ready. The whole point of the exercise is that
  // the campaign can be pointed at one of these files without further work.
  const byId = new Map(clinics.map((c) => [c.id, c]));
  const crawlById = new Map(crawls.map((c) => [c.clinicId, c]));
  // Only strong matches carry hours into an email. A weak name match is another
  // business's opening times addressed to this one.
  const placeById = new Map(
    places.filter((p) => p.match === "strong").map((p) => [p.clinicId, p]),
  );
  // Deterministic, free, and computed from the cached crawl — so re-running the
  // report after tuning a signature costs nothing and needs no re-crawl.
  // Keyed only on crawls that actually produced links.
  //
  // A crawl returning zero links is an absence of evidence, and detectBooking
  // faithfully reports hasOnlineBooking:false for it — which downstream then
  // read as "this clinic has no online booking". That is the strongest claim in
  // the dataset being derived from a failed fetch. Excluding them lets the
  // model's own guess serve as the fallback it was always described as.
  const booking = new Map(
    crawls
      .filter((c) => (c.links?.length ?? 0) > 0)
      .map((c) => [c.clinicId, detectBooking(c.links!)]),
  );

  // DNS findings override "no booking found", never a page-level detection.
  // A link on the page is stronger evidence than a DNS record: the record
  // proves the vendor terminates that hostname, the link proves the clinic
  // actually sends patients there.
  const dnsByDomain = new Map(dnsFindings.map((f) => [f.domain, f]));
  for (const c of crawls) {
    const found = dnsByDomain.get(c.domain.replace(/^www\./, ""));
    if (!found) continue;
    const existing = booking.get(c.clinicId);
    if (existing?.hasOnlineBooking) continue;

    booking.set(c.clinicId, {
      hasOnlineBooking: true,
      platform: found.platform,
      platformName: found.platform,
      supported: isPlatformId(found.platform),
      bookingUrl: null,
      confidence: "medium",
      allPlatforms: [found.platform],
    });
  }

  const bySegment = new Map<Segment, Record<string, string>[]>();

  for (const label of labels) {
    const clinic = byId.get(label.clinicId);
    if (!clinic) continue;

    // Best contact only. A second email to the same clinic within a cold
    // sequence reads as a blast and burns the domain, not just the lead.
    const contact = clinic.contacts[0];
    if (!contact?.email) continue;

    const book = booking.get(label.clinicId);
    const bucket = bySegment.get(label.segment) ?? [];
    const out = buildOutreachRow(label, book, placeById.get(clinic.id));

    bucket.push({
      // --- what a sending tool merges -------------------------------------
      email: contact.email,
      first_name: contact.firstName,
      last_name: contact.lastName,
      company: clinic.companyName,
      city: clinic.city,
      state: clinic.state,
      // Site first: it is the number patients actually dial, and therefore the
      // one that has to forward. The list's number is kept beside it because
      // the two disagree often enough that picking silently would hide it.
      phone: (crawlById.get(clinic.id)?.phones ?? [])[0] ?? clinic.phone,
      phone_from_list: clinic.phone,

      // --- what the email says ---------------------------------------------
      angle: out.angle,
      hook: out.hook,
      // Both forms. service_phrase carries its own article so a template cannot
      // produce "a injectables appointment"; top_service is the bare noun for
      // subject lines, where an article reads wrong.
      service_phrase: out.servicePhrase,
      top_service: out.topService,
      closed_days: out.closedDays,
      closed_hours_per_week: out.closedHoursPerWeek,
      opens_at: placeById.get(clinic.id)?.opensAt ?? label.opensAt ?? "",
      closes_at: placeById.get(clinic.id)?.closesAt ?? label.closesAt ?? "",

      // --- whether to send at all ------------------------------------------
      exclude_reason: out.excludeReason,
      segment: label.segment,

      // --- traceable back to evidence, one column not five ------------------
      website: clinic.website,
      booking_platform: book?.platformName ?? "",
      clinic_id: clinic.id,
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
    // Say whether there is paid-for work waiting, because the fix is the same
    // either way but the stakes are not.
    const pending = existsSync(join(DATA, "03-batch-id.txt"))
      ? "\n  A submitted batch is waiting — re-running collects it rather than\n" +
        "  resubmitting, so nothing already paid for is lost.\n"
      : "";

    console.error(
      "\nAnthropic credentials failed.\n" + pending + "\n" +
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
