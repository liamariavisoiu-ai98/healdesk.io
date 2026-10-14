import { createHmac } from "node:crypto";

import {
  checkAgreementRecord,
  checkIntentRecord,
  openSealedRecord,
  packRecordCells,
  RECORD_CELLS,
  sealRecord,
  unpackRecordCells,
  type AgreementRecord,
  type CopyEvidence,
  type IntentRecord,
  type SealedRecord,
} from "@healdesk/catalog/checkout-record";
import type { IntentRequest } from "@healdesk/catalog";

import { columnLetter, isMarketingStoreConfigured, sheetsClient, type Cell, type SheetsClient } from "@/lib/sheets/client";
import {
  AGREEMENT_INDEX_COLUMNS,
  AGREEMENTS,
  CHECKOUT_INTENTS,
  cellRange,
  ensureSheetSchema,
  INTENT_INDEX_COLUMNS,
  RECORD_COLUMNS,
  recordToRow,
  rowRange,
  rowToRecord,
  type AgreementRow,
  type CheckoutIntentRow,
  type Tab,
} from "@/lib/sheets/schema";

/**
 * The checkout records, in the marketing Sheet (owner, 14 October 2026).
 *
 * The signed agreement and the purchase used to be rows apps/app wrote, at
 * signing and at Pay. The AWS host now has a standby mode that removes its
 * database until the first clinic pays, so both are written here instead, as
 * sealed records (@healdesk/catalog/checkout-record), and the Stripe webhook
 * hands them to apps/app's /api/provision when the first invoice is paid,
 * which imports them and provisions as it always has
 * (docs/design/checkout-records-on-vercel-2026-10-14.md). Business contact
 * data only: apps/web still has no database client and holds no PHI.
 *
 * Every read opens the seal and checks the record before anything in it is
 * used, and checks that the index columns a row was found by are the
 * record's own, so a sealed record copied into another row's index finds
 * nothing.
 *
 * ## What a spreadsheet cannot do
 *
 * No transaction, no unique index, no atomic update. Appends are safe (each
 * is its own row); an update rewrites one row by its row number, after
 * checking the row still holds the record it was read from, and loses to a
 * concurrent writer of the same row. The callers are written around that:
 * the agreement's copy evidence is written once, by the signing request that
 * sent it, and a purchase record gains its Checkout Session id only from the
 * press of Pay that made it. What the database guaranteed and this does not
 * is written beside the purchase, in app/api/checkout/route.ts.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/checkout/records is server-side only: it holds HEALDESK_PROVISION_SECRET.");
}

if (RECORD_COLUMNS !== RECORD_CELLS) {
  throw new Error("The Sheet's record columns and the catalog's record cells disagree.");
}

/** The secret the records are sealed with: the one apps/app checks them with. */
function secret(): string | null {
  return process.env.HEALDESK_PROVISION_SECRET || null;
}

/** Whether records can be kept at all: a Sheet to keep them in and a secret to seal them with. */
export function recordsConfigured(): boolean {
  return Boolean(secret()) && isMarketingStoreConfigured();
}

async function store(): Promise<SheetsClient> {
  const client = sheetsClient();
  await ensureSheetSchema(client);
  return client;
}

function requireSecret(): string {
  const value = secret();
  if (!value) throw new Error("HEALDESK_PROVISION_SECRET is required to seal a checkout record.");
  return value;
}

/** The sealed record a row holds, or null when it holds none that opens. */
function sealedOf(tab: Tab, cells: readonly Cell[]): SealedRecord | null {
  const decoded = rowToRecord(tab, cells);
  const parts: unknown[] = [];
  for (let i = 1; i <= RECORD_COLUMNS; i += 1) parts.push(decoded[`record${i}`]);
  const json = unpackRecordCells(parts);
  const seal = typeof decoded.seal === "string" ? decoded.seal : null;
  return json !== null && seal ? { json, seal } : null;
}

function recordCells(sealed: SealedRecord): Record<string, string> {
  const cells = packRecordCells(sealed.json);
  const out: Record<string, string> = { seal: sealed.seal };
  cells.forEach((cell, i) => {
    out[`record${i + 1}`] = cell;
  });
  return out;
}

