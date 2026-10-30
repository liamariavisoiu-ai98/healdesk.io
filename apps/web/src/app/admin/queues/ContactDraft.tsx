"use client";

import { useState, useTransition } from "react";

import { DRAFT_HEADING, EDIT_WORDS, NO_NOTE_WORDS, NOTE_WORDS, PHRASE_WORDS, REMINDER_FIXED_WORDS } from "@/components/admin/approval-words";
import type { ApprovalEditFields, ContactEditable, ContactNote, ContactPacketExtra, ContactPhrase, DraftPreview, OpsResult } from "@/lib/admin/ops-client";

/**
 * An email item's draft on its Approvals card (ops automation lane P6j; the
 * packets are lane P6f's, apps/app lib/approvals/contact-packets.ts): the
 * email exactly as the clinic will read it, the chase's signing link shown
 * as the placeholder apps/app renders until the link is minted at send, and
 * the "Edit" control for the closed fields alone (contact-payloads.ts
 * EDITABLE): a day count for the extension, what a setup notice names, and
 * one approved closing sentence or none. No field takes typed text (owner
 * decision D12): a select offers the list, a number field the range, and
 * apps/app checks each again before anything goes.
 *
 * "Preview" asks apps/app to render the email with the choices as they
 * stand (previewApprovalDraft, a read: it writes nothing) and shows that
 * rendering in the draft's place, or the problems it found. Approve then
 * carries the same choices (the card's `fields`), so what was previewed is
 * what is sent. A reminder has no draft: its wording is the reminder's own.
 */

export type PreviewDraft = (approvalId: string, fields: ApprovalEditFields) => Promise<OpsResult<DraftPreview>>;

export const PREVIEW_STALE = "The choices changed since the last preview: press Preview to see the email with them.";

/** Whether two sets of choices are the same choices. */
export function sameFields(a: ApprovalEditFields, b: ApprovalEditFields): boolean {
  return (a.days ?? null) === (b.days ?? null) && (a.phrase ?? null) === (b.phrase ?? null) && (a.note ?? null) === (b.note ?? null);
}

const LABEL = "text-muted block text-xs font-bold tracking-[0.06em] uppercase";
const FIELD = "border-line mt-1 rounded-sm border bg-white px-3 py-2";

function EditableField({ field, fields, onChange }: { field: ContactEditable; fields: ApprovalEditFields; onChange: (fields: ApprovalEditFields) => void }) {
  if (field.field === "days") {
    return (
      <label className="text-sm">
        <span className={LABEL}>Days ({field.min} to {field.max})</span>
        <input
          type="number"
          name="days"
          min={field.min}
          max={field.max}
          step={1}
          value={fields.days ?? ""}
          onChange={(event) => onChange({ ...fields, days: event.target.value === "" ? undefined : Number(event.target.value) })}
          className={`${FIELD} w-24`}
        />
      </label>
    );
  }
  if (field.field === "phrase") {
    return (
      <label className="text-sm">
        <span className={LABEL}>What the email names</span>
        <select name="phrase" value={fields.phrase ?? field.options[0]} onChange={(event) => onChange({ ...fields, phrase: event.target.value as ContactPhrase })} className={FIELD}>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {PHRASE_WORDS[option]}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="text-sm">
      <span className={LABEL}>Closing sentence</span>
      <select name="note" value={fields.note ?? ""} onChange={(event) => onChange({ ...fields, note: event.target.value === "" ? null : (event.target.value as ContactNote) })} className={FIELD}>
        <option value="">{NO_NOTE_WORDS}</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {NOTE_WORDS[option]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ContactDraft({
  approvalId,
  contact,
  fields,
  onFieldsChange,
  onPreview,
}: {
  approvalId: string;
  contact: ContactPacketExtra;
  fields: ApprovalEditFields;
  onFieldsChange: (fields: ApprovalEditFields) => void;
  onPreview: PreviewDraft;
}) {
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<{ fields: ApprovalEditFields; draft: { subject: string; body: string } } | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [pending, start] = useTransition();

  if (contact.draft === null) return <p className="mt-3 text-sm">{REMINDER_FIXED_WORDS}</p>;

  const stored = contact.fields ?? {};
  const previewed = preview !== null && sameFields(preview.fields, fields);
  const draft = previewed ? preview.draft : contact.draft;
  const changed = !sameFields(stored, fields);

  function runPreview(): void {
    start(async () => {
      setProblems(null);
      const result = await onPreview(approvalId, fields);
      if (!result.ok) {
        setProblems([result.message]);
        return;
      }
      if (result.data.status === "preview") {
        setPreview({ fields, draft: result.data.draft });
        return;
      }
      setProblems(result.data.status === "problems" ? result.data.problems : [result.data.message]);
    });
  }

  return (
    <div className="border-line mt-3 rounded-sm border bg-paper-2/40 p-4 text-sm">
      <p className="text-muted text-xs font-bold tracking-[0.06em] uppercase">{DRAFT_HEADING}</p>
      <p className="mt-2 font-semibold">{draft.subject}</p>
      <pre className="mt-2 font-sans whitespace-pre-wrap">{draft.body}</pre>
      {changed && !previewed ? (
        <p role="status" className="mt-2 font-semibold">
          {PREVIEW_STALE}
        </p>
      ) : null}
      {contact.editable.length > 0 ? (
        <div className="border-line mt-3 border-t pt-3">
          {editing ? (
            <form className="grid gap-3" onSubmit={(event) => event.preventDefault()}>
              <p className="text-muted">{EDIT_WORDS}</p>
              <div className="flex flex-wrap items-end gap-3">
                {contact.editable.map((field) => (
                  <EditableField key={field.field} field={field} fields={fields} onChange={onFieldsChange} />
                ))}
                <button
                  type="button"
                  disabled={pending}
                  onClick={runPreview}
                  className="border-line-strong hover:border-ink inline-flex min-h-9 items-center rounded-full border px-4 py-1.5 text-sm font-bold transition-colors disabled:opacity-50"
                >
                  {pending ? "Working…" : "Preview"}
                </button>
              </div>
              {problems ? (
                <ul role="status" className="text-red-deep grid gap-0.5 font-semibold">
                  {problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              ) : null}
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="border-line-strong hover:border-ink inline-flex min-h-9 items-center rounded-full border px-4 py-1.5 text-sm font-bold transition-colors"
            >
              Edit
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
