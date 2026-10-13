import type { NoticePayloads } from "@/lib/billing/notices";

import { dayLong, dayShort, plusDays, undoForwarding } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * E2: the service has ended (Annex X5). Never sent for the 30-day setup
 * closure, whose email is the funnel's offboarding (R12).
 *
 * In the order a clinic needs it: calls still pass straight through to its
 * direct line for the Terms' pass-through days (§7), and how to undo the
 * forwarding for its own carrier before they stop (the catalog's undo steps,
 * R31); the website chat's contact form until the snippet comes off; then the
 * export and the destruction dates. Each channel's paragraph appears only when
 * the clinic bought that channel, so a chat-only clinic is not told to undo
 * forwarding it never set up.
 *
 * The dates are destructionPlan's (lib/offboarding), by the rule of the
 * agreement the clinic's service ended under. On BAA 1.2.2 and earlier the
 * data goes a day before thirty days are up, whatever the export; on BAA
 * 1.3.0 and the DPA it goes a day before thirty days are up once the export
 * has been delivered, at the next hourly run after its delivery when that is
 * later (so within 30 days of its delivery either way), and a day before
 * ninety days are up if it never is. `exportByOn` is the date a day before
 * day 29 on either rule, the last whole day before any run can destroy the
 * data.
 * Either way it goes within 30 days of the export's delivery and by
 * `destroyByOn` at the latest, which is what the email says: both days, the
 * second as the latest, and never one exact date, because a clinic told its
 * data stays until the later date would plan around a record that is
 * already gone. Nor does it say the agreement sets these dates; the one in
 * effect sets its own.
 */

export type CanceledPayload = NoticePayloads["canceled"];

export const renderCanceled: EmailTemplate<CanceledPayload> = (payload, ctx) => {
  const voice = payload.channels.includes("voice");
  const passThroughEnds = plusDays(payload.endedAt, payload.passThroughDays);
  const ended = dayLong(payload.endedAt, ctx);

  const blocks: Block[] = [
    {
      type: "paragraph",
      text: payload.isBeforeStart
        ? `Your healdesk service ended on ${ended}. Your plan never started, so nothing more was charged.`
        : `Your healdesk service ended on ${ended}, and AYA has stopped answering.`,
    },
  ];
  if (voice) {
    blocks.push(
      ...undoForwarding(
        payload,
        `For ${payload.passThroughDays} days, until ${dayLong(passThroughEnds, ctx)}, calls that still forward to us pass straight through to your direct line. Undo the forwarding before then, so callers keep reaching you directly.`,
      ),
    );
  }
  if (payload.channels.includes("web")) {
    blocks.push({
      type: "paragraph",
      text: "Your website chat shows a contact form until you remove the healdesk snippet from your website.",
    });
  }
  if (payload.channels.includes("meta")) {
    blocks.push({
      type: "paragraph",
      text: "AYA no longer replies on Instagram, Messenger or WhatsApp. New messages there wait in your inbox for your team.",
    });
  }
  blocks.push(
    {
      type: "paragraph",
      text: `We'll email you when your export of conversation records and the booking log is ready. Download it by ${dayLong(payload.exportByOn, ctx)}.`,
    },
    {
      type: "paragraph",
      text: `We destroy our copies of your data within 30 days of your export being delivered, and by ${dayLong(payload.destroyByOn, ctx)} at the latest. Billing records are kept, as tax law requires.`,
    },
  );

  return compose(
    {
      subject: "Your healdesk service has ended",
      preheader: voice
        ? `Calls still pass through to your direct line until ${dayShort(passThroughEnds, ctx)}.`
        : `Download your export by ${dayShort(payload.exportByOn, ctx)}.`,
      blocks,
    },
    ctx,
  );
};

export const CANCELED_ENTRY: TemplateEntry<CanceledPayload> = {
  render: renderCanceled,
  fixture: {
    passThroughDays: 30,
    endedAt: "2026-11-06T14:32:00.000Z",
    isBeforeStart: false,
    channels: ["web", "voice"],
    exportByOn: "2026-12-06",
    destroyByOn: "2027-02-04",
    carrier: "att",
    phoneSystem: "landline",
    routing: "all_calls",
  },
};
