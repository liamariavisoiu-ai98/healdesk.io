/**
 * The support reply item's kind and payload (ops automation lane P7c), apart
 * from ./support-reply.ts so lib/approvals/kinds.ts can parse a payload
 * without loading the send path. Pure.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SUPPORT_REPLY_KIND = "support_reply_send" as const;

export function isSupportReplyKind(kind: string): kind is typeof SUPPORT_REPLY_KIND {
  return kind === SUPPORT_REPLY_KIND;
}

/** The proposer when the support side proposes a passing draft by itself. */
export const SUPPORT_PROPOSER = "support-drafts";

export type SupportReplyApprovalPayload = {
  caseId: string;
  messageId: string;
  draftVersion: number;
  /** The case's ref, bare ("7F3KQ"). */
  ref: string;
};

const REF = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/;

export function parseSupportReplyPayload(raw: unknown): SupportReplyApprovalPayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (Object.keys(p).sort().join(",") !== "caseId,draftVersion,messageId,ref") return null;
  if (typeof p.caseId !== "string" || !UUID.test(p.caseId)) return null;
  if (typeof p.messageId !== "string" || !UUID.test(p.messageId)) return null;
  if (typeof p.draftVersion !== "number" || !Number.isSafeInteger(p.draftVersion) || p.draftVersion < 1) return null;
  if (typeof p.ref !== "string" || !REF.test(p.ref)) return null;
  return p as SupportReplyApprovalPayload;
}

/** "<reply row id>:v<version>": one item per reply and version. */
export function supportReplySubjectRef(messageId: string, draftVersion: number): string {
  return `${messageId}:v${draftVersion}`;
}

