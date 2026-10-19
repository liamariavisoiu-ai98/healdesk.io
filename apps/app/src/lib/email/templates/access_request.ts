import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * I3's access request (Annex X5: "Setup requests, enquiries, reviews,
 * support escalations, access requests", to hello@): a /sign-in/help request
 * that sent no link (plan Part D5: "Anything else emails hello@ with
 * structured fields").
 *
 * Structured fields only, as the support escalation's are: why no link went
 * (no account at the address, no billing record to check against, a detail
 * that matched nothing, or Stripe unavailable), the clinic's id when the
 * address is a clinic's, whether the name typed matched it, which kind of
 * billing detail was offered, and the address masked. Never what was typed:
 * not the clinic's name, not the card's digits or the invoice number, not the
 * address in full. When the address is an account's own, the reply-to is that
 * address, so answering the email answers the account; otherwise replies
 * stay with us.
 *
 * No link: the operator console lives on the marketing site's origin, and an
 * email from apps/app links only to apps/app's public origin (X1.6). The
 * clinic's id finds it in the console.
 */

export type AccessRequestCode = "no_account" | "no_billing" | "no_match" | "billing_unavailable";

export type AccessRequestPayload = {
  /** This request's own id: the `delivery` tag and the idempotency key. */
  requestId: string;
  /** Why no link was sent. */
  code: AccessRequestCode;
  /** The clinic the address signs in to, when it is an account's. */
  clinicId: string | null;
  /** Whether the clinic's name typed matched the account's: clinic_named, clinic_not_named. */
  signal: "clinic_named" | "clinic_not_named" | null;
  /** Which billing detail was offered: "card" or "invoice". Never the detail. */
  detail: "card" | "invoice";
  /** The address typed, masked ("l•••@glowspa.com"). */
  addressMasked: string;
  /** Whether a reply reaches the account's own address. */
  hasReplyAddress: boolean;
};

const WHY: Readonly<Record<AccessRequestCode, string>> = {
  no_account: "the address has no healdesk account",
  no_billing: "the account has no billing record yet to check the detail against",
  no_match: "the billing detail matched nothing on the account",
  billing_unavailable: "Stripe could not be asked to check the billing detail",
};

const SIGNAL: Readonly<Record<NonNullable<AccessRequestPayload["signal"]>, string>> = {
  clinic_named: "matched the account's",
  clinic_not_named: "did not match the account's",
};

export const renderAccessRequest: EmailTemplate<AccessRequestPayload> = (payload, ctx) =>
  compose(
    {
      subject: "Sign-in help: no link was sent",
      preheader: `No sign-in link went, because ${WHY[payload.code]}.`,
      blocks: [
        {
          type: "paragraph",
          text: `Someone asked for a sign-in link on the "I can't get in" page. No link was sent, because ${WHY[payload.code]}. They were told what everyone is told: if the details match, a link goes to the clinic's address.`,
        },
        {
          type: "facts",
          rows: [
            ["Request", payload.requestId],
            ["Address", payload.addressMasked],
            ["Clinic", payload.clinicId ?? "none at this address"],
            ["Clinic name typed", payload.signal ? SIGNAL[payload.signal] : "not compared"],
            ["Billing detail offered", payload.detail === "card" ? "a card" : "an invoice number"],
          ],
        },
        {
          type: "paragraph",
          text: payload.hasReplyAddress
            ? "Replying to this email reaches the account's own address. If they have lost access to that inbox, the change of address goes by the runbook: a call back to the published number, then ops' changeClinicEmail."
            : "The address has no account, so a reply stays with us. What was typed is not included: healdesk doesn't mail it.",
        },
      ],
    },
    ctx,
  );

export const ACCESS_REQUEST_FIXTURE: AccessRequestPayload = {
  requestId: "7a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d",
  code: "no_match",
  clinicId: "0c1d2e3f-0000-4000-8000-000000000000",
  signal: "clinic_named",
  detail: "card",
  addressMasked: "l•••@radiancemedspa.com",
  hasReplyAddress: true,
};

export const ACCESS_REQUEST_ENTRY: TemplateEntry<AccessRequestPayload> = {
  render: renderAccessRequest,
  fixture: ACCESS_REQUEST_FIXTURE,
};
