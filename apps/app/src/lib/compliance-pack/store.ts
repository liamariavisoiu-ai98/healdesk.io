import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";

import type { CompliancePack, Headline } from "./build";

/**
 * compliance_packs (drizzle/0123): one row per week, written once. Raw SQL
 * on purpose, so this module needs nothing from db/schema.ts beyond the
 * table's name. The table's triggers refuse every UPDATE, DELETE and
 * TRUNCATE; this file only reads and inserts.
 */

/** JSON with every object's keys sorted, arrays in order: the text the hash is taken over. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** SHA-256 of the canonical JSON, in hex. The same for the stored jsonb read back. */
export function packHash(pack: unknown): string {
  return createHash("sha256").update(canonicalJson(pack), "utf8").digest("hex");
}

export type StoredPack = {
  id: string;
  weekStart: string;
  generatedAt: string;
  generatedBy: string;
  payloadHash: string;
  payload: CompliancePack;
};

export type PackSummary = Omit<StoredPack, "payload"> & { headline: Headline | null };

type Row = {
  id: string;
  week_start: string;
  generated_at: Date | string;
  generated_by: string;
  payload_hash: string;
  payload?: CompliancePack;
  headline?: Headline | null;
};

function summary(row: Row): Omit<StoredPack, "payload"> {
  return {
    id: row.id,
    weekStart: row.week_start,
    generatedAt: new Date(row.generated_at).toISOString(),
    generatedBy: row.generated_by,
    payloadHash: row.payload_hash,
  };
}

export async function packExists(weekStart: string): Promise<boolean> {
  const result = await unsafeDb.execute<{ found: boolean }>(
    sql`select exists (select 1 from compliance_packs where week_start = ${weekStart}::date) as found`,
  );
  return result.rows[0]?.found === true;
}

export type InsertOutcome = { status: "stored"; id: string; payloadHash: string } | { status: "exists" };

/** Store a week's pack, once. A week already stored is left as it is and reported. */
export async function insertPack(pack: CompliancePack, generatedBy: string, now: Date): Promise<InsertOutcome> {
  const payloadHash = packHash(pack);
  const result = await unsafeDb.execute<{ id: string }>(sql`
    insert into compliance_packs (week_start, generated_at, payload, payload_hash, generated_by)
    values (${pack.week.start}::date, ${now}, ${JSON.stringify(pack)}::jsonb, ${payloadHash}, ${generatedBy})
    on conflict (week_start) do nothing
    returning id`);
  const id = result.rows[0]?.id;
  return id ? { status: "stored", id, payloadHash } : { status: "exists" };
}

export async function getPack(weekStart: string): Promise<StoredPack | null> {
  const result = await unsafeDb.execute<Row>(sql`
    select id, week_start::text as week_start, generated_at, generated_by, payload_hash, payload
      from compliance_packs where week_start = ${weekStart}::date`);
  const row = result.rows[0];
  return row ? { ...summary(row), payload: row.payload! } : null;
}

/** The newest packs first, each with its five headline numbers. */
export async function listPacks(limit: number): Promise<PackSummary[]> {
  const result = await unsafeDb.execute<Row>(sql`
    select id, week_start::text as week_start, generated_at, generated_by, payload_hash,
           payload -> 'headline' as headline
      from compliance_packs order by week_start desc limit ${limit}`);
  return result.rows.map((row) => ({ ...summary(row), headline: row.headline ?? null }));
}
