import { ABANDONMENT_AFTER_MS, TOUCHES, abandonmentEmail, dueTouch } from "@/lib/email/nurture";
import { emailKey, send, unsubscribeUrl } from "@/lib/email";
import { canEmail, leadsForAbandonment, leadsForNurture, normalizeEmail, recordTouch } from "@/lib/leads";
import { sendSetupLinkReminders } from "@/lib/setup-links";
import { setupRequestedEmails } from "@/lib/setup-requests";

/**
 * One cron tick. Exported without the HTTP wrapper so a test can run it at a
 * chosen `now` and so an operator can run it by hand.
 *
 * Every lead is re-checked with canEmail() at send time, not at query time:
 * an unsubscribe that landed between the two must win.
 *
 * The same tick sends the setup-link reminders (P5), because the Hobby plan
 * allows one daily cron and the reminder's four-day window doesn't need more.
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

  for (const lead of await leadsForAbandonment(new Date(now.getTime() - ABANDONMENT_AFTER_MS))) {
    const permitted = canEmail(lead, "relationship");
    if (!permitted.ok) {
      run.skipped += 1;
      continue;
    }
    const message = abandonmentEmail(lead);
    const result = await send({
      to: lead.email,
      subject: message.subject,
      text: message.text,
      unsubscribeUrl: unsubscribeUrl(lead.id),
      tag: "abandonment",
      idempotencyKey: emailKey("abandonment", lead.id),
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
