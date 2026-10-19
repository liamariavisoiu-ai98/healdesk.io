"use server";

import { after } from "next/server";

import { withinSignInHelpLimit } from "@/lib/connections/attempt-limit";
import { describeError, log } from "@/lib/log";
import { requestMeta } from "@/lib/session";
import { parseSignInHelp, runSignInHelp, type SignInHelpField } from "@/lib/sign-in/help";

export type SignInHelpState =
  | { status: "idle" }
  | { status: "invalid"; field: SignInHelpField; message: string }
  | { status: "limited" }
  | { status: "received" };

/**
 * /sign-in/help's one action (plan Part D5).
 *
 * Every well-formed request inside the limits gets the same answer, at once:
 * "If the details match, we've sent a link to the clinic's address". The
 * lookup, the check with Stripe and any email happen after the response has
 * gone, in after(), so neither the words nor the time taken say whether the
 * address has an account or the detail matched. The two refusals before that
 * say nothing either: a malformed field is malformed whoever asks, and the
 * limits count every address typed, account or not.
 */
export async function requestSignInHelp(
  _previous: SignInHelpState,
  formData: FormData,
): Promise<SignInHelpState> {
  const parsed = parseSignInHelp({
    email: formData.get("email"),
    clinic: formData.get("clinic"),
    kind: formData.get("kind"),
    last4: formData.get("last4"),
    expiry: formData.get("expiry"),
    invoice: formData.get("invoice"),
  });
  if (!parsed.ok) return { status: "invalid", field: parsed.field, message: parsed.message };

  const meta = await requestMeta();
  if (!withinSignInHelpLimit(parsed.request.email, meta.ipAddress ?? null)) {
    return { status: "limited" };
  }

  after(async () => {
    try {
      await runSignInHelp(parsed.request, {
        ipAddress: meta.ipAddress ?? undefined,
        userAgent: meta.userAgent ?? undefined,
      });
    } catch (error) {
      log.error("sign-in help failed", { error: describeError(error) });
    }
  });
  return { status: "received" };
}
