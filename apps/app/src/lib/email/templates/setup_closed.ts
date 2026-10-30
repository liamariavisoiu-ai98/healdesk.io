import { audienceSingular } from "@healdesk/catalog";

import { formatReplyBy } from "@/lib/reply-by";

import { publicUrl } from "@/lib/public-url";

import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";
import { helpLine } from "./welcome";

/**
 * The day-30 closure email (owner, 6 October 2026): a clinic whose 30-day
 * setup window ended with nothing answering is closed, the subscription is
 * cancelled with nothing refunded, and the account is removed apart from the
 * signed agreement and the billing records the law requires. Package C
 * cancels and starts offboarding with the reason `setup_closure`; this is
 * the one email that sends (contracts §2), queued in that same transaction
 * by lib/setup/closure-email.ts.
 *
 * It says what happened and what it means: no more charges, AYA answers no
 * one, and nothing changes for the clinic's callers, because nothing was ever
 * forwarded to an assistant that was never live. No link: there is nothing
 * left to sign in to that would help. One button, Talk to us (/help/call,
 * which needs no sign-in), is the way back; a reply still reaches a person.
 */

export type SetupClosedPayload = {
  /** The setup window's last day, as an ISO date on the clinic's calendar. */
  closedOn: string;
  helpPhoneE164: string | null;
};

export const renderSetupClosed: EmailTemplate<SetupClosedPayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  const audience = audienceSingular(ctx.audience);
  return compose(
    {
      subject: "We've closed your healdesk account: setup wasn't finished",
      preheader: "Setup wasn't finished within 30 days. Nothing more will be charged.",
      blocks: [
        {
          type: "paragraph",
          text: `We closed ${clinic}'s account because the 30-day setup window ended on ${formatReplyBy(payload.closedOn)} with nothing answering ${audience}s.`,
        },
        {
          type: "list",
          items: [
            "Nothing more will be charged. The setup fee is not refunded, as the terms say.",
            `AYA answers no one for ${clinic}, so calls and messages reach you exactly as they did before.`,
            "We keep the signed agreement and the billing records the law requires us to keep.",
          ],
        },
        {
          type: "paragraph",
          text: "If you'd like to set AYA up after all, tell us and we'll help you start again.",
        },
        // /help/call needs no sign-in (there is nothing left to sign in to):
        // the scheduling page while one is set, else how to reach us.
        { type: "action", label: "Talk to us", url: publicUrl("/help/call") },
        { type: "paragraph", text: helpLine(payload, audience) },
      ],
    },
    ctx,
  );
};

export const SETUP_CLOSED_ENTRY: TemplateEntry<SetupClosedPayload> = {
  render: renderSetupClosed,
  fixture: { closedOn: "2026-11-06", helpPhoneE164: "+18885550100" },
};
