import {
  acceptanceVariables,
  checkAgreementRecord,
  checkIntentRecord,
  openSealedRecord,
  type AgreementRecord,
} from "@healdesk/catalog/checkout-record";
import { eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { baaAcceptances } from "@/db/schema";
import { COPY_SENT_EVENT, COPY_SHA256_KEY } from "@/lib/agreements";
import { recordSecurityEvent } from "@/lib/audit";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

import { checkIntentAgreement, findIntent, importIntent, IntentError } from "./intents";

/**
 * Taking in the checkout records apps/web kept while this host could not:
 * the signed agreement and the purchase, when the purchase's first invoice is
 * paid (owner, 14 October 2026; docs/design/checkout-records-on-vercel-2026-10-14.md).
 *
 * Until that day apps/app wrote both rows itself, the acceptance when the
 * buyer signed and the intent when they pressed Pay. Now apps/web writes them
 * as sealed records in the marketing Sheet, so a buyer can sign and pay while
 * this host is in standby, and the invoice.paid relay brings them here in the
 * /api/provision body. This module turns them back into the two rows
 * provisioning has always read, and then provisioning runs unchanged:
 *
 *   - `baa_acceptances`, with the record's own id and accepted-at (the
 *     column-scoped INSERT grant of drizzle/0066 lets the runtime role write
 *     both for exactly this), the text re-rendered from the recorded template
 *     and variables and checked against the recorded hash, the variables as
 *     a signature taken here would have stored them, the `baa_accepted`
 *     security event with the original time in its metadata, and the copy
 *     evidence (write-once, as drizzle/0025 requires) with its
 *     `baa_copy_sent` event, so listCopyDeliveries finds the first delivery;
 *   - `checkout_intents`, with the record's ref, attempt, nonce, Checkout
 *     Session, creation and expiry (intents.ts, importIntent).
 *
 * ## Trust
 *
 * The records crossed a spreadsheet. Each is sealed by apps/web with an HMAC
 * keyed from HEALDESK_PROVISION_SECRET, which this host also holds, and is
 * opened only if the seal is good (packages/catalog/src/checkout-record.ts);
 * the agreement's text is never taken from anywhere, it is rendered again and
 * must hash to what was signed; and the purchase is held again to
 * provisioning's rules (validateIntentRequest) and to the agreement it names
 * (checkIntentAgreement). A refusal is a paid order with no account: it is
 * answered 422, ops are told, and, once the purchase itself is known to be
 * ours, the intent is marked failed so /welcome stops waiting and the buyer
 * gets the "order delayed" email once (the provision route's refuseIntent).
 *
 * ## Idempotent
 *
 * Stripe redelivers for three days. Every insert is `on conflict do nothing`
 * on the record's own id or ref, so a retried event finds both rows and
 * continues; an intent already consumed is not looked at again at all, which
 * is what lets the replay reach provisionClinic's own idempotency.
 */

/** Why the records were refused, and whether the purchase is known well enough to mark it failed. */
export type ImportRefusal = {
  ok: false;
  message: string;
  field: string;
  /**
   * `intent`: the purchase record is ours and was imported, so it can be
   * marked failed and its buyer written to. `ops`: not even that much is
   * known, so only ops can act.
   */
  reach: "intent" | "ops";
};

export type ImportOutcome = { ok: true; intent: "imported" | "present"; agreement: "imported" | "present" | "skipped" } | ImportRefusal;

/** The records as the relay carries them: each `{ json, seal }`. */
export type CheckoutRecords = { intent?: unknown; agreement?: unknown };

export function checkoutRecordsOf(body: unknown): CheckoutRecords | null {
  const records = (body as { records?: unknown } | null)?.records;
  return records && typeof records === "object" && !Array.isArray(records) ? (records as CheckoutRecords) : null;
}

export async function importCheckoutRecords(ref: string, records: CheckoutRecords): Promise<ImportOutcome> {
  const secret = env.provisionSecret();
  const refuse = (reach: ImportRefusal["reach"], message: string, field = "records"): ImportRefusal => ({
    ok: false,
    message,
    field,
    reach,
  });
  if (!secret) return refuse("ops", "Checkout records cannot be opened without HEALDESK_PROVISION_SECRET.");

  // 1. The purchase. Nothing in it is read before its seal is checked.
  const opened = openSealedRecord(records.intent, secret);
  if (opened === null) {
    log.warn("checkout import: the purchase record's seal does not match", { outcome: "refused" });
    return refuse("ops", "The purchase record's seal does not match.");
  }
  const purchase = checkIntentRecord(opened);
  if (!purchase.ok) {
    log.warn("checkout import: the purchase record was refused", { outcome: purchase.problem, field: purchase.field ?? null });
    return refuse("ops", `The purchase record was refused: ${purchase.detail}`, purchase.field ?? "records");
  }
  if (purchase.record.ref !== ref) {
    return refuse("ops", "The purchase record is not the purchase the payment names.", "ref");
  }

  const existing = await findIntent(ref);
  if (existing?.consumedAt) {
    // Already provisioned: the replay is provisionClinic's to answer, and the
    // agreement is bound, so nothing here is asked again.
    return { ok: true, intent: "present", agreement: "skipped" };
  }
  const intent = existing ? "present" : await importIntent(purchase.record, purchase.intent);

  // 2. The agreement the purchase names. From here a refusal marks the
  // purchase failed, which is now a row this host holds.
  const signed = openSealedRecord(records.agreement, secret);
  if (signed === null) {
    log.warn("checkout import: the agreement record's seal does not match", { outcome: "refused" });
    return refuse("intent", "The agreement record's seal does not match.", "agreementId");
  }
  const checked = checkAgreementRecord(signed);
  if (!checked.ok) {
    log.warn("checkout import: the agreement record was refused", { outcome: checked.problem });
    return refuse("intent", `The agreement record was refused (${checked.problem}).`, "agreementId");
  }
  if (checked.record.id !== purchase.intent.agreementId) {
    return refuse("intent", "The agreement record is not the agreement the purchase names.", "agreementId");
  }

  let agreement: "imported" | "present";
  try {
    agreement = await importAgreement(checked.record, checked.text);
  } catch (error) {
    if (error instanceof ImportConflict) return refuse("intent", error.message, "agreementId");
    throw error;
  }

  // 3. The purchase and the agreement, against each other, as the intent
  // route asked before payment until 14 October 2026.
  try {
    await checkIntentAgreement(purchase.intent);
  } catch (error) {
    if (error instanceof IntentError) return refuse("intent", error.message, error.field ?? "agreementId");
    throw error;
  }

  // Never the ref: it opens /welcome. The agreement's id finds both rows.
  log.info("checkout records imported", { agreementId: checked.record.id, outcome: `intent ${intent}, agreement ${agreement}` });
  return { ok: true, intent, agreement };
}

class ImportConflict extends Error {}

/**
 * The acceptance row, as a signature taken here would have written it, with
 * the record's own id and time. One transaction, so the row never exists
 * without its `baa_accepted` event or its copy evidence.
 */
async function importAgreement(record: AgreementRecord, text: string): Promise<"imported" | "present"> {
  return unsafeDb.transaction(async (tx) => {
    // Raw SQL naming only the columns it writes, as signAgreement does: the
    // runtime role may insert no organization_id, bound_at, terminated_at or
    // termination_reason (drizzle/0066). Unbound until provisioning binds it.
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into baa_acceptances
        (id, user_id, document_version, document_hash, rendered_text, variables, assent_label,
         accepted_by_name, accepted_by_email, accepted_by_title, ip_address, user_agent, accepted_at)
      values
        (${record.id}::uuid, null, ${record.documentVersion}, ${record.documentHash}, ${text},
         ${JSON.stringify(acceptanceVariables(record))}::jsonb, ${record.assentLabel},
         ${record.signatoryName}, ${record.signatoryEmail}, ${record.signatoryTitle},
         ${record.ipAddress}, ${record.userAgent}, ${record.acceptedAt}::timestamptz)
      on conflict (id) do nothing
      returning id`);

    if (inserted.rows.length === 0) {
      // Imported before (a retried event). It must be this signature: the
      // same document, signer and instant. Anything else under this id is
      // not a retry, and nothing is bound to it.
      const [row] = await tx
        .select({
          documentHash: baaAcceptances.documentHash,
          email: baaAcceptances.acceptedByEmail,
          acceptedAt: baaAcceptances.acceptedAt,
        })
        .from(baaAcceptances)
        .where(eq(baaAcceptances.id, record.id))
        .limit(1);
      if (
        !row ||
        row.documentHash !== record.documentHash ||
        row.email !== record.signatoryEmail ||
        row.acceptedAt.getTime() !== new Date(record.acceptedAt).getTime()
      ) {
        throw new ImportConflict("A different agreement is already recorded under this agreement's id.");
      }
      return "present";
    }

    const acceptedAt = new Date(record.acceptedAt);
    await recordSecurityEvent(tx, {
      event: "baa_accepted",
      actorLabel: record.signatoryEmail,
      organizationId: null,
      ipAddress: record.ipAddress,
      userAgent: record.userAgent,
      metadata: {
        agreementId: record.id,
        version: record.documentVersion,
        hash: record.documentHash,
        approvedByCounsel: record.approvedByCounsel,
        // The instant of the signature, which occurred_at (the import's own
        // time) is not. A number, because the audit guard reads a written-out
        // date as a phone number.
        acceptedAtEpochMs: acceptedAt.getTime(),
        recordedBy: "apps/web",
      },
    });

    if (record.copy) {
      await tx.execute(sql`
        update baa_acceptances
           set copy_sent_at = ${record.copy.sentAt}::timestamptz,
               copy_document_sha256 = ${record.copy.pdfSha256}
         where id = ${record.id}::uuid and copy_sent_at is null`);
      await recordSecurityEvent(tx, {
        event: COPY_SENT_EVENT,
        actorLabel: record.signatoryEmail,
        ipAddress: record.ipAddress,
        userAgent: record.userAgent,
        metadata: {
          agreementId: record.id,
          delivery: "sent",
          firstCopy: true,
          [COPY_SHA256_KEY]: record.copy.pdfSha256,
          trigger: "signature",
          sentAtEpochMs: new Date(record.copy.sentAt).getTime(),
          recordedBy: "apps/web",
        },
      });
    }
    return "imported";
  });
}
