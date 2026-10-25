import { normaliseReply } from "@/components/admin/support-words";
import type { SupportReplyApprovalItem } from "@/lib/admin/ops-client";

/**
 * The pure half of the case page's Send (lane P7d): which waiting item in
 * the approval inbox is this case's reply, and what the decision carries.
 *
 * An item is the case's when its packet names the case, is still needed
 * (apps/app lib/approvals/support-reply.ts standing: the case open, the
 * reply its current draft, unapproved) and is for the draft version the
 * page holds, so an item left for an older draft is never approved by
 * mistake: apps/app would answer `no_longer_needed` and send nothing, but
 * the owner would have typed a code for nothing.
 *
 * The decision carries the editor's text as the item's edit only when it
 * differs from the draft the item holds, compared as apps/app stores a draft
 * (line breaks normalised, trimmed: lib/support/send.ts normaliseDraftText,
 * lib/approvals/support-reply.ts serialiseDraft); an unchanged reply records
 * no edit. The subject is the item's own, never this app's: the executor
 * refuses any other (`subject_changed`).
 */

/** The line when a proposal went through but the item could not be read back for the decision. */
export const PROPOSED_NOT_READ = "The reply was proposed for your Send, but the waiting item could not be read back. Reload and press Send again.";

/** The line when the text differs from the waiting item's draft and the item's facts could not be read, so no subject is known to carry the edit under. */
export const EDIT_NEEDS_ITEM = "The waiting reply's details could not be read, so an edited text cannot be sent now. Press Save draft first, then Send.";

export function waitingItemFor(items: readonly SupportReplyApprovalItem[], caseId: string, version: number | null): SupportReplyApprovalItem | null {
  return (
    items.find(
      (item) =>
        item.packet !== null &&
        item.packet.facts.caseId === caseId &&
        item.packet.stillNeeded &&
        (version === null || item.packet.facts.draftVersion === version),
    ) ?? null
  );
}

export type SendEdit = { ok: true; edit: { subject: string; body: string } | undefined } | { ok: false; message: string };

/** What the decision carries for this text against this item: nothing when unchanged, the edit when changed, a refusal when it cannot be carried. */
export function sendEdit(item: SupportReplyApprovalItem, body: string): SendEdit {
  const stored = item.packet?.draft ?? null;
  if (stored === null) {
    // No draft read on the item: only an unchanged reply can be approved, and "unchanged" cannot be told. Fail closed.
    return { ok: false, message: EDIT_NEEDS_ITEM };
  }
  return normaliseReply(stored.body) === body ? { ok: true, edit: undefined } : { ok: true, edit: { subject: stored.subject, body } };
}