/** Index rows of a tab: its leading columns only, which is all a lookup needs. */
async function indexRows(client: SheetsClient, tab: Tab, width: number): Promise<{ row: number; cells: Cell[] }[]> {
  const rows = await client.getValues(`${tab.title}!A2:${columnLetter(width)}`);
  const out: { row: number; cells: Cell[] }[] = [];
  rows.forEach((cells, i) => {
    if (cells.some((cell) => cell !== "" && cell !== undefined)) out.push({ row: i + 2, cells });
  });
  return out;
}

async function readRow(client: SheetsClient, tab: Tab, row: number): Promise<Cell[]> {
  const [cells = []] = await client.getValues(rowRange(tab, row));
  return cells;
}

/**
 * The row that holds the record with this id now: `row` if it still does,
 * else wherever the index says it went (a row deleted or sorted by hand
 * moves the rest), else null.
 */
async function rowOf(client: SheetsClient, tab: Tab, row: number, id: string, width: number): Promise<number | null> {
  const [[current] = []] = await client.getValues(cellRange(tab, row, "id"));
  if (String(current ?? "") === id) return row;
  const moved = (await indexRows(client, tab, width)).filter((entry) => String(entry.cells[0] ?? "") === id);
  return moved.length === 1 ? moved[0]!.row : null;
}

/**
 * Rewrite one row, if it still holds the record it was read from. A Sheet has
 * no compare-and-set, so this is a check immediately before the write: it
 * catches a row deleted or sorted by hand in between, not a racing writer.
 */
async function rewriteRow(
  client: SheetsClient,
  tab: Tab,
  row: number,
  id: string,
  values: Record<string, unknown>,
  width: number,
): Promise<boolean> {
  const at = await rowOf(client, tab, row, id, width);
  if (at === null) return false;
  await client.updateRange(rowRange(tab, at), [recordToRow(tab, values)]);
  return true;
}

// -----------------------------------------------------------------------------
// Agreements
// -----------------------------------------------------------------------------

export type StoredAgreement = {
  record: AgreementRecord;
  /** The record exactly as the row holds it, for the relay to carry to apps/app. */
  sealed: SealedRecord;
  /** The document, rendered again from the record and checked against its hash. */
  text: string;
  provisionedAt: Date | null;
  row: number;
};

export type AgreementLookup =
  | ({ status: "found" } & StoredAgreement)
  | { status: "missing" }
  /**
   * A row with this id whose record does not open, or does not re-render to
   * its hash. `sealed` is what the row holds, for the relay to carry anyway,
   * so apps/app is the one that refuses it, tells ops and writes to the buyer.
   */
  | { status: "refused"; problem: string; sealed: SealedRecord | null };

/** Append a signature. Throws when it was not written; the caller tells the buyer nothing was recorded. */
export async function appendAgreementRecord(record: AgreementRecord): Promise<void> {
  const sealed = sealRecord(record, requireSecret());
  const client = await store();
  const row: AgreementRow & Record<string, unknown> = {
    id: record.id,
    documentVersion: record.documentVersion,
    acceptedAt: new Date(record.acceptedAt),
    provisionedAt: null,
    ...recordCells(sealed),
  };
  await client.appendRows(AGREEMENTS.title, [recordToRow(AGREEMENTS, row)]);
}

export async function findAgreementRecord(id: string): Promise<AgreementLookup> {
  const key = requireSecret();
  const client = await store();
  const index = (await indexRows(client, AGREEMENTS, AGREEMENT_INDEX_COLUMNS)).filter(
    (entry) => String(entry.cells[0] ?? "") === id,
  );
  if (index.length === 0) return { status: "missing" };
  // An id is a UUID made at signing, so two rows under one id are a copy made
  // by hand; the first that opens and is this record wins, and the rest are
  // ignored rather than trusted.
  let problem = "seal";
  let firstSealed: SealedRecord | null = null;
  for (const { row } of index) {
    const cells = await readRow(client, AGREEMENTS, row);
    const sealed = sealedOf(AGREEMENTS, cells);
    firstSealed ??= sealed;
    const opened = openSealedRecord(sealed, key);
    if (opened === null || sealed === null) continue;
    const checked = checkAgreementRecord(opened);
    if (!checked.ok) {
      problem = checked.problem;
      continue;
    }
    if (checked.record.id !== id) {
      problem = "index";
      continue;
    }
    const decoded = rowToRecord(AGREEMENTS, cells) as Partial<AgreementRow>;
    return {
      status: "found",
      record: checked.record,
      sealed,
      text: checked.text,
      provisionedAt: decoded.provisionedAt ?? null,
      row,
    };
  }
  return { status: "refused", problem, sealed: firstSealed };
}

