import { NOTE_WORDS, PHRASE_WORDS } from "@/components/admin/approval-words";
import type { ApprovalEditFields, ContactNote, ContactPhrase, IncidentReportChoices } from "@/lib/admin/ops-client";

import type { ApprovalEdit } from "./ApprovalDecision";

/**
 * What the Queues page's decide action accepts beside a decision (lane
 * P6j): an email item's closed fields, or a report's choices, as the card
 * sent them, checked here before the step-up wrapper is asked for the code.
 * The fields are apps/app's own range and lists (lib/approvals/
 * contact-payloads.ts: a whole day count from 1 to 30, a phrase from
 * PHRASES, a note from NOTES or none), so a browser that sends anything
 * else is refused in a sentence, and no typed text can ride along (owner
 * decision D12). A report's choices are checked key by key against the
 * catalog's lists by the ops client before they are sent
 * (lib/admin/ops-client.ts incidentChoicesArgs), so here they need only be
 * an object; anything else is refused the same way. Pure.
 */

export const EDIT_MIN_DAYS = 1;
export const EDIT_MAX_DAYS = 30;

export type CheckedEdit = { ok: true; edit: ApprovalEdit | undefined } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function checkApprovalEdit(raw: unknown): CheckedEdit {
  if (raw === undefined || raw === null) return { ok: true, edit: undefined };
  if (!isRecord(raw)) return { ok: false, message: "The choices could not be read. Nothing was sent." };
  if ("incident" in raw) {
    if (Object.keys(raw).length !== 1 || !isRecord(raw.incident)) return { ok: false, message: "The report's choices could not be read. Nothing was sent." };
    return { ok: true, edit: { incident: raw.incident as unknown as IncidentReportChoices } };
  }
  if (!("fields" in raw) || Object.keys(raw).length !== 1 || !isRecord(raw.fields)) {
    return { ok: false, message: "The choices could not be read. Nothing was sent." };
  }
  const f = raw.fields;
  const out: ApprovalEditFields = {};
  for (const key of Object.keys(f)) {
    if (key === "days") {
      const d = f.days;
      if (typeof d !== "number" || !Number.isInteger(d) || d < EDIT_MIN_DAYS || d > EDIT_MAX_DAYS) {
        return { ok: false, message: `The days must be a whole number from ${EDIT_MIN_DAYS} to ${EDIT_MAX_DAYS}. Nothing was sent.` };
      }
      out.days = d;
    } else if (key === "phrase") {
      if (typeof f.phrase !== "string" || !Object.hasOwn(PHRASE_WORDS, f.phrase)) {
        return { ok: false, message: "What the email names must be one of the listed parts of setup. Nothing was sent." };
      }
      out.phrase = f.phrase as ContactPhrase;
    } else if (key === "note") {
      if (f.note !== null && (typeof f.note !== "string" || !Object.hasOwn(NOTE_WORDS, f.note))) {
        return { ok: false, message: "The closing sentence must be one of the approved ones, or none. Nothing was sent." };
      }
      out.note = f.note as ContactNote | null;
    } else {
      return { ok: false, message: "Only the days, what the email names and the closing sentence can change. Nothing was sent." };
    }
  }
  return { ok: true, edit: { fields: out } };
}
