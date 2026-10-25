import { CURRENT_BAA_VERSION } from "@healdesk/catalog";

import { publicUrl } from "@/lib/public-url";

import { compose, EmailCompositionError, type Block } from "./compose";
import { noteLine } from "./contact-words";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L22c, the owner's chase of a business associate agreement version re-sign
 * (design E6 §3 item 14; ops automation lane P6f), after L22 and its two
 * automatic reminders at 3 and 7 days have gone unanswered. At most one in
 * seven days per re-sign, and only through the approval inbox, after the
 * owner's yes.
 *
 * A link email (X1.5): the signing link is minted when it is sent
 * (lib/approvals/contact-executors.ts, from BETTER_AUTH_URL through
 * lib/agreements/resign.ts resignPath) and lives only in this message, so it
 * is sent straight and recorded on the ledger, never queued in the outbox,
 * and never stored in the approval's draft.
 *
 * Only for a `baa_version` re-sign, which never pauses AYA (owner, 19
 * October 2026; lib/agreements/resign-pause.ts): the version signed governs
 * until the newer one is. So it names no pause, no suspension and no date
 * the practice must meet, only how long the link works. The only editable
 * part is one approved closing sentence.
 */

export type BaaResignChasePayload = {
  /** publicUrl("/agreement/<token>"): the only place the token is written. */
  signUrl: string;
  /** How many days the link works. */
  validDays: number;
  /** The version in force, which the current one replaces. */
  fromVersion: string;
  /** The version to sign. */
  toVersion: string;
  /** Whether AYA answers anywhere: a practice not yet live is not told she "keeps answering". */
  isAnswering: boolean;
  /** One approved closing sentence, or none. */
  note: string | null;
};

export const renderBaaResignChase: EmailTemplate<BaaResignChasePayload> = (payload, ctx) => {
  if (!payload.signUrl) throw new EmailCompositionError("A re-sign chase carries its signing link.");
  const greeting = ctx.clinicName ? `Hi ${ctx.clinicName} team,` : "Hello,";
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `${greeting} version ${payload.toVersion} of our business associate agreement is ready for your signature.`,
    },
    {
      type: "paragraph",
      text: payload.isAnswering
        ? `AYA keeps answering as normal under the version you signed (${payload.fromVersion}). Nothing changes until you sign.`
        : `The version you signed (${payload.fromVersion}) stays in force until you sign the new one.`,
    },
    { type: "action", label: "Open, read and sign", url: payload.signUrl },
    { type: "paragraph", text: `This link works for ${payload.validDays} days.` },
    { type: "paragraph", text: "If anything in it raises a question, just reply to this email." },
  ];
  const note = noteLine(payload.note);
  if (note) blocks.push({ type: "paragraph", text: note });
  return compose(
    {
      subject: "Your updated business associate agreement is waiting",
      preheader: `Version ${payload.toVersion} is ready for your signature.`,
      blocks,
    },
    ctx,
  );
};

/** Token-shaped and never issued: what the snapshot test and the seed script render. */
const FIXTURE_TOKEN =
  "Bq7LmW2pXr9VtN4bKc8HsJ3dFg6Ae1UoIiQ5yBxCvMnTwPkRlSjDhGfEaOuYzX0q1w2e3r4t5y6u7i8o9p0aZxCvBnM1";

export const BAA_RESIGN_CHASE_ENTRY: TemplateEntry<BaaResignChasePayload> = {
  render: renderBaaResignChase,
  get fixture(): BaaResignChasePayload {
    return {
      signUrl: publicUrl(`/agreement/${FIXTURE_TOKEN}`),
      validDays: 14,
      fromVersion: "1.4.0",
      toVersion: CURRENT_BAA_VERSION,
      isAnswering: true,
      note: null,
    };
  },
};
