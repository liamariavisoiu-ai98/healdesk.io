import { alertWording, type AlertWording } from "@/lib/ops/alert-wording";
import { wordingValues } from "@/lib/ops/alert-wording/allow-list";
import { emailFacts, opsFieldLabel } from "@/lib/ops/alert-wording/facts";
import { parseMarkup, plainText } from "@/lib/ops/alert-wording/markup";
import { formatDay, layoutAlert } from "@/lib/ops/alert-wording/render";
import { consoleLinkLabel } from "@/lib/ops/alert-wording/tabs";
import { URGENCY_LOOK } from "@/lib/ops/alert-wording/urgency";
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

/**
 * The layout (lane N4; owner, 24 October 2026: "scan the email and
 * understand from the first 3 seconds what the issue is"): the urgency tag
 * and one headline; a highlighted "Do this first" with step 1 and the
 * console button; then, under "More detail", the rest of what happened, the
 * facts, why it matters, the remaining steps from 2, and the alert's code.
 * Step 1 is printed once. The preheader is "<URGENCY>: <headline>".
 */
export const renderOpsAlert: EmailTemplate<OpsAlertPayload> = (payload, ctx) => {
  const clinicName = typeof payload.clinicName === "string" ? payload.clinicName : null;
  const raw = wordingFor(payload);
  const layout = layoutAlert(raw, wordingValues(payload, clinicName));
  const look = URGENCY_LOOK[layout.urgency];
  const consoleUrl = typeof payload.consoleUrl === "string" ? payload.consoleUrl : null;
  // The page that owns the alert on the console (D3), behind its own sign-in.
  const action = consoleUrl ? { label: consoleLinkLabel(consoleUrl), url: consoleUrl } : undefined;
  // The facts the Slack copy prints, plus who the alert is about.
  const facts = emailFacts(payload.event, payload, raw, clinicName);
  const headline = plainText(layout.headline);

  const blocks: Block[] = [
    { type: "headline", tag: { text: look.tag, tone: look.tone }, segments: parseMarkup(layout.headline) },
    ...(layout.doFirst
      ? [{ type: "callout" as const, label: "Do this first", segments: parseMarkup(layout.doFirst), ...(action ? { action } : {}) }]
      : action
        ? [{ type: "action" as const, ...action }]
        : []),
    { type: "divider", label: "More detail" },
    ...(layout.detail ? [{ type: "rich" as const, segments: parseMarkup(layout.detail) }] : []),
    {
      type: "facts",
      // Days only, never a time (lane N1 review).
      rows: [...facts, ["Raised", formatDay(ctx.raisedAt.toISOString())]],
    },
    ...(layout.whyItMatters
      ? [{ type: "rich" as const, label: "Why it matters:", segments: parseMarkup(layout.whyItMatters) }]
      : []),
    ...(layout.then.length > 0
      ? [
          {
            type: "rich" as const,
            label: "Then:",
            segments: parseMarkup(["", ...layout.then.map((step, i) => `${i + 2}. ${step}`)].join("\n")),
          },
        ]
      : []),
    { type: "rich", small: true, segments: [{ text: `Alert code: ${payload.event}` }] },
  ];

  return compose(
    {
      subject: `healdesk ops: ${look.subject}${layout.title}`,
      preheader: `${look.tag}: ${headline}`,
      blocks,
    },
    ctx,
  );
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
