import { CHANNELS, type Channel } from "@healdesk/catalog";

import { fallbackLine, PAUSE_LINE_ORDER } from "@/lib/channels/pause-words";
import { publicUrl } from "@/lib/public-url";

import { compose, EmailCompositionError, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L22: "Sign your updated agreement" (plan Part L, Annex X5), to the clinic's
 * address, for a practice under the Data Protection Agreement whose answer
 * to "Do you bill any health insurance electronically?" is now "Yes" or "Not
 * sure": the DPA no longer covers it, the business associate agreement does,
 * and the link opens it to sign (lib/agreements/resign.ts). Again at 3 and 7
 * days while it is unsigned, each with a fresh link.
 *
 * A link email (X1.5): the token is minted when this is sent and lives only in
 * this message, so it is sent straight and recorded on the ledger, never
 * queued in the outbox.
 *
 * It says AYA is paused until it is signed, and where each channel's people
 * go meanwhile, because both are true from the moment the re-sign opens: it
 * puts the header's pause on AYA in the same transaction (resign.ts), which
 * the answer gate honours on every call, chat and message, and the header
 * cannot lift it until the agreement is signed. A practice with nothing
 * answering yet is told AYA starts only once it is signed. Nothing about a
 * patient, and no date the practice must meet: the link's own days only.
 */

export type AgreementToSignPayload = {
  /** publicUrl("/agreement/<token>"): the only place the token is written. */
  signUrl: string;
  /** How many days the link works. */
  validDays: number;
  /** Days since the re-sign began: 0 for the first email, 3 and 7 for the reminders. */
  waitingDays: number;
  /** The answer was "Not sure" rather than "Yes". */
  isUnsure: boolean;
  /**
   * The channels that answered when AYA was not paused: live and switched
   * On, in the order the lines are given. Empty when nothing answers yet.
   */
  channels: Channel[];
  /** The clinic's direct line, for phone's line. */
  directLineE164: string | null;
};

export const renderAgreementToSign: EmailTemplate<AgreementToSignPayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  const channels = PAUSE_LINE_ORDER.filter((c) => payload.channels.includes(c));
  if (payload.channels.some((c) => !(CHANNELS as readonly string[]).includes(c))) {
    throw new EmailCompositionError("A channel in this email is not one of healdesk's channels.");
  }
  const reminder = payload.waitingDays > 0;
  const answering = channels.length > 0;

  const why = payload.isUnsure
    ? `You told us you're not sure whether ${clinic} bills any health insurance electronically, yourself or through a clearinghouse. Until you're sure it doesn't, the business associate agreement is the one that covers your practice, not the data protection agreement it signed.`
    : `You told us ${clinic} now bills health insurance electronically, yourself or through a clearinghouse. That makes it a covered entity under HIPAA, so the data protection agreement it signed no longer covers it: the business associate agreement does.`;

  const blocks: Block[] = [
    {
      type: "paragraph",
      text: reminder
        ? `Your updated agreement is still waiting to be signed, ${payload.waitingDays} days after we sent it.`
        : why,
    },
  ];
  if (reminder) blocks.push({ type: "paragraph", text: why });
  if (answering) {
    blocks.push(
      { type: "paragraph", text: "Until it's signed, AYA is paused:" },
      {
        type: "list",
        items: channels.map((c) => fallbackLine(c, payload.directLineE164)),
      },
    );
  } else {
    blocks.push({
      type: "paragraph",
      text: `AYA doesn't answer your ${ctx.audience} until it's signed.`,
    });
  }
  blocks.push(
    { type: "action", label: "Sign your updated agreement", url: payload.signUrl },
    {
      type: "paragraph",
      text: `Read it to the end, type your name and sign. Your plan and your settings stay as they are${answering ? ", and AYA answers again the moment it's signed" : ""}. The link works for ${payload.validDays} days; after that, sign it from Billing in healdesk, under Your agreement.`,
    },
    {
      type: "paragraph",
      text: `If ${clinic} bills no insurance electronically after all, reply to this email and we'll set it right.`,
    },
  );

  return compose(
    {
      subject: reminder
        ? "Your updated agreement is waiting to be signed"
        : "Sign your updated agreement",
      preheader: answering
        ? "AYA is paused until it's signed."
        : "AYA starts answering once it's signed.",
      blocks,
    },
    ctx,
  );
};

/** Token-shaped and never issued: what the snapshot tests and the seed script render. */
const FIXTURE_TOKEN =
  "AZ3kQm7tR2xV9cK4pL8wN3sJ6hF1dB5gZ0yAeU2iOqXvTkMRk8mW2cQ9vB4nL7pS1dF6hJ3kG8tY5uE0aZxCvBnM1qW";

export const AGREEMENT_TO_SIGN_ENTRY: TemplateEntry<AgreementToSignPayload> = {
  render: renderAgreementToSign,
  // A getter, so the link is built from BETTER_AUTH_URL when a test or the
  // seed script reads it, not when this module loads.
  get fixture(): AgreementToSignPayload {
    return {
      signUrl: publicUrl(`/agreement/${FIXTURE_TOKEN}`),
      validDays: 14,
      waitingDays: 0,
      isUnsure: false,
      channels: ["voice", "web"],
      directLineE164: "+14155550100",
    };
  },
};
