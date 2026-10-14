/**
 * When each key was last rotated, as the owner recorded it on /admin/map.
 *
 * No vendor tells us when a key was last changed in a way this app can read
 * (Vercel would need a token of its own, Parameter Store a new role on the
 * host), so the date is the owner's: the "I rotated it today" button appends
 * a row to the marketing Sheet's `key_rotations` tab, and the newest row for
 * a key is its last rotation. The map counts the suggested days from there.
 *
 * What a row holds is the key's id in the map's registry, a timestamp and the
 * operator's address: no value, no fingerprint, nothing that could help
 * anyone guess a key. Rows are appended and never edited, so a mistaken
 * press is undone by pressing again on the right day, not by rewriting
 * history; the Sheet is kept in the company's Drive like every other tab.
 *
 * Server-side only: it holds the Sheet's service account through
 * lib/sheets/client.
 */

import { randomUUID } from "node:crypto";

import { isMarketingStoreConfigured, sheetsClient } from "@/lib/sheets/client";
import { dataRange, ensureSheetSchema, KEY_ROTATIONS, recordToRow, rowToRecord, type KeyRotationRow } from "@/lib/sheets/schema";

import { KEYS } from "./system-map";

/** Only the registry's ids may be written, so a row always names a real key. */
const KNOWN = new Set(KEYS.filter((key) => key.rotation.kind === "every").map((key) => key.id));

export type RotationLog = { ok: true; last: Record<string, Date> } | { ok: false; reason: string };

/** The newest recorded rotation per key id. */
export async function readRotations(): Promise<RotationLog> {
  if (!isMarketingStoreConfigured()) return { ok: false, reason: "The marketing Sheet is not configured." };
  try {
    const client = sheetsClient();
    await ensureSheetSchema(client);
    const rows = await client.getValues(dataRange(KEY_ROTATIONS));
    const last: Record<string, Date> = {};
    for (const cells of rows) {
      const row = rowToRecord(KEY_ROTATIONS, cells) as Partial<KeyRotationRow>;
      const at = row.rotatedAt;
      if (!row.keyId || !(at instanceof Date) || Number.isNaN(at.getTime())) continue;
      const previous = last[row.keyId];
      if (!previous || previous.getTime() < at.getTime()) last[row.keyId] = at;
    }
    return { ok: true, last };
  } catch (error) {
    console.error("[healdesk] key rotations: could not read the log", error instanceof Error ? error.name : "error");
    return { ok: false, reason: "The rotation log in the marketing Sheet could not be read." };
  }
}

export type RecordOutcome = { ok: true; on: string } | { ok: false; message: string };

/** Append "rotated today" for one key. */
export async function recordRotation(keyId: string, recordedBy: string, now: Date = new Date()): Promise<RecordOutcome> {
  if (!KNOWN.has(keyId)) return { ok: false, message: "That key has no rotation schedule to record against." };
  if (!isMarketingStoreConfigured()) {
    return { ok: false, message: "The marketing Sheet is not configured, so there is nowhere to record it." };
  }
  try {
    const client = sheetsClient();
    await ensureSheetSchema(client);
    const row: KeyRotationRow = { id: randomUUID(), keyId, rotatedAt: now, recordedBy };
    await client.appendRows(KEY_ROTATIONS.title, [recordToRow(KEY_ROTATIONS, row)]);
    return { ok: true, on: now.toISOString().slice(0, 10) };
  } catch (error) {
    console.error("[healdesk] key rotations: could not record", error instanceof Error ? error.name : "error");
    return { ok: false, message: "The Sheet did not take the row. Nothing was recorded; try again." };
  }
}
