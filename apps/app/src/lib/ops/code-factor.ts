/**
 * Which second factor apps/web checked before it set the fresh-code mark
 * (`codeChecked: true`) on an approval decision or a covered-entity answer
 * (lane P7h; owner, 26 October 2026: "They need to be gated by the same
 * single 6-digit passcode"). apps/web checks either the operator's one
 * established approval passcode (HEALDESK_APPROVAL_PASSCODE_HASH) or the
 * authenticator's code, on Vercel, and names which in `codeKind`; apps/app
 * never sees either. Recorded on the act's security event, so the audit
 * trail says who, where, when and with which factor.
 *
 * An absent or unknown value is read as the authenticator: that is what
 * every apps/web deploy before this lane checked, so a request from an older
 * deploy is recorded truly.
 */

export const CODE_FACTORS = ["authenticator", "passcode"] as const;
export type CodeFactor = (typeof CODE_FACTORS)[number];

export function codeFactor(args: Record<string, unknown>): CodeFactor {
  return args.codeKind === "passcode" ? "passcode" : "authenticator";
}
