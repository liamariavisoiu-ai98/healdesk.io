"use server";

import { after } from "next/server";

import { withinSignInRequestLimit } from "@/lib/connections/attempt-limit";
import { describeError, log } from "@/lib/log";
import { requestMeta } from "@/lib/session";
import { looksLikeEmail, normaliseSignInEmail, sendSignInLink } from "@/lib/sign-in/request";

export type SignInFormState =
  | { status: "idle" }
  | { status: "invalid" }
  | { status: "limited" }
  | { status: "sent"; email: string; sentAt: number };

/**
 * The /sign-in form's one action (plan Part D1).
 *
 * Every well-formed request inside the limits gets the same answer, at once,
 * and the lookup and the email happen after the response has gone, in
 * after(): so neither the words nor the time taken say whether the address
 * has an account. The two refusals before that say nothing either: a
 * malformed address is malformed whoever owns it, and the limit counts every
 * address typed, account or not.
 */
export async function requestSignIn(
  _previous: SignInFormState,
  formData: FormData,
): Promise<SignInFormState> {
  const email = normaliseSignInEmail(String(formData.get("email") ?? ""));
  if (!looksLikeEmail(email)) return { status: "invalid" };

  const meta = await requestMeta();
  if (!withinSignInRequestLimit(email, meta.ipAddress ?? null)) return { status: "limited" };

  const next = formData.get("next");
  after(async () => {
    try {
      await sendSignInLink({ email, next: typeof next === "string" ? next : null });
    } catch (error) {
      log.error("sign-in request failed", { error: describeError(error) });
    }
  });
  return { status: "sent", email, sentAt: Date.now() };
}
