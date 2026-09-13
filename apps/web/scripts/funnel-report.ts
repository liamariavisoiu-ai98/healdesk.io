import { Pool } from "pg";

/**
 * The stage-to-stage funnel, from lead_events, as one command:
 *
 *   MARKETING_DATABASE_URL=... npx tsx scripts/funnel-report.ts [--since 2026-09-01] [--campaign dental-q4]
 *
 * Counts DISTINCT leads per stage, in funnel order, and prints the drop
 * between adjacent stages. Grouped by source campaign when --by-campaign
 * is passed, so "which niche and which opener actually pay" is a table,
 * not a dashboard nobody opens. Reads ids and enum names only.
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
  const url = process.env.MARKETING_DATABASE_URL;
  if (!url) throw new Error("MARKETING_DATABASE_URL is not set.");
  const since = arg("since") ?? "1970-01-01";
  const campaign = arg("campaign");
  const byCampaign = process.argv.includes("--by-campaign");
  const pool = new Pool({ connectionString: url, max: 2 });

  try {
    const groupExpr = byCampaign ? "coalesce(l.source_campaign, '(organic)')" : "'all'";
    const { rows } = await pool.query<{ grp: string; name: string; leads: number }>(
      `select ${groupExpr} as grp, e.name, count(distinct e.lead_id)::int as leads
         from lead_events e
         join leads l on l.id = e.lead_id
        where e.at >= $1::timestamptz
          and ($2::text is null or l.source_campaign = $2)
          and e.name = any($3::text[])
        group by 1, 2`,
      [since, campaign ?? null, [...STAGES]],
    );
    const groups = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const g = groups.get(r.grp) ?? new Map<string, number>();
      g.set(r.name, r.leads);
      groups.set(r.grp, g);
    }
    for (const [grp, counts] of [...groups.entries()].sort()) {
      console.log(`\n${grp}`);
      console.log("stage".padEnd(20), "leads".padStart(7), "step %".padStart(8));
      let prev: number | null = null;
      for (const stage of STAGES) {
        const n = counts.get(stage) ?? 0;
        const pct = prev && prev > 0 ? `${Math.round((n / prev) * 100)}%` : "—";
        console.log(stage.padEnd(20), String(n).padStart(7), pct.padStart(8));
        prev = n;
      }
    }
    const mrr = await pool.query<{ customers: number; mrr: number }>(
      `select count(*)::int as customers, coalesce(sum(converted_mrr_usd), 0)::int as mrr
         from leads where converted_at is not null and converted_at >= $1::timestamptz
          and ($2::text is null or source_campaign = $2)`,
      [since, campaign ?? null],
    );
    console.log(`\ncustomers: ${mrr.rows[0]!.customers}   MRR: $${mrr.rows[0]!.mrr}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
