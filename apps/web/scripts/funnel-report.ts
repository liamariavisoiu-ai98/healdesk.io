import { isMarketingStoreConfigured, sheetsClient } from "../src/lib/sheets/client";
import {
  LEADS,
  LEAD_EVENTS,
  dataRange,
  ensureSheetSchema,
  leadFromRow,
  rowToRecord,
  type LeadEvent,
} from "../src/lib/sheets/schema";

/**
 * The stage-to-stage funnel, from the lead_events tab, as one command:
 *
 *   npm run sheets:init -w @healdesk/web   # once, if the tabs do not exist yet
 *   npx tsx --env-file-if-exists=.env.local scripts/funnel-report.ts [--since 2026-09-01] [--campaign dental-q4] [--by-campaign]
 *
 * Counts DISTINCT leads per stage, in funnel order, and prints the drop
 * between adjacent stages. Grouped by source campaign when --by-campaign
 * is passed, so "which niche and which opener actually pay" is a table,
 * not a dashboard nobody opens. Reads ids and enum names only, and reads
 * the two tabs once each: the join happens here, not in the Sheet.
 */

const STAGES = [
  "demo_unlocked",
  "pricing_viewed",
  "checkout_started",
  "checkout_step",
  "payment_completed",
] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (!isMarketingStoreConfigured()) {
    throw new Error("MARKETING_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON are not both set.");
  }
  const since = new Date(arg("since") ?? "1970-01-01");
  const campaign = arg("campaign");
  const byCampaign = process.argv.includes("--by-campaign");

  const client = sheetsClient();
  await ensureSheetSchema(client);
  const leads = (await client.getValues(dataRange(LEADS))).map(leadFromRow).filter((l) => l.id);
  const events = (await client.getValues(dataRange(LEAD_EVENTS))).map(
    (cells) => rowToRecord(LEAD_EVENTS, cells) as LeadEvent,
  );
  const leadById = new Map(leads.map((l) => [l.id, l]));

  const groups = new Map<string, Map<string, Set<string>>>();
  for (const e of events) {
    if (!(STAGES as readonly string[]).includes(e.name)) continue;
    if (!(e.at instanceof Date) || e.at.getTime() < since.getTime()) continue;
    const lead = leadById.get(e.leadId);
    if (!lead) continue;
    if (campaign && lead.sourceCampaign !== campaign) continue;
    const grp = byCampaign ? (lead.sourceCampaign ?? "(organic)") : "all";
    const stages = groups.get(grp) ?? new Map<string, Set<string>>();
    const ids = stages.get(e.name) ?? new Set<string>();
    ids.add(e.leadId);
    stages.set(e.name, ids);
    groups.set(grp, stages);
  }

  for (const [grp, stages] of [...groups.entries()].sort()) {
    console.log(`\n${grp}`);
    console.log("stage".padEnd(20), "leads".padStart(7), "step %".padStart(8));
    let prev: number | null = null;
    for (const stage of STAGES) {
      const n = stages.get(stage)?.size ?? 0;
      const pct = prev && prev > 0 ? `${Math.round((n / prev) * 100)}%` : "—";
      console.log(stage.padEnd(20), String(n).padStart(7), pct.padStart(8));
      prev = n;
    }
  }

  const customers = leads.filter(
    (l) =>
      l.convertedAt !== null &&
      l.convertedAt.getTime() >= since.getTime() &&
      (!campaign || l.sourceCampaign === campaign),
  );
  const mrr = customers.reduce((sum, l) => sum + (l.convertedMrrUsd ?? 0), 0);
  console.log(`\ncustomers: ${customers.length}   MRR: $${mrr}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
