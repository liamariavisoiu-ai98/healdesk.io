import { adminTotpSecret, claimStep, matchTotpStep, totpStep } from "./totp";

/**
 * A fresh code from the operator's authenticator, asked for again at the
 * moment of one dangerous act: changeClinicEmail (plan Part D5), which moves
 * where a clinic's sign-in links, billing email and agreement notices go. A
 * session alone is not enough for that, so the act carries its own second
 * factor, checked here, on Vercel, against the same secret sign-in uses
 * (lib/admin/totp.ts); nothing about it crosses to apps/app but the signed
 * request that follows a pass.
 *
 * A code is spent in this process's ledger (`claimStep`), the same one
 * sign-in uses, so the code that signed the operator in, or one already
 * used here, is refused until the next one appears. The browser's step
 * cookie is scoped to the sign-in route and never reaches a server action,
 * so what `totp.ts` says about two cold instances holds here too: the
 * session, the password behind it and the act's own audit trail are what
 * stand beside it.
 *
 * Matching and claiming happen in one synchronous turn, with no `await`
 * between them, as sign-in does.
 */

export type FreshCodeCheck = { ok: true } | { ok: false; message: string };

export function checkFreshOperatorCode(code: unknown, now: number = Date.now()): FreshCodeCheck {
  const secret = adminTotpSecret();
  if (!secret.ok) {
    return {
      ok: false,
      message:
        "This deployment has no authenticator secret, so the code can't be checked. Nothing was changed.",
    };
  }
  const offered = typeof code === "string" ? code.replace(/\s/g, "") : "";
  const step = matchTotpStep(secret.key, offered, totpStep(now));
  if (step === null) {
    return {
      ok: false,
      message:
        "That code is not right. Check the clock on your phone and try the next one. Nothing was changed.",
    };
  }
  if (!claimStep(secret.key, step)) {
    return {
      ok: false,
      message: "That code was already used. Wait for the next one. Nothing was changed.",
    };
  }
  return { ok: true };
}
