import { createHash } from "node:crypto";

import { isSafeTypedText, renderAgreementCopy } from "@healdesk/catalog";
import { renderAgreementPdf } from "@healdesk/catalog/agreement-pdf";
import { agreementPdfRecordOf, type AgreementRecord } from "@healdesk/catalog/checkout-record";

import { recordAgreementCopy } from "@/lib/checkout/records";
import { normalizeEmail } from "@/lib/leads";
import { isOverLimit, rateLimit } from "@/lib/rate-limit";

import { emailKey, sendSafely } from "./index";

/**
 * The signer's copy of the agreement, mailed at signature (owner, 14 October
 * 2026; docs/design/checkout-records-on-vercel-2026-10-14.md).
 *
 * apps/app used to send it, through SES, the moment it wrote the acceptance.
 * The signature is taken here now, so a buyer can sign while the AWS host is
 * in standby, and so is the copy: the same PDF (the catalog's renderer, which
 * apps/app uses for a resend and the portal's download), the same words (the
 * catalog's `renderAgreementCopy`), through this site's one Resend sender.
 * Resend is right for it: the file is a business contract naming a practice
 * and its signatory, business contact data with nothing about a patient.
 *
 * A file, not a link: a link needs an endpoint and the endpoint a credential,
 * and the only thing a pre-payment signer holds is the address they typed.
 * The acceptance id is not in the message, for the same reason.
 *
 * ## Evidence, written once
 *
 * When the provider has taken it, the time and the SHA-256 of the PDF file go
 * onto the agreement's record, once (lib/checkout/records.ts,
 * recordAgreementCopy), and apps/app imports them as `copy_sent_at` and
 * `copy_document_sha256`. The file's digest is the question a dispute asks,
 * what does the clinic actually hold; the renderer is deterministic, so the
 * same record renders the same bytes on either side.
 *
 * ## An address nobody confirmed (Annex X5, P6)
 *
 * In pilot mode a setup link binds the signer's address: it is the one we
 * sent the link to, and the copy goes there freely. Anywhere else (public
 * mode, or a personalised demo's invitation, which binds no address by the
 * owner's decision of 7 October 2026) the address is whatever was typed, so
 * the copy is a way to have healdesk's sender mail a stranger. Two rules hold
 * it, both from P6:
 *
 *   - at most one copy per address per day, counted in the marketing Sheet
 *     (`agreement-copy:` in lib/rate-limit.ts SHARED_KEY_PREFIXES), so warm
 *     instances share the count. Peeked before the send and spent only on a
 *     send that went, so a copy the provider refused does not use up the day;
 *   - the typed text it carries, the practice's legal name, the signer's
 *     name and title (in the body and in the PDF), restricted to the safe
 *     characters of the catalog's isSafeTypedText: a name, never a link, an
 *     address or a number to call.
 *
 * A copy either rule holds back is `withheld`, never failed: the signature
 * stands, the buyer is told why in a sentence, and the record shows the copy
 * is still owed, so a person sends it.
 */

/** Whether the signer's address is one we confirmed (pilot mode's setup link). */
export type CopyOptions = { addressConfirmed: boolean };

/** One copy per unconfirmed address per day (P6). */
const COPY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The shared counter's key: a digest of the address, never the address. */
function copyLimitKey(address: string): string {
  return `agreement-copy:${createHash("sha256").update(normalizeEmail(address)).digest("hex").slice(0, 32)}`;
}

/** Whether every typed field the copy carries is safe to mail to an address nobody confirmed. */
export function copyTextIsSafe(record: AgreementRecord): boolean {
  const legalName = (record.variables as { clinicLegalName?: unknown }).clinicLegalName;
  return (
    isSafeTypedText(legalName, 200) &&
    isSafeTypedText(record.signatoryName, 120) &&
    (record.signatoryTitle === null || record.signatoryTitle.trim() === "" || isSafeTypedText(record.signatoryTitle, 120))
  );
}

/** How long signing waits for the copy before answering the buyer anyway. */
export const COPY_BUDGET_MS = 8_000;

export type CopyOutcome =
  | { status: "sent"; pdfSha256: string }
  /** Held back by P6's rules for an unconfirmed address: not an error, and still owed. */
  | { status: "withheld"; reason: "already_sent_today" | "unsafe_text" }
  | { status: "skipped" | "failed"; reason: string };

/** What the buyer is told: a status and a sentence written here, never the provider's own words. */
export type CopyReport = { status: "sent" } | { status: "not_sent"; reason: string };

