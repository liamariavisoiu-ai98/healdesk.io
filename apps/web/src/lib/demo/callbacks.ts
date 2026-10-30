import { randomUUID } from "node:crypto";

import { DEMO_CALLBACK_OFFER } from "@healdesk/catalog";

import { deleteRows, findLeadByEmail, recordCallConsent, recordLeadEvent } from "@/lib/leads";
import { POLICY } from "@/lib/legal";
import { isMarketingStoreConfigured, sheetsClient, type Cell, type SheetsClient } from "@/lib/sheets/client";
import { DEMO_CALLBACKS, dataRange, ensureSheetSchema, recordToRow, rowToRecord, type DemoCallbackRow } from "@/lib/sheets/schema";

/**
 * Call backs asked for on demo calls (owner, 26 October 2026: "Lead capture
 * yes do it"; docs/design/demo-lead-capture-2026-10-25.md), in the marketing
 * Sheet's `demo_callbacks` tab.
 *
 * apps/app's demo call sends one signed request when a hesitant clinic owner
 * gives Aya a number to be called on (app/api/voice-demo/callback-request).
 * Business contact data, like every tab here: the owner's own number for
 * their business, their first name, the clinic and one line about what they
 * want to talk about. The row is the team's queue (/admin/queues, "Demo call
 * backs"): marking it called deletes it, and the daily purge deletes any
 * left after POLICY.demoCallbackRetentionDays, which is what the Privacy page
 * promises. The demo's lead keeps a `callback_requested` event, which holds
 * no number, and the call-consent tab keeps the words the owner said yes to,
 * as it does for the demo's own call.
 */

type Located = { row: number; value: DemoCallbackRow };

/** A second request for the same number on the same demo within this long is the same request. */
const REPEAT_WINDOW_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

async function store(): Promise<SheetsClient> {
  const client = sheetsClient();
  await ensureSheetSchema(client);
  return client;
}

async function readAll(client: SheetsClient): Promise<Located[]> {
  const rows = await client.getValues(dataRange(DEMO_CALLBACKS));
  const out: Located[] = [];
  rows.forEach((cells: readonly Cell[], i) => {
    if (cells.every((cell) => cell === "" || cell === undefined)) return;
    const value = rowToRecord(DEMO_CALLBACKS, cells) as DemoCallbackRow;
    if (value.id && value.phoneE164 && value.requestedAt instanceof Date) out.push({ row: i + 2, value: { ...value, test: value.test === true } });
  });
  return out;
}

export type NewDemoCallback = Omit<DemoCallbackRow, "id" | "requestedAt"> & {
  /** The demo's requester's address, from its row, so the lead gets its event and the consent its link. */
  leadEmail: string | null;
  /**
   * The words they said yes to, when not Aya's offer on a demo call: the
   * demo page's own call-back form (app/api/demo/[slug]/callback).
   */
  consent?: { version: string; text: string };
};

export type RecordCallbackResult =
  | { ok: true; callback: DemoCallbackRow; repeat: boolean }
  | { ok: false; reason: "unconfigured" | "unavailable" };

/**
 * Keep a call back, once: the same number for the same demo within an hour
 * is the request already kept (apps/app may send it again after a cut-off
 * reply). Never throws.
 */
export async function recordDemoCallback(input: NewDemoCallback, now: Date = new Date()): Promise<RecordCallbackResult> {
  if (!isMarketingStoreConfigured()) return { ok: false, reason: "unconfigured" };
  try {
    const client = await store();
    const existing = (await readAll(client)).find(
      (r) => r.value.slug === input.slug && r.value.phoneE164 === input.phoneE164 && now.getTime() - r.value.requestedAt.getTime() < REPEAT_WINDOW_MS,
    );
    if (existing) return { ok: true, callback: existing.value, repeat: true };
    const callback: DemoCallbackRow = {
      id: randomUUID(),
      slug: input.slug,
      clinicName: input.clinicName,
      firstName: input.firstName,
      phoneE164: input.phoneE164,
      topic: input.topic,
      test: input.test,
      offerEndsAt: input.offerEndsAt,
      requestedAt: now,
    };
    await client.appendRows(DEMO_CALLBACKS.title, [recordToRow(DEMO_CALLBACKS, callback)]);
    // The words they said yes to, kept as the demo call's own consent is.
    await recordCallConsent({
      phoneE164: input.phoneE164,
      consentVersion: input.consent?.version ?? `demo-callback-${DEMO_CALLBACK_OFFER.version}`,
      consentText:
        input.consent?.text ??
        `Asked by Aya on a demo call: "${DEMO_CALLBACK_OFFER.text}" They gave this number and confirmed it when she read it back.`,
      leadEmail: input.leadEmail,
    });
    if (input.leadEmail) {
      const lead = await findLeadByEmail(input.leadEmail);
      if (lead) await recordLeadEvent(lead.id, "callback_requested", { slug: input.slug, test: input.test });
    }
    return { ok: true, callback, repeat: false };
  } catch (error) {
    console.error("[healdesk] demo call back not kept", { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, reason: "unavailable" };
  }
}

/** Every call back still waiting, oldest first: the order to ring them in. */
export async function listDemoCallbacks(): Promise<DemoCallbackRow[]> {
  if (!isMarketingStoreConfigured()) return [];
  const all = await readAll(await store());
  return all.map((r) => r.value).sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
}

/** The call was made: the row, number and line, are deleted. False when it is already gone. */
export async function markDemoCallbackCalled(id: string): Promise<boolean> {
  if (!isMarketingStoreConfigured()) return false;
  const client = await store();
  const found = (await readAll(client)).find((r) => r.value.id === id);
  if (!found) return false;
  await deleteRows(client, DEMO_CALLBACKS, [found.row]);
  return true;
}

/** Call backs older than `days`, deleted whether or not anyone called (the Privacy page, section 6). */
export async function purgeStaleDemoCallbacks(days: number = POLICY.demoCallbackRetentionDays, now: Date = new Date()): Promise<number> {
  if (!isMarketingStoreConfigured()) return 0;
  const client = await store();
  const stale = (await readAll(client)).filter((r) => now.getTime() - r.value.requestedAt.getTime() >= days * DAY_MS);
  await deleteRows(client, DEMO_CALLBACKS, stale.map((r) => r.row));
  return stale.length;
}
