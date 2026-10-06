import { publicUrl } from "@/lib/public-url";

import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * B2: the sign-in link, sent from /sign-in and its "Send again" (plan Part
 * D1, Annex X5).
 *
 * A link email (X1.5): the token is minted at send time and lives only in
 * this message, never in a stored payload, so this kind is sent straight and
 * never through the outbox. It names no clinic: one address can sign in to
 * several locations, and a sign-in email that named one would say which
 * clinics an address belongs to to anyone who can read the inbox, which the
 * page that sent it is careful never to say.
 */

export type SignInLinkPayload = {
  /** publicUrl("/link/<token>"): the only place the token is ever written. */
  signInUrl: string;
  /** How long the link works, from SIGN_IN_LINK_TTL_MS. */
  validMinutes: number;
};

export const renderSignInLink: EmailTemplate<SignInLinkPayload> = (payload, ctx) =>
  compose(
    {
      subject: "Your healdesk sign-in link",
      preheader: `It works once, for the next ${payload.validMinutes} minutes.`,
      blocks: [
        { type: "paragraph", text: "Here is the link you asked for to sign in to healdesk." },
        { type: "action", label: "Sign in", url: payload.signInUrl },
        {
          type: "paragraph",
          text: `It works once, for the next ${payload.validMinutes} minutes. If it runs out, ask for a new one on the sign-in page.`,
        },
        {
          type: "paragraph",
          text: "If you didn't ask to sign in, you can ignore this email. Nobody can sign in without the link in it.",
        },
      ],
    },
    ctx,
  );

/** Token-shaped and never issued: what the snapshot tests and the seed script render. */
const FIXTURE_TOKEN = "kP3vXq9TzR7wYb2NcL5mHs8JdF4gA6eU1oIiQ0yBtVx";

export const SIGN_IN_LINK_ENTRY: TemplateEntry<SignInLinkPayload> = {
  render: renderSignInLink,
  // A getter, so the link is built from BETTER_AUTH_URL when a test or the
  // seed script reads it, not when this module loads.
  get fixture(): SignInLinkPayload {
    return { signInUrl: publicUrl(`/link/${FIXTURE_TOKEN}`), validMinutes: 15 };
  },
};
