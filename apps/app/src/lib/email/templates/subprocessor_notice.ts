import {
  isPhiSubcontractor,
  PHI_SUBCONTRACTORS,
  SENDER_IDENTITY,
  type PhiSubcontractor,
} from "@healdesk/catalog";

import { momentLong } from "./billing-copy";
import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L29, the first of its two emails: notice of a subcontractor that will
 * handle the information the practice's agreement protects (Annex X5), an
 * operator broadcast from /admin to every practice with an agreement in
 * effect. Critical once queued: the agreement's notice period runs from it.
 *
 * What it says is what the agreements promise the notice says
 * (packages/catalog subprocessor-notice.ts): it "names the subcontractor,
 * what it will receive and why", ahead of the day it starts, and keeps the
 * practice's right to object. The words come from the catalog's closed list
 * (PHI_SUBCONTRACTORS), never from the console. The lead time is checked when
 * the broadcast is sent (lib/notices/operator-notices.ts), against each
 * practice's own agreement: fifteen days under BAA 1.7.0 and DPA 1.2.0, 24
 * hours under BAA 1.3.0 to 1.6.0, DPA 1.0.0 and DPA 1.1.0, fifteen days under
 * the versions before. The email states the start, not the
 * period.
 *
 * It never links to a vendor list: there is none to link to. The current
 * list is given to a signed practice on written request (owner, 9 October
 * 2026), and the email says so. It carries no link at all; the reply is the
 * way to object or to ask.
 */

export type SubprocessorNoticePayload = {
  /** The subcontractor, from PHI_SUBCONTRACTORS. */
  provider: PhiSubcontractor;
  /** When it starts handling the information, as an instant. */
  startsAt: string;
};

export const renderSubprocessorNotice: EmailTemplate<SubprocessorNoticePayload> = (
  payload,
  ctx,
) => {
  if (!isPhiSubcontractor(payload.provider)) {
    throw new EmailCompositionError(`Unknown subcontractor "${String(payload.provider)}".`);
  }
  const sub = PHI_SUBCONTRACTORS[payload.provider];
  const clinic = ctx.clinicName ?? "your practice";
  const from = momentLong(payload.startsAt, ctx);

  return compose(
    {
      subject: `Notice of a new healdesk subcontractor: ${sub.name}`,
      preheader: `It starts at ${from}. You can object before then.`,
      blocks: [
        {
          type: "paragraph",
          text: `As ${clinic}'s agreement with healdesk provides, we're telling you before a new subcontractor starts handling the information that agreement protects.`,
        },
        {
          type: "facts",
          rows: [
            ["Subcontractor", sub.name],
            ["What it will receive", sub.receives],
            ["Why", sub.why],
            ["From", from],
          ],
        },
        {
          type: "paragraph",
          text: "If you object on reasonable grounds, reply to this email before then. You may then end your agreement without penalty, as its Subcontractors clause provides.",
        },
        {
          type: "paragraph",
          text: `Our current list of subcontractors is yours on written request: reply to this email, or write to ${SENDER_IDENTITY.replyTo}.`,
        },
      ],
    },
    ctx,
  );
};

export const SUBPROCESSOR_NOTICE_ENTRY: TemplateEntry<SubprocessorNoticePayload> = {
  render: renderSubprocessorNotice,
  fixture: { provider: "retell", startsAt: "2026-10-16T15:00:00Z" },
};
