#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_QUERIES, runPipeline, toCsv } from "./pipeline.ts";
import { UNCOVERED_SIGNALS } from "./score.ts";

/**
 * Usage:
 *   npm run discover -w @healdesk/leadgen -- --location "Austin, Texas"
 *   npm run discover -w @healdesk/leadgen -- --location "Miami, Florida" --max-llm 100
 *
 * Requires APIFY_TOKEN and ANTHROPIC_API_KEY in the environment.
 * Output lands in packages/leadgen/data/ (gitignored — scraped business data
 * does not belong in version control).
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const location = arg("location");
  if (!location) {
    console.error(
      'Missing --location. Example: --location "Austin, Texas"\n' +
        "Tip: split large metros by neighbourhood — a single broad query caps at ~120 results.",
    );
    process.exit(1);
  }

  const queriesArg = arg("queries");
  const queries = queriesArg
    ? queriesArg.split(",").map((q) => q.trim()).filter(Boolean)
    : DEFAULT_QUERIES;

  const maxLlm = Number(arg("max-llm") ?? 50);

  const prospects = await runPipeline({
    location,
    queries,
    maxLlmCalls: Number.isFinite(maxLlm) ? maxLlm : 50,
  });

  const byAngle = new Map<string, number>();
  for (const p of prospects) {
    byAngle.set(p.angle.id, (byAngle.get(p.angle.id) ?? 0) + 1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "..", "data");
  await mkdir(outDir, { recursive: true });

  const slug = location.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const outPath = join(outDir, `${slug}.csv`);
  await writeFile(outPath, toCsv(prospects), "utf8");

  const noBooking = prospects.filter((p) => !p.detection.hasOnlineBooking);
  const hot = prospects.filter((p) => p.score >= 60);

  const advertising = prospects.filter((p) => p.ads.hasConversionTracking);
  const hiringNow = prospects.filter(
    (p) => p.hiring.postings.length > 0 && !p.hiring.isStale,
  );

  console.log(`\nWrote ${prospects.length} prospects → ${outPath}`);
  console.log(`  ${noBooking.length} with no self-serve booking`);
  console.log(`  ${advertising.length} running conversion-tracked ads`);
  console.log(`  ${hiringNow.length} hiring a front desk right now`);
  console.log(`  ${hot.length} scoring 60+\n`);

  console.log("Lead angle to open with:");
  for (const [angle, n] of [...byAngle].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${angle}`);
  }
  console.log();

  console.log("Signals this run did NOT cover:");
  for (const signal of UNCOVERED_SIGNALS) console.log(`  · ${signal}`);
  console.log(
    "\nKnown blind spot: clinics booking via a Linktree in their Instagram bio " +
      "read as 'no booking' in both stages. Accepted for a demand test.",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