export function copyReport(outcome: CopyOutcome): CopyReport {
  switch (outcome.status) {
    case "sent":
      return { status: "sent" };
    // Nothing was attempted: the transport is not configured. That is ours,
    // not their address, and the sentence must not send them hunting.
    case "skipped":
      return {
        status: "not_sent",
        reason: "We are not able to email copies at the moment, so yours has not been sent.",
      };
    // Attempted and not delivered, which includes a send still running when
    // signing had to answer: "has not been sent" is true of that one too.
    case "failed":
      return { status: "not_sent", reason: "We tried to email your copy and it did not go out." };
    case "withheld":
      return {
        status: "not_sent",
        reason:
          outcome.reason === "already_sent_today"
            ? "A copy of an agreement already went to this address today, so we have not emailed another."
            : "We email a copy to an address we haven't confirmed only when the names on it are letters, numbers and ordinary punctuation, so yours has not been sent.",
      };
  }
}

/**
 * Render the PDF from the record and the text re-rendered from it, mail it,
 * and record the evidence. Never throws: by the time this runs the signature
 * is recorded, and a throw would tell the buyer it was not.
 */
export async function deliverAgreementCopy(
  record: AgreementRecord,
  text: string,
  options: CopyOptions = { addressConfirmed: false },
): Promise<CopyOutcome> {
  const limitKey = options.addressConfirmed ? null : copyLimitKey(record.signatoryEmail);
  if (!options.addressConfirmed) {
    if (!copyTextIsSafe(record)) {
      console.warn("[healdesk] signed copy withheld: unsafe typed text", { agreementId: record.id });
      return { status: "withheld", reason: "unsafe_text" };
    }
    if (limitKey && (await isOverLimit(limitKey, 1))) {
      console.warn("[healdesk] signed copy withheld: one already went to this address today", { agreementId: record.id });
      return { status: "withheld", reason: "already_sent_today" };
    }
  }
  try {
    const pdf = await renderAgreementPdf(agreementPdfRecordOf(record, text));
    const clinicName =
      String((record.variables as { clinicLegalName?: unknown }).clinicLegalName ?? "").trim() || "your practice";
    const words = renderAgreementCopy({
      signatoryName: record.signatoryName,
      clinicName,
      version: record.documentVersion,
      documentHash: record.documentHash,
      acceptedAt: new Date(record.acceptedAt),
    });
    const result = await sendSafely({
      to: record.signatoryEmail,
      subject: words.subject,
      text: words.text,
      html: words.html,
      attachments: [{ filename: pdf.filename, content: pdf.bytes }],
      tag: "agreement-copy",
      // Keyed by the acceptance, never the address: one copy per signature,
      // however often this is retried within the provider's day.
      idempotencyKey: emailKey("agreement-copy", record.id),
    });
    if (result.status !== "sent") {
      // The id finds the record; never the address, never the provider's words.
      console.warn("[healdesk] signed copy not sent", { agreementId: record.id, status: result.status });
      return { status: result.status, reason: result.reason };
    }
    // The day's one copy to this address is spent only by a copy that went.
    if (limitKey) await rateLimit(limitKey, 1, COPY_WINDOW_MS).catch(() => undefined);
    try {
      const written = await recordAgreementCopy(record.id, {
        sentAt: new Date().toISOString(),
        pdfSha256: pdf.sha256,
      });
      if (written === "missing") {
        console.error("[healdesk] signed copy sent, but its record could not be found to note it", { agreementId: record.id });
      }
    } catch (error) {
      console.error("[healdesk] signed copy sent, but the evidence was not written", {
        agreementId: record.id,
        error: error instanceof Error ? error.name : "unknown error",
      });
    }
    return { status: "sent", pdfSha256: pdf.sha256 };
  } catch (error) {
    console.error("[healdesk] signed copy could not be prepared", {
      agreementId: record.id,
      error: error instanceof Error ? error.name : "unknown error",
    });
    return { status: "failed", reason: error instanceof Error ? error.message : "unknown error" };
  }
}

/**
 * `deliverAgreementCopy`, with a deadline. The attempt is not cancelled: if it
 * finishes later it still records its evidence, and `keepAlive` (Next's
 * `after`) holds the function open for it. What the caller gets is the
 * honest answer to "had it gone by the time we had to reply".
 */
export async function deliverAgreementCopyWithin(
  budgetMs: number,
  record: AgreementRecord,
  text: string,
  keepAlive: (pending: Promise<unknown>) => void = () => {},
  options: CopyOptions = { addressConfirmed: false },
): Promise<CopyOutcome> {
  const attempt = deliverAgreementCopy(record, text, options);
  keepAlive(attempt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<CopyOutcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: "failed",
          reason: `The signer's copy had not been sent after ${Math.round(budgetMs / 1000)} seconds.`,
        }),
      budgetMs,
    );
  });
  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