/**
 * Write the evidence that the signer's copy went out onto its record, once:
 * a record that already has it keeps the first, because the question it
 * answers is when the counterparty first got their copy.
 */
export async function recordAgreementCopy(id: string, copy: CopyEvidence): Promise<"recorded" | "already" | "missing"> {
  const found = await findAgreementRecord(id);
  if (found.status !== "found") return "missing";
  if (found.record.copy) return "already";
  const record: AgreementRecord = { ...found.record, copy };
  const client = await store();
  const written = await rewriteRow(
    client,
    AGREEMENTS,
    found.row,
    id,
    {
      id: record.id,
      documentVersion: record.documentVersion,
      acceptedAt: new Date(record.acceptedAt),
      provisionedAt: found.provisionedAt,
      ...recordCells(sealRecord(record, requireSecret())),
    },
    AGREEMENT_INDEX_COLUMNS,
  );
  return written ? "recorded" : "missing";
}

/** The agreement belongs to an account now: no later purchase may use it. Never throws. */
export async function markAgreementProvisioned(id: string, at: Date = new Date()): Promise<void> {
  try {
    const client = await store();
    for (const { row, cells } of await indexRows(client, AGREEMENTS, AGREEMENT_INDEX_COLUMNS)) {
      if (String(cells[0] ?? "") !== id || cells[3]) continue;
      await client.updateRange(cellRange(AGREEMENTS, row, "provisioned_at"), [[at.toISOString()]]);
    }
  } catch (error) {
    console.error("[healdesk] could not mark the agreement record provisioned", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// -----------------------------------------------------------------------------
// Purchases
// -----------------------------------------------------------------------------

export type StoredIntent = {
  record: IntentRecord;
  /** The record exactly as the row holds it, for the relay to carry to apps/app. */
  sealed: SealedRecord;
  /** The purchase, held to provisioning's rules again on the way out. */
  intent: IntentRequest;
  withdrawnAt: Date | null;
  provisionedAt: Date | null;
  row: number;
};

function intentRowValues(record: IntentRecord, state: { withdrawnAt: Date | null; provisionedAt: Date | null }, sealed: SealedRecord) {
  const row: CheckoutIntentRow & Record<string, unknown> = {
    id: record.id,
    ref: record.ref,
    attempt: record.attempt,
    inviteRef: (record.intent.inviteRef as string | null | undefined) ?? null,
    agreementId: String(record.intent.agreementId ?? ""),
    createdAt: new Date(record.createdAt),
    withdrawnAt: state.withdrawnAt,
    provisionedAt: state.provisionedAt,
    ...recordCells(sealed),
  };
  return row;
}

/**
 * Append one press of Pay, and return it as stored. Throws when it was not
 * written, and CheckoutRecordError("too_large") when it cannot be.
 */
export async function appendIntentRecord(record: IntentRecord, intent: IntentRequest): Promise<StoredIntent> {
  const sealed = sealRecord(record, requireSecret());
  const client = await store();
  const { firstRow } = await client.appendRows(CHECKOUT_INTENTS.title, [
    recordToRow(CHECKOUT_INTENTS, intentRowValues(record, { withdrawnAt: null, provisionedAt: null }, sealed)),
  ]);
  // The row Google reports, or, when it reports none, wherever the index
  // finds this record's id; rewrites check the row again before they write.
  const row =
    firstRow ??
    (await indexRows(client, CHECKOUT_INTENTS, INTENT_INDEX_COLUMNS)).find(
      (entry) => String(entry.cells[0] ?? "") === record.id,
    )?.row ??
    0;
  return { record, sealed, intent, withdrawnAt: null, provisionedAt: null, row };
}

export type IntentRecords = {
  /** Every record of the purchase that opens and holds, in the order Pay was pressed. */
  records: StoredIntent[];
  /**
   * Rows under this ref whose record did not open or hold: an edit by hand,
   * or a bug. Kept as the row holds them, with the attempt its index claims,
   * for the relay to carry to apps/app, which refuses them and tells ops.
   */
  refused: { row: number; attempt: number | null; sealed: SealedRecord | null }[];
};

/** Every press of Pay for one purchase. */
export async function intentRecordsFor(ref: string): Promise<IntentRecords> {
  const key = requireSecret();
  const client = await store();
  const index = (await indexRows(client, CHECKOUT_INTENTS, INTENT_INDEX_COLUMNS)).filter(
    (entry) => String(entry.cells[1] ?? "") === ref,
  );
  const records: StoredIntent[] = [];
  const refused: IntentRecords["refused"] = [];
  for (const { row } of index) {
    const cells = await readRow(client, CHECKOUT_INTENTS, row);
    const decoded = rowToRecord(CHECKOUT_INTENTS, cells) as Partial<CheckoutIntentRow>;
    const sealed = sealedOf(CHECKOUT_INTENTS, cells);
    const opened = openSealedRecord(sealed, key);
    const checked = opened === null ? null : checkIntentRecord(opened);
    if (!sealed || !checked || !checked.ok || checked.record.ref !== ref || checked.record.id !== decoded.id) {
      refused.push({ row, attempt: typeof decoded.attempt === "number" ? decoded.attempt : null, sealed });
      continue;
    }
    records.push({
      record: checked.record,
      sealed,
      intent: checked.intent,
      withdrawnAt: decoded.withdrawnAt ?? null,
      provisionedAt: decoded.provisionedAt ?? null,
      row,
    });
  }
  // By attempt, then by the order the rows were written: two presses that
  // raced to the same attempt are both kept, the later one last.
  records.sort((a, b) => a.record.attempt - b.record.attempt || a.row - b.row);
  return { records, refused };
}

/**
 * The ref of a purchase no setup link names: public mode, or a buyer an
 * operator invited through a personalised demo. Every press of Pay by the same
 * address on the same signed agreement is one purchase, as every press on one
 * setup link is, so the next press finds the last one's Session and expires it
 * before opening its own (app/api/checkout/route.ts). A fresh ref per press
 * left the Session a buyer cancelled at Stripe payable beside the new one.
 *
 * Keyed on the agreement because the agreement is what the purchase is: the
 * route refuses one signed under another address, and one whose answers no
 * longer match, so the same agreement means the same buyer and the same
 * document. An HMAC under the records' own secret, so nobody can work out a
 * ref from an address and an agreement id, and shaped as a UUID (version 8,
 * RFC 9562's custom kind) because every reader of a ref checks that shape.
 */
export function purchaseRefFor(email: string, agreementId: string): string {
  const hex = createHmac("sha256", requireSecret())
    .update(`purchase-ref:${email.trim().toLowerCase()}:${agreementId.toLowerCase()}`)
    .digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The latest press of Pay that opened a Session, or the latest at all when none has. */
export function latestLive(records: readonly StoredIntent[]): StoredIntent | null {
  const live = records.filter((r) => r.withdrawnAt === null);
  return live[live.length - 1] ?? null;
}

/**
 * Record the Checkout Session a press of Pay opened, on that press's record,
 * resealed. Only once: a record that already names a Session keeps it.
 */
export async function recordIntentSession(stored: StoredIntent, sessionId: string): Promise<boolean> {
  if (stored.record.sessionId !== null) return stored.record.sessionId === sessionId;
  const record: IntentRecord = { ...stored.record, sessionId };
  const client = await store();
  return rewriteRow(
    client,
    CHECKOUT_INTENTS,
    stored.row,
    record.id,
    intentRowValues(record, { withdrawnAt: stored.withdrawnAt, provisionedAt: stored.provisionedAt }, sealRecord(record, requireSecret())),
    INTENT_INDEX_COLUMNS,
  );
}

/**
 * This press of Pay opened no Session anyone can pay (Stripe refused it, the
 * previous press turned out to be paid, or its Session was expired unrecorded):
 * the record stays, as the evidence of the press, and is never provisioned from.
 * Never throws.
 */
export async function withdrawIntentRecord(stored: StoredIntent, at: Date = new Date()): Promise<void> {
  try {
    const client = await store();
    const row = await rowOf(client, CHECKOUT_INTENTS, stored.row, stored.record.id, INTENT_INDEX_COLUMNS);
    if (row === null) return;
    await client.updateRange(cellRange(CHECKOUT_INTENTS, row, "withdrawn_at"), [[at.toISOString()]]);
  } catch (error) {
    console.error("[healdesk] could not withdraw a purchase record", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The purchase is provisioned: every record of it, and the setup link that made it, are spent. Never throws. */
export async function markIntentProvisioned(ref: string, at: Date = new Date()): Promise<void> {
  try {
    const client = await store();
    for (const { row, cells } of await indexRows(client, CHECKOUT_INTENTS, INTENT_INDEX_COLUMNS)) {
      if (String(cells[1] ?? "") !== ref || cells[7]) continue;
      await client.updateRange(cellRange(CHECKOUT_INTENTS, row, "provisioned_at"), [[at.toISOString()]]);
    }
  } catch (error) {
    console.error("[healdesk] could not mark the purchase records provisioned", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Whether an agreement already belongs to an account: its own row says so, or
 * a provisioned purchase names it. Read from the index columns only.
 */
export async function agreementSpent(agreementId: string): Promise<boolean> {
  const client = await store();
  const agreements = await indexRows(client, AGREEMENTS, AGREEMENT_INDEX_COLUMNS);
  if (agreements.some(({ cells }) => String(cells[0] ?? "") === agreementId && Boolean(cells[3]))) return true;
  const intents = await indexRows(client, CHECKOUT_INTENTS, INTENT_INDEX_COLUMNS);
  return intents.some(({ cells }) => String(cells[4] ?? "") === agreementId && Boolean(cells[7]));
}

/** What /admin/setup shows of a purchase: the plan its latest press of Pay chose, and the billing period. */
export type ChosenPackage = { plan: string; billingInterval: string | null };

/**
 * The package each purchase chose, by ref, from the latest press of Pay that
 * opened a Session (or the latest at all when none has), for the setup
 * requests' progress (plan Part A2: "opened · package · signed · paid"). One
 * read of the index, then one row per purchase found; a ref with no press of
 * Pay, or whose record does not open, is simply absent. Plan ids and the
 * billing period only, which /admin already shows of every clinic.
 */
export async function packagesByRef(refs: readonly string[]): Promise<Map<string, ChosenPackage>> {
  const out = new Map<string, ChosenPackage>();
  const wanted = new Set(refs);
  if (wanted.size === 0) return out;
  const key = requireSecret();
  const client = await store();
  const latest = new Map<string, { row: number; attempt: number; live: boolean }>();
  for (const { row, cells } of await indexRows(client, CHECKOUT_INTENTS, INTENT_INDEX_COLUMNS)) {
    const ref = String(cells[1] ?? "");
    if (!wanted.has(ref)) continue;
    const attempt = Number(cells[2] ?? 0) || 0;
    const live = !cells[6];
    const seen = latest.get(ref);
    const better =
      !seen || (live && !seen.live) || (live === seen.live && (attempt > seen.attempt || (attempt === seen.attempt && row > seen.row)));
    if (better) latest.set(ref, { row, attempt, live });
  }
  for (const [ref, { row }] of latest) {
    const sealed = sealedOf(CHECKOUT_INTENTS, await readRow(client, CHECKOUT_INTENTS, row));
    const opened = openSealedRecord(sealed, key);
    const checked = opened === null ? null : checkIntentRecord(opened);
    if (!checked || !checked.ok || checked.record.ref !== ref) continue;
    out.set(ref, { plan: checked.intent.plan, billingInterval: checked.intent.billingInterval ?? null });
  }
  return out;
}
