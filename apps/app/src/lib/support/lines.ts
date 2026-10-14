import { SENDER_IDENTITY } from "@healdesk/catalog";

import { formatPhone, helpContacts } from "@/lib/setup/help";

/**
 * The support chat's fixed lines (plan Part H: "A refusal shows a fixed line
 * with the phone and email"; past a limit, the same line), so a person at
 * healdesk is always one step away. The phone only while the owner has set
 * one (lib/setup/help.ts): a line that rings nobody is never printed.
 */
export type SupportLines = {
  /** A refusal, and any limit reached. */
  refusal: string;
  /** The model or the account could not be reached. */
  failure: string;
};

export function supportLines(phoneE164: string | null = helpContacts().phoneE164): SupportLines {
  const reach = phoneE164
    ? `call ${formatPhone(phoneE164)} or email ${SENDER_IDENTITY.replyTo}`
    : `email ${SENDER_IDENTITY.replyTo}`;
  return {
    refusal: `I can't help with that here. A person can: please ${reach}.`,
    failure: `Sorry, the support chat isn't working right now. A person can help: please ${reach}.`,
  };
}
