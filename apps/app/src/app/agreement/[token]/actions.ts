"use server";

import { headers } from "next/headers";

import { signAgreementResign } from "@/lib/agreements/resign";
import { clientIp } from "@/lib/client-ip";

/**
 * The re-sign screen's one action: sign the BAA (lib/agreements/resign.ts).
 * The link is the proof that this is the clinic's inbox, as a sign-in link
 * is; everything the document says but the typed signature is read again on
 * the server from the practice's own answers.
 */

export type ResignActionResult =
  | {
      ok: true;
      version: string;
      text: string;
      /** The signer's copy went; when it did not, the reason, said on the screen. */
      copy: { sent: true } | { sent: false; reason: string };
    }
  | { ok: false; message: string; field?: string };

const CLOSED: Record<"unknown" | "expired" | "signed" | "withdrawn", string> = {
  unknown:
    "This link isn't valid any more. Sign it from Billing in healdesk, under Your agreement.",
  expired: "This link has expired. Sign it from Billing in healdesk, under Your agreement.",
  signed: "This agreement is signed already.",
  withdrawn: "There's nothing to sign: your data protection agreement stays in force.",
};

export async function signResignAction(
  token: string,
  input: {
    signatoryName: string;
    signatoryTitle: string;
    displayedHash: string | null;
    templateVersion: string;
  },
): Promise<ResignActionResult> {
  const h = await headers();
  const outcome = await signAgreementResign(
    token,
    {
      signatoryName: input.signatoryName,
      signatoryTitle: input.signatoryTitle,
      displayedHash: input.displayedHash ?? undefined,
      templateVersion: input.templateVersion,
    },
    {
      // The address our load balancer saw (lib/client-ip.ts).
      ipAddress: clientIp(h) ?? undefined,
      userAgent: h.get("user-agent")?.slice(0, 512) ?? undefined,
    },
  );
  if (outcome.status === "closed") return { ok: false, message: CLOSED[outcome.reason] };
  if (outcome.status === "refused") {
    return {
      ok: false,
      message: outcome.message,
      ...(outcome.field ? { field: outcome.field } : {}),
    };
  }
  return {
    ok: true,
    version: outcome.version,
    text: outcome.text,
    copy:
      outcome.copy.status === "sent"
        ? { sent: true }
        : {
            sent: false,
            reason:
              "We couldn't email you a copy just now. It's in Billing, under Your agreement, to download whenever you need it.",
          },
  };
}
