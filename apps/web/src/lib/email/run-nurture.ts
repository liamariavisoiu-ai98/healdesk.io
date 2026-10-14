import { agreementKindOfVersion } from "@healdesk/catalog";

import { checkoutMode } from "@/lib/checkout-mode";
import { findAgreementRecord, intentRecordsFor, latestLive, recordsConfigured } from "@/lib/checkout/records";
import {
  STILL_OPEN_AFTER_MS,
  STILL_OPEN_WITHIN_MS,
  TOUCHES,
  dueTouch,
  stillOpenEmail,
  type StillOpenFacts,
} from "@/lib/email/nurture";
import { emailKey, send, unsubscribeUrl } from "@/lib/email";
import { canEmail, leadsForAbandonment, leadsForNurture, normalizeEmail, recordTouch, type Lead } from "@/lib/leads";
import { issueSetupToken, setupLinkUrl } from "@/lib/setup-link";
import { sendSetupLinkReminders } from "@/lib/setup-links";
import { findSetupRequest, setupRequestedEmails } from "@/lib/setup-requests";

/**
 * One cron tick. Exported without the HTTP wrapper so a test can run it at a
 * chosen `now` and so an operator can run it by hand.
 *
 * Every lead is re-checked with canEmail() at send time, not at query time:
 * an unsubscribe that landed between the two must win.
 *
 * The same tick sends the "still open" email (P7) and the setup-link
 * reminders (P5), because the Hobby plan allows one daily cron and neither
 * window needs more.
 */
export type NurtureRun = {
  nurtureSent: number;
  abandonmentSent: number;
  setupRemindersSent: number;
  skipped: number;
  failed: number;
};

export async function runNurture(now: Date = new Date()): Promise<NurtureRun> {
  const run: NurtureRun = { nurtureSent: 0, abandonmentSent: 0, setupRemindersSent: 0, skipped: 0, failed: 0 };

  // Someone who asked us to set them up is talking to a person now, so the
  // sequence stops for them (Annex X6). Read once per run, like the leads.
  const requested = await setupRequestedEmails();

  for (const lead of await leadsForNurture(TOUCHES.length)) {
    const touch = dueTouch(lead, now);
    if (!touch) continue;
    if (requested.has(normalizeEmail(lead.email))) {
      run.skipped += 1;
      continue;
    }
    const permitted = canEmail(lead, "marketing");
    if (!permitted.ok) {
      run.skipped += 1;
      continue;
    }
    const result = await send({
      to: lead.email,
      subject: touch.subject,
      text: touch.text(lead),
      unsubscribeUrl: unsubscribeUrl(lead.id),
      tag: `nurture-${touch.step}`,
      // One touch per lead, so a retried run inside Resend's day sends once.
      idempotencyKey: emailKey(`nurture-${touch.step}`, lead.id),
    });
    if (result.status === "failed") {
      run.failed += 1;
      continue;
    }
    // "skipped" (no transport, dev only) still advances, so a dev run does
    // not resend the same touch forever; production throws before this.
    await recordTouch(lead.id, { kind: "nurture", step: touch.step });
    run.nurtureSent += 1;
  }

  // P7: 24 hours after the latest Session expired unpaid, at most a week on.
  const due = await leadsForAbandonment(
    new Date(now.getTime() - STILL_OPEN_AFTER_MS),
    200,
    new Date(now.getTime() - STILL_OPEN_WITHIN_MS),
  );
  for (const lead of due) {
    const permitted = canEmail(lead, "relationship");
    if (!permitted.ok) {
      run.skipped += 1;
      continue;
    }
    const facts = await stillOpenFacts(lead, now);
    if (facts === "skip") {
      run.skipped += 1;
      continue;
    }
    const message = stillOpenEmail(lead, facts);
    const result = await send({
      to: lead.email,
      subject: message.subject,
      text: message.text,
      unsubscribeUrl: unsubscribeUrl(lead.id),
      tag: "still-open",
      idempotencyKey: emailKey("still-open", lead.id),
    });
    if (result.status === "failed") {
      run.failed += 1;
      continue;
    }
    await recordTouch(lead.id, { kind: "abandonment" });
    run.abandonmentSent += 1;
  }

  const reminders = await sendSetupLinkReminders(now);
  run.setupRemindersSent = reminders.sent;
  run.failed += reminders.failed;

  return run;
}

/**
 * What P7 says, re-read at send time from the purchase the expired Session
 * was for (its ref, recorded by the webhook), or "skip" when it must not go:
 * the purchase was provisioned, or its setup request was paid or asked us to
 * stop. Without a readable purchase it still goes, naming what the lead row
 * knows and the agreement generically, because the expiry itself is a fact.
 */
async function stillOpenFacts(lead: Lead, now: Date): Promise<StillOpenFacts | "skip"> {
  const facts: StillOpenFacts = { clinicName: lead.clinicName, agreementKind: null, setupLink: null };
  if (!lead.abandonedRef || !recordsConfigured()) return facts;
  try {
    const { records } = await intentRecordsFor(lead.abandonedRef);
    if (records.some((r) => r.provisionedAt !== null)) return "skip";
    const latest = latestLive(records) ?? records[records.length - 1] ?? null;
    if (!latest) return facts;
    facts.clinicName = latest.intent.clinicName || facts.clinicName;
    const agreement = await findAgreementRecord(String(latest.intent.agreementId));
    if (agreement.status === "found") facts.agreementKind = agreementKindOfVersion(agreement.record.documentVersion);

    const requestId = latest.intent.inviteRef;
    if (requestId) {
      const request = await findSetupRequest(requestId);
      if (request && (request.status === "paid" || request.paidAt || request.unsubscribedAt)) return "skip";
      const expiresAt = request?.linkExpiresAt ?? null;
      if (
        request &&
        request.status !== "declined" &&
        expiresAt &&
        expiresAt.getTime() > now.getTime() &&
        checkoutMode() === "pilot"
      ) {
        // The very link P4 sent, re-signed from the stored expiry, as P5 does:
        // a new one would quietly replace the one in their inbox.
        facts.setupLink = { url: setupLinkUrl(issueSetupToken(request.id, request.email, expiresAt)), expiresAt };
      }
    }
  } catch (error) {
    console.error("[healdesk] still-open email: the purchase could not be read; sending without it", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return facts;
}
