import { SENDER_IDENTITY } from "@healdesk/catalog";

import { alignedDkimPass, type Authentication } from "./auth";
import type { InboundNotice } from "./notice";
import type { ParsedMail } from "./parse";

/**
 * The loop guards (lane P7g; design E5 §2.1, "Loop guards"): mail that must
 * never become a case, and never be answered, because answering it is how
 * two robots mail each other forever, or how a bounce of our own reply comes
 * back as a "new request". Each is dropped with a log line naming the reason
 * and SES's id, and no case.
 *
 *   auto_submitted   Auto-Submitted other than "no" (RFC 3834).
 *   precedence       Precedence: bulk, list, junk or auto_reply.
 *   autoreply        X-Autoreply, X-Autorespond or X-Auto-Response-Suppress
 *                    (Exchange's out-of-office and its kin).
 *   list             List-Id or List-Unsubscribe: a mailing list.
 *   report           a delivery or read report (multipart/report,
 *                    message/delivery-status, message/disposition-
 *                    notification): our own bounces and receipts.
 *   own_address      From one of our own addresses or domains: our own mail
 *                    forwarded back in.
 *   no_sender        no usable From address.
 *   spam / virus     SES's scan said FAIL.
 *
 * A provider's forwarding confirmation (Gmail's, from
 * forwarding-noreply@google.com, with a DKIM signature that passed aligned
 * with google.com, so a stranger cannot forge one to keep mail in the bucket)
 * is its own outcome, `provider_confirmation`: no case, and its object is
 * left in the bucket for the owner to read the code in it once, when he sets
 * up forwarding (docs/handover.md, "Inbound support mail"). The sweep deletes
 * it once it is six hours old, and the bucket's one-day lifecycle rule is the
 * backstop behind that. One that is not signed so is an ordinary unmatched
 * email.
 */

export type DropReason =
  | "auto_submitted"
  | "precedence"
  | "autoreply"
  | "list"
  | "report"
  | "own_address"
  | "no_sender"
  | "spam"
  | "virus";

/** The addresses Gmail and Google Workspace send a forwarding confirmation from, and the domain that signs each. */
export const PROVIDER_CONFIRMATION_SENDERS: ReadonlyMap<string, string> = new Map([["forwarding-noreply@google.com", "google.com"]]);

/** Our own domains: mail from any of them is ours, coming back. */
export const OWN_DOMAINS = ["healdesk.io"] as const;

const REPORT_TYPES = ["multipart/report", "message/delivery-status", "message/disposition-notification"];

/** The bare address in "Name <a@b>" or "a@b", lower-cased; null when there is none. */
export function bareAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const angle = /<([^<>\s@]+@[^<>\s@]+)>/.exec(value);
  const plain = angle?.[1] ?? (/^\s*([^\s<>@]+@[^\s<>@]+)\s*$/.exec(value)?.[1] ?? null);
  return plain ? plain.toLowerCase() : null;
}

/**
 * The support aliases of the owner's mailbox (owner, 26 October 2026): a
 * clinic may write to either, and the mailbox forwards both to SES. Mail
 * FROM either is ours coming back (OWN_DOMAINS covers them too; listed so
 * the rule does not rest on the domain alone). A clinic's mail forwarded by
 * the mailbox keeps the clinic's own From, so it is never dropped here.
 */
export const SUPPORT_ADDRESSES = ["support@healdesk.io", "hello@healdesk.io"] as const;

/** Our own sending addresses: hello@, support@ and HEALDESK_EMAIL_FROM's address. */
export function ownAddresses(): Set<string> {
  const own = new Set<string>([SENDER_IDENTITY.replyTo.toLowerCase(), ...SUPPORT_ADDRESSES]);
  const from = bareAddress(process.env.HEALDESK_EMAIL_FROM);
  if (from) own.add(from);
  return own;
}

export function isOwnAddress(address: string): boolean {
  const a = address.toLowerCase();
  if (ownAddresses().has(a)) return true;
  const domain = a.split("@")[1] ?? "";
  return OWN_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function first(mail: ParsedMail, name: string): string | null {
  return mail.headers.get(name)?.[0]?.trim() ?? null;
}

/** Why this message is dropped, or null when it may become a case. */
export function dropReason(mail: ParsedMail, notice: Pick<InboundNotice, "verdicts">): DropReason | null {
  if (notice.verdicts.virus === "FAIL") return "virus";
  if (notice.verdicts.spam === "FAIL") return "spam";
  const auto = first(mail, "auto-submitted");
  if (auto && auto.toLowerCase().split(";")[0]!.trim() !== "no") return "auto_submitted";
  const precedence = first(mail, "precedence")?.toLowerCase() ?? "";
  if (["bulk", "list", "junk", "auto_reply", "auto-reply"].includes(precedence)) return "precedence";
  if (mail.headers.has("x-autoreply") || mail.headers.has("x-autorespond") || mail.headers.has("x-auto-response-suppress")) {
    return "autoreply";
  }
  if (mail.headers.has("list-id") || mail.headers.has("list-unsubscribe")) return "list";
  if (REPORT_TYPES.includes(mail.contentType)) return "report";
  if (!mail.from) return "no_sender";
  if (isOwnAddress(mail.from)) return "own_address";
  return null;
}

/** A provider's forwarding confirmation, signed by the provider's own domain, which the owner reads once from the bucket. */
export function isProviderConfirmation(mail: ParsedMail, auth: Authentication): boolean {
  const signer = mail.from !== null ? PROVIDER_CONFIRMATION_SENDERS.get(mail.from) : undefined;
  return signer !== undefined && auth.verdicts.dkim !== "FAIL" && alignedDkimPass(auth, signer);
}
