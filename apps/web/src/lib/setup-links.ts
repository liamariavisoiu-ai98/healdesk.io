import { COHORT_SETUP_CREDIT } from "@healdesk/catalog";

import { setupLinksOpen } from "@/lib/checkout-mode";
import { emailKey, sendSafely, setupUnsubscribeUrl } from "@/lib/email";
import { setupLinkEmail, setupLinkReminder } from "@/lib/email/setup-emails";
import { creditUntil } from "@/lib/setup-gate";
import { issueSetupToken, setupLinkExpiry, setupLinkUrl } from "@/lib/setup-link";
import {
  findSetupRequest,
  setupRequestsDueReminder,
  updateSetupRequest,
} from "@/lib/setup-requests";

/**
 * What /admin/setup does with a request, and the reminder the nurture cron
 * sends: the setup link's life after the form (Annex X: P4, P5).
 *
 * Kept out of the page so the rules are testable without a session:
 * - nothing is sent until setup links are open (`setupLinksOpen`, Gate A);
 * - state is written before the email goes, so a link always names a request
 *   that knows its expiry, and only the latest link works (lib/setup-gate.ts);
 * - P4 and P5 are commercial mail, so an unsubscribed requester gets neither,
 *   and both carry the one-click opt-out.
 */

export type SendLinkOutcome =
  | { ok: true; expiresAt: Date }
  | {
      ok: false;
      reason: "closed" | "not_found" | "paid" | "unsubscribed" | "unsigned" | "email_failed";
    };

/**
 * Send a request its setup link (P4), or a new one. A new link replaces the
 * old: the request keeps only the latest expiry, and the gate refuses any
 * other, so a forwarded or stale link stops working the moment this runs.
 */
export async function sendSetupLink(id: string, now: Date = new Date()): Promise<SendLinkOutcome> {
  if (!setupLinksOpen()) return { ok: false, reason: "closed" };
  const request = await findSetupRequest(id);
  if (!request) return { ok: false, reason: "not_found" };
  if (request.status === "paid" || request.paidAt) return { ok: false, reason: "paid" };
  if (request.unsubscribedAt) return { ok: false, reason: "unsubscribed" };

  const expiresAt = setupLinkExpiry(now);
  let token: string;
  try {
    token = issueSetupToken(request.id, request.email, expiresAt);
  } catch (error) {
    console.error("[healdesk] could not sign a setup link", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "unsigned" };
  }

  await updateSetupRequest(
    request.id,
    { status: "invited", invitedAt: now, linkExpiresAt: expiresAt, remindedAt: null },
    now,
  );

  const until = await creditUntil(request, COHORT_SETUP_CREDIT.validDays).catch(() => null);
  const email = setupLinkEmail(request, {
    link: setupLinkUrl(token),
    expiresAt,
    creditUntil: until,
    unsubscribeUrl: setupUnsubscribeUrl(request.id),
  });
  const result = await sendSafely({
    to: request.email,
    subject: email.subject,
    text: email.text,
    unsubscribeUrl: setupUnsubscribeUrl(request.id),
    tag: "setup-link",
    // A new link is a new attempt: its expiry tells the two apart.
    idempotencyKey: emailKey("setup-link", request.id, 1, expiresAt.getTime()),
  });
  if (result.status === "failed") {
    console.error("[healdesk] setup link saved but not emailed", { id: request.id, reason: result.reason });
    return { ok: false, reason: "email_failed" };
  }
  return { ok: true, expiresAt };
}

/** Decline a request. No email: the operator replies in person if a reply is due. */
export async function declineSetupRequest(id: string, now: Date = new Date()): Promise<boolean> {
  return (await updateSetupRequest(id, { status: "declined" }, now)) !== null;
}

/**
 * P5, from the nurture cron: one reminder per link, four days before it
 * expires unpaid. It carries the very link P4 did, re-signed from the stored
 * expiry, because a reminder with a new link would quietly replace the one in
 * the first email.
 */
export async function sendSetupLinkReminders(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  if (!setupLinksOpen()) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (const request of await setupRequestsDueReminder(now)) {
    const expiresAt = request.linkExpiresAt as Date;
    let token: string;
    try {
      token = issueSetupToken(request.id, request.email, expiresAt);
    } catch {
      failed += 1;
      continue;
    }
    const email = setupLinkReminder(request, {
      link: setupLinkUrl(token),
      expiresAt,
      unsubscribeUrl: setupUnsubscribeUrl(request.id),
    });
    const result = await sendSafely({
      to: request.email,
      subject: email.subject,
      text: email.text,
      unsubscribeUrl: setupUnsubscribeUrl(request.id),
      tag: "setup-reminder",
      idempotencyKey: emailKey("setup-reminder", request.id, 1, expiresAt.getTime()),
    });
    if (result.status === "failed") {
      failed += 1;
      continue;
    }
    await updateSetupRequest(request.id, { remindedAt: now }, now);
    sent += 1;
  }
  return { sent, failed };
}
