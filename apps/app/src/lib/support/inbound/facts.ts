import { createHmac, hkdfSync } from "node:crypto";

import { findClinicalContent } from "@healdesk/catalog";

import { env } from "@/lib/env";

import { EMAIL_MASK, NUMBER_MASK, screenText, TREATMENT_MASK, type ScreenAllow } from "../screen";
import type { Classification } from "./classify";
import type { InboundNotice, Verdict } from "./notice";
import type { AttachmentClass, ParsedMail } from "./parse";

/**
 * What an inbound email becomes (lane P7g): facts from fixed lists and small
 * numbers, and nothing the clinic wrote. Pure apart from the sender key.
 *
 *   - the screen's COUNTS: the support chat's screen (screen.ts) run on the
 *     subject and the body in memory, numbers and addresses that are not the
 *     practice's own, and treatment names; and the catalog's clinical
 *     patterns (findClinicalContent). Only how many; never which. Any count
 *     above zero sets phi_suspected on the case;
 *   - the ATTACHMENTS: how many, by class (image, pdf, other), and the total
 *     size in a bucket. Never a name: a file name is often a patient's;
 *   - SES's VERDICTS, as SES's own words (from its notice, or from the
 *     headers SES wrote at the top of the message: auth.ts), and whether the
 *     sender was authenticated;
 *   - the SENDER's reference: an HMAC of the lower-cased address, so the
 *     hour's mail from one address can be counted. Its key is derived from
 *     HEALDESK_IDENTIFIER_REF_KEY under its own label, so it is never equal
 *     to any identifier reference lib/identifier-ref.ts makes.
 */

export type ScreenCounts = { numbers: number; emails: number; treatments: number; clinical: number };

export type AttachmentSummary = {
  count: number;
  image: number;
  pdf: number;
  other: number;
  size: "none" | "under_1mb" | "under_5mb" | "under_10mb" | "over_10mb";
};

function occurrences(text: string, mask: string): number {
  let n = 0;
  for (let at = text.indexOf(mask); at !== -1; at = text.indexOf(mask, at + mask.length)) n += 1;
  return n;
}

/** The screen's counts over the subject and the body. The text itself is dropped here. */
export function screenCounts(subject: string, body: string, allow: ScreenAllow): ScreenCounts {
  const text = `${subject}\n${body}`;
  const screened = screenText(text, allow);
  const before = (mask: string) => occurrences(text.normalize("NFC"), mask);
  const numbers = Math.max(0, occurrences(screened.text, NUMBER_MASK) - before(NUMBER_MASK));
  const emails = Math.max(0, occurrences(screened.text, EMAIL_MASK) - before(EMAIL_MASK));
  const treatments = Math.max(0, occurrences(screened.text, TREATMENT_MASK) - before(TREATMENT_MASK));
  const clinical = findClinicalContent({ subject, body }, { conditions: true }).length;
  return { numbers, emails, treatments, clinical };
}

export function phiSuspected(counts: ScreenCounts): boolean {
  return counts.numbers + counts.emails + counts.treatments + counts.clinical > 0;
}

const MB = 1024 * 1024;

export function sizeBucket(bytes: number, any: boolean): AttachmentSummary["size"] {
  if (!any) return "none";
  if (bytes < MB) return "under_1mb";
  if (bytes < 5 * MB) return "under_5mb";
  if (bytes < 10 * MB) return "under_10mb";
  return "over_10mb";
}

export function attachmentSummary(attachments: readonly { kind: AttachmentClass; bytes: number }[]): AttachmentSummary | null {
  if (attachments.length === 0) return null;
  const by = (k: AttachmentClass) => attachments.filter((a) => a.kind === k).length;
  const total = attachments.reduce((n, a) => n + a.bytes, 0);
  return { count: attachments.length, image: by("image"), pdf: by("pdf"), other: by("other"), size: sizeBucket(total, true) };
}

/** The sender as the hour's count knows it: lower case, a "+tag" taken off the local part (for matching only). */
export function matchingAddress(address: string): string {
  const [local = "", domain = ""] = address.trim().toLowerCase().split("@");
  return `${local.split("+")[0]}@${domain}`;
}

const SENDER_INFO = "healdesk.support-sender.v1";
let derived: { secret: string; key: Buffer } | null = null;

/** The sender's reference: 64 hex characters, the same for the same address, nothing to read back. */
export function senderRef(address: string): string {
  const secret = env.identifierRefKey();
  if (derived?.secret !== secret) {
    derived = { secret, key: Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), SENDER_INFO, 32)) };
  }
  return createHmac("sha256", derived.key).update(matchingAddress(address), "utf8").digest("hex");
}

/** A count as the message's fields keep it: a word of digits, never three in a row (0125's fields CHECK). */
export function cappedCount(n: number): string {
  return n > 99 ? "99+" : String(Math.max(0, Math.floor(n)));
}

export type MatchedBy = "ref" | "thread" | "address" | "closed_account" | "none";

/**
 * The inbound message's fields: every value a word from a fixed list or a
 * capped count (support_messages_fields_check: no '@', no three digits).
 */
export function messageFields(input: {
  classification: Classification;
  matchedBy: MatchedBy;
  counts: ScreenCounts;
  verdicts: InboundNotice["verdicts"];
  oversize: boolean;
  acknowledged: "queued" | "not_matched" | "already" | "rate_limited" | "not_authenticated";
  senderMatchesCase: boolean | null;
  /** An aligned DKIM pass or a DMARC pass (auth.ts). */
  authenticated: boolean;
  /** From the case's clinic: its authenticated sign-in. Only such an email is threaded under (threading.ts). */
  fromClinic: boolean;
}): Record<string, string> {
  const v = (x: Verdict) => x.toLowerCase();
  return {
    source: "email",
    topic: input.classification.topic,
    symptom: input.classification.symptom,
    urgency: input.classification.urgency,
    security: input.classification.security ? "yes" : "no",
    matchedBy: input.matchedBy,
    senderMatchesCase: input.senderMatchesCase === null ? "unknown" : input.senderMatchesCase ? "yes" : "no",
    hiddenNumbers: cappedCount(input.counts.numbers),
    hiddenEmails: cappedCount(input.counts.emails),
    hiddenTreatments: cappedCount(input.counts.treatments),
    clinicalMatches: cappedCount(input.counts.clinical),
    oversize: input.oversize ? "yes" : "no",
    spam: v(input.verdicts.spam),
    virus: v(input.verdicts.virus),
    spf: v(input.verdicts.spf),
    dkim: v(input.verdicts.dkim),
    dmarc: v(input.verdicts.dmarc),
    acknowledgement: input.acknowledged,
    authenticated: input.authenticated ? "yes" : "no",
    fromClinic: input.fromClinic ? "yes" : "no",
  };
}

/** The parsed mail's subject and body, for the screen and the classifier only. */
export function wordsOf(mail: ParsedMail): { subject: string; body: string } {
  return { subject: mail.subject, body: mail.body };
}
