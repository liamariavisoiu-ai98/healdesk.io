import { randomUUID } from "node:crypto";

import { isMarketingStoreConfigured, sheetsClient } from "@/lib/sheets/client";
import {
  AI_PANEL_RUNS,
  dataRange,
  ensureSheetSchema,
  recordToRow,
  rowToRecord,
  SEO_STEP_TICKS,
  type AiPanelRunRow,
  type SeoStepTickRow,
} from "@/lib/sheets/schema";

import { cleanSources, isEngine, isQuestion, type PanelRun } from "./panel";
import { OWNER_STEPS } from "./steps";

/**
 * /admin/seo's two writes, both append-only rows in the marketing Sheet, the
 * way key_rotations is: a tick or untick of an owner step, and one logged AI
 * panel answer. Server-only (client-imports.test.ts): it holds the Sheet's
 * service account.
 */

const STEP_IDS = new Set(OWNER_STEPS.map((step) => step.id));

export type SeoLog = { ok: true; ticks: Record<string, boolean>; runs: PanelRun[] } | { ok: false; reason: string };

export async function readSeoLog(): Promise<SeoLog> {
  if (!isMarketingStoreConfigured()) return { ok: false, reason: "The marketing Sheet is not configured." };
  try {
    const client = sheetsClient();
    await ensureSheetSchema(client);
    const [tickRows, runRows] = await Promise.all([
      client.getValues(dataRange(SEO_STEP_TICKS)),
      client.getValues(dataRange(AI_PANEL_RUNS)),
    ]);

    const latest: Record<string, { done: boolean; at: number }> = {};
    for (const cells of tickRows) {
      const row = rowToRecord(SEO_STEP_TICKS, cells) as Partial<SeoStepTickRow>;
      const at = row.at instanceof Date ? row.at.getTime() : Number.NaN;
      if (!row.stepId || Number.isNaN(at)) continue;
      const previous = latest[row.stepId];
      if (!previous || previous.at <= at) latest[row.stepId] = { done: row.done === true, at };
    }
    const ticks = Object.fromEntries(Object.entries(latest).map(([id, entry]) => [id, entry.done]));

    const runs: PanelRun[] = [];
    for (const cells of runRows) {
      const row = rowToRecord(AI_PANEL_RUNS, cells) as Partial<AiPanelRunRow>;
      if (!row.ranOn || !isEngine(row.engine) || !isQuestion(row.questionId)) continue;
      runs.push({ ranOn: row.ranOn, engine: row.engine, questionId: row.questionId, named: row.named === true, cited: row.cited === true });
    }
    return { ok: true, ticks, runs };
  } catch (error) {
    console.error("[healdesk] seo log: could not read", error instanceof Error ? error.name : "error");
    return { ok: false, reason: "The SEO tabs in the marketing Sheet could not be read." };
  }
}

export type SeoWriteOutcome = { ok: true } | { ok: false; message: string };

export async function recordStepTick(stepId: string, done: boolean, recordedBy: string, now = new Date()): Promise<SeoWriteOutcome> {
  if (!STEP_IDS.has(stepId)) return { ok: false, message: "That is not a step on the list." };
  if (!isMarketingStoreConfigured()) return { ok: false, message: "The marketing Sheet is not configured, so the tick cannot be kept." };
  try {
    const client = sheetsClient();
    await ensureSheetSchema(client);
    const row: SeoStepTickRow = { id: randomUUID(), stepId, done, at: now, recordedBy };
    await client.appendRows(SEO_STEP_TICKS.title, [recordToRow(SEO_STEP_TICKS, row)]);
    return { ok: true };
  } catch (error) {
    console.error("[healdesk] seo log: could not record a tick", error instanceof Error ? error.name : "error");
    return { ok: false, message: "The Sheet did not take the tick. Nothing was recorded; try again." };
  }
}

export type PanelEntry = { engine: unknown; questionId: unknown; named: unknown; cited: unknown; sources: unknown; ranOn?: unknown };

export async function recordPanelRun(entry: PanelEntry, recordedBy: string, now = new Date()): Promise<SeoWriteOutcome> {
  if (!isEngine(entry.engine)) return { ok: false, message: "Pick an engine from the list." };
  if (!isQuestion(entry.questionId)) return { ok: false, message: "Pick a question from the list." };
  const ranOn =
    typeof entry.ranOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.ranOn) ? entry.ranOn : now.toISOString().slice(0, 10);
  if (!isMarketingStoreConfigured()) return { ok: false, message: "The marketing Sheet is not configured, so the run cannot be kept." };
  try {
    const client = sheetsClient();
    await ensureSheetSchema(client);
    const row: AiPanelRunRow = {
      id: randomUUID(),
      ranOn,
      engine: entry.engine,
      questionId: entry.questionId,
      named: entry.named === true,
      cited: entry.cited === true,
      sources: cleanSources(entry.sources),
      recordedBy,
    };
    await client.appendRows(AI_PANEL_RUNS.title, [recordToRow(AI_PANEL_RUNS, row)]);
    return { ok: true };
  } catch (error) {
    console.error("[healdesk] seo log: could not record a panel run", error instanceof Error ? error.name : "error");
    return { ok: false, message: "The Sheet did not take the run. Nothing was recorded; try again." };
  }
}
