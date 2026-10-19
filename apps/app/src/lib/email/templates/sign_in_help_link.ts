import { publicUrl } from "@/lib/public-url";

import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * O6: the sign-in link sent from /sign-in/help (plan Part D5, Annex X5),
 * once the billing detail someone gave matched the account's at Stripe.
 *
 * Sent only to the address already on the account, never to one typed on
 * the form, and it never adds a device (spec, "Losing access"): it is a
 * sign-in link, and patient pages still need a passkey on top. A link email
 * (X1.5), so the token is minted at send time and lives only here. Like B2 it
 * names no clinic: one address can sign in to several locations.
 */

export type SignInHelpLinkPayload = {
  /** publicUrl("/link/<token>"): the only place the token is ever written. */
  signInUrl: string;
  /** How long the link works, from SIGN_IN_LINK_TTL_MS. */
  validMinutes: number;
};

export const renderSignInHelpLink: EmailTemplate<SignInHelpLinkPayload> = (payload, ctx) =>
  compose(
    {
      subject: "Your healdesk sign-in link, after your request for help",
      preheader: `It works once, for the next ${payload.validMinutes} minutes.`,
      blocks: [
        {
          type: "paragraph",
          text: "Someone asked for help signing in to healdesk with this address, and the billing detail they gave matched the account's. Here is a link that signs in.",
        },
        { type: "action", label: "Sign in", url: payload.signInUrl },
        {
          type: "paragraph",
          text: `It works once, for the next ${payload.validMinutes} minutes. Patient details still open only with Face ID or the screen lock on a device you've added.`,
        },
        {
          type: "paragraph",
          text: "If that wasn't someone at your practice, reply to this email and we'll look into it. Nobody can sign in without the link in it.",
        },
      ],
    },
    ctx,
  );

/** Why the address receives it: the same reason as any sign-in link. */
export const SIGN_IN_HELP_REASON =
  "You're receiving this because someone asked for help signing in to healdesk with this address.";

/** Token-shaped and never issued: what the snapshot tests and the seed script render. */
const FIXTURE_TOKEN = "Hc4nV8qL2xR6tY0wK3mP7sZ1jD5gB9fAeU2iOoXvTkN";

export const SIGN_IN_HELP_LINK_ENTRY: TemplateEntry<SignInHelpLinkPayload> = {
  render: renderSignInHelpLink,
  get fixture(): SignInHelpLinkPayload {
    return { signInUrl: publicUrl(`/link/${FIXTURE_TOKEN}`), validMinutes: 15 };
  },
};
