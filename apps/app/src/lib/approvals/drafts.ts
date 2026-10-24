import { copyProblems, linkProblems, subjectProblems } from "@/lib/email/lint";

import { draftHash } from "./kinds";

/**
 * An email kind's draft, and the owner's edit of it (design E6 §2, "Edit"):
 * the plumbing every later email kind uses (the BAA chase, the agreement
 * question, the editable reminders), built and tested now with a test-only
 * kind, because no kind in this lane carries a draft.
 *
 * A draft is a subject and a body, stored as one JSON string with its
 * SHA-256. An edit is linted again exactly as a first draft is (the subject
 * rules, the copy lint, the link scanner), and both hashes are kept: the one
 * the owner approved and, once the email kind's executor sends it, the one
 * sent. Nothing about the text crosses into the record but the hashes.
 */

export type Draft = { subject: string; body: string };

const MAX_SUBJECT = 200;
const MAX_BODY = 10_000;

export function serialiseDraft(draft: Draft): string {
  return JSON.stringify({ subject: draft.subject, body: draft.body });
}

export function parseDraft(raw: unknown): Draft | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  if (Object.keys(d).sort().join(",") !== "body,subject") return null;
  if (typeof d.subject !== "string" || typeof d.body !== "string") return null;
  const subject = d.subject.replace(/\s+/g, " ").trim();
  const body = d.body.replace(/\r\n?/g, "\n").trim();
  if (!subject || !body || subject.length > MAX_SUBJECT || body.length > MAX_BODY) return null;
  return { subject, body };
}

/** What the lint refuses in a draft: one reason per problem, empty when it may go. */
export function draftProblems(draft: Draft, emailKind?: string): string[] {
  return [
    ...subjectProblems(draft.subject),
    ...copyProblems(`${draft.subject}\n${draft.body}`),
    ...linkProblems({ subject: draft.subject, text: draft.body, html: "" }, emailKind),
  ];
}

export type DraftDecision =
  | { ok: true; draft: Draft | null; hashApproved: string | null; edited: boolean }
  | { ok: false; code: "no_draft_kind" | "draft_unreadable" | "draft_refused"; problems: string[] };

/**
 * The draft an approval sends: the stored one, or the owner's edit after the
 * lint passes it. A kind without a draft takes no edit; an edit identical to
 * the stored draft is not an edit.
 */
export function decideDraft(
  hasDraft: boolean,
  stored: { draft: string | null; draftHash: string | null },
  editedDraft: unknown,
  emailKind?: string,
): DraftDecision {
  if (!hasDraft) {
    return editedDraft === undefined || editedDraft === null
      ? { ok: true, draft: null, hashApproved: null, edited: false }
      : { ok: false, code: "no_draft_kind", problems: [] };
  }
  const original = parseDraft(stored.draft);
  if (!original || !stored.draftHash) return { ok: false, code: "draft_unreadable", problems: [] };
  if (editedDraft === undefined || editedDraft === null) {
    return { ok: true, draft: original, hashApproved: stored.draftHash, edited: false };
  }
  const edit = parseDraft(editedDraft);
  if (!edit) return { ok: false, code: "draft_unreadable", problems: [] };
  const problems = draftProblems(edit, emailKind);
  if (problems.length > 0) return { ok: false, code: "draft_refused", problems };
  const hash = draftHash(serialiseDraft(edit));
  return { ok: true, draft: edit, hashApproved: hash, edited: hash !== stored.draftHash };
}
