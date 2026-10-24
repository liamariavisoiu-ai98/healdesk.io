import { alertWording, type AlertWording } from "@/lib/ops/alert-wording";
import { wordingValues } from "@/lib/ops/alert-wording/allow-list";
import { emailFacts, opsFieldLabel } from "@/lib/ops/alert-wording/facts";
import { fillWording, formatDay, numberedSteps } from "@/lib/ops/alert-wording/render";
import type { OpsEvent } from "@/lib/ops/notify";

import { compose, type Block } from "./compose";
import type { EmailTemplate } from "./types";

/**
 * I1 in Annex X5: one notifyOps alert, to HEALDESK_OPS_EMAIL.
 *
 * Since 23 October 2026 (lane N1) every alert reads as plain English, from
 * its AlertWording (lib/ops/alert-wording): what happened, to whom, why it
 * matters, and numbered steps naming the console page or button to use. The
 * Slack copy (lib/ops/slack.ts) prints the same sentences, filled by the same
 * function from the same allow-listed values.
 *
 * Ids, counts and categories, which the operator looks up in the ops
 * console, and the clinic's name beside its id (business data; the owner's
 * decision D2 of 23 October 2026), or a setup requester's business name.
 * Nothing here quotes an address, names a patient or carries free text, so
 * the alert is safe to read on a phone in a queue and safe in a vendor's
 * logs.
 *
 * It links to one place only (owner decision D3): the console page that owns
 * the alert (`consoleUrl`, built by opsConsoleLink in lib/ops/notify.ts), the
 * clinic panel's tab with the alert's anchor, which lib/email/lint.ts accepts
 * in this kind alone and only under /admin/ on HEALDESK_CONSOLE_ORIGIN. With
 * that origin unset it links nowhere.
 */

/** The alert's fields: ids, counts and categories, keyed as lib/log.ts keys them. */
export type OpsAlertPayload = {
  event: OpsEvent;
  [field: string]: string | number | boolean | null;
};

function wordingFor(payload: OpsAlertPayload): AlertWording {
  return alertWording(payload.event, payload);
}

/** The alert's title, as its email's subject prints it: the Slack copy's first line (lib/ops/slack.ts). */
export function opsAlertTitle(payload: OpsAlertPayload): string {
  return wordingFor(payload).title;
}

/** The label a field prints under, in the email and the Slack copy alike (lib/ops/alert-wording/facts.ts). */
export { opsFieldLabel };

export const renderOpsAlert: EmailTemplate<OpsAlertPayload> = (payload, ctx) => {
  const clinicName = typeof payload.clinicName === "string" ? payload.clinicName : null;
  const wording = fillWording(wordingFor(payload), wordingValues(payload, clinicName));
  const consoleUrl = typeof payload.consoleUrl === "string" ? payload.consoleUrl : null;
  // The facts the Slack copy prints, plus who the alert is about; a legacy
  // wording's text points at ids and codes "below", so it keeps them too.
  const facts = emailFacts(payload.event, payload, wordingFor(payload), clinicName);

  const blocks: Block[] = [
    { type: "paragraph", text: wording.whatHappened },
    {
      type: "facts",
      // Days only, never a time (lane N1 review).
      rows: [...facts, ["Raised", formatDay(ctx.raisedAt.toISOString())]],
    },
    ...(wording.whyItMatters ? [{ type: "paragraph" as const, text: `Why it matters: ${wording.whyItMatters}` }] : []),
    ...(wording.steps.length > 0
      ? [{ type: "paragraph" as const, text: ["What to do:", ...numberedSteps(wording.steps)].join("\n") }]
      : []),
    // The page that owns the alert on the console (D3), behind its own sign-in.
    ...(consoleUrl ? [{ type: "action" as const, label: "Open in the console", url: consoleUrl }] : []),
    { type: "paragraph", text: `Alert code: ${payload.event}` },
  ];

  return compose({ subject: `healdesk ops: ${wording.title}`, preheader: wording.whatHappened, blocks }, ctx);
};

/** The payload the snapshot test and `npm run email:seed` render. */
export const OPS_ALERT_FIXTURE: OpsAlertPayload = {
  event: "critical_notice_undelivered",
  clinicId: "0c1d2e3f-0000-4000-8000-000000000000",
  noticeId: "5f0e4a1b-1111-4222-8333-444455556666",
  kind: "payment_failed",
  status: "late",
  attempts: 3,
};
