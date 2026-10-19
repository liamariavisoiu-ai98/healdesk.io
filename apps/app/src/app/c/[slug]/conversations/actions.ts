"use server";

import {
  confirmClinicExport,
  exportClinicRecords,
  exportPersonRecords,
  isDayChip,
  MIN_SEARCH_DIGITS,
  MIN_SEARCH_LETTERS,
  parseSearch,
  readConversationList,
  sendTranscriptAgain,
  type ConversationListItem,
  type ExportResult,
} from "@/lib/portal/conversations";
import { requirePatientPage } from "@/lib/portal/patient-page";

/**
 * Conversations' server actions (plan Part F4): the search and the day
 * chips, "Send again", the two exports, and a closed clinic's report that
 * its whole export arrived. Each calls requirePatientPage
 * itself, so each needs this session's live passkey step-up (without one,
 * Next follows the redirect to the step-up page), and each read, resend and
 * export writes its access-log row naming the passkey, in the transaction
 * that does it (lib/portal/conversations.ts).
 *
 * The search runs here rather than in the page's URL: a name or a number in
 * a query string would sit in the browser's history and the host's request
 * logs.
 */

export type FindResult =
  { ok: true; rows: ConversationListItem[] } | { ok: false; message: string };

export async function findConversationsAction(
  slug: string,
  input: { q?: unknown; day?: unknown },
): Promise<FindResult> {
  const page = await requirePatientPage(String(slug));
  const search = parseSearch(input?.q);
  if (search.kind === "too_short") {
    return {
      ok: false,
      message: `Type at least ${MIN_SEARCH_DIGITS} digits of a number, or ${MIN_SEARCH_LETTERS} letters of a name.`,
    };
  }
  const day = isDayChip(input?.day) ? input.day : null;
  const rows = await readConversationList(page, { search, day });
  return { ok: true, rows };
}

export type SendAgainActionResult = { ok: boolean; message: string };

export async function sendAgainAction(
  slug: string,
  conversationId: string,
): Promise<SendAgainActionResult> {
  const page = await requirePatientPage(String(slug));
  const result = await sendTranscriptAgain(page, String(conversationId));
  switch (result.status) {
    case "queued":
      return {
        ok: true,
        message:
          "Sending again to your clinic's address. It goes within a minute or two, and this page shows when your mail server confirms it.",
      };
    case "open":
      return {
        ok: false,
        message: "That chat is still going. Its transcript is emailed when it ends.",
      };
    case "delivered":
      return {
        ok: false,
        message: "Your mail server confirmed this one, so healdesk no longer holds a copy to send.",
      };
    case "gone":
      return {
        ok: false,
        message: "healdesk no longer holds a copy of this transcript, so it can't be sent again.",
      };
    case "not_found":
      return { ok: false, message: "No transcript was emailed for this conversation." };
  }
}

export type ExportActionResult =
  | {
      ok: true;
      filename: string;
      body: string;
      message: string;
      /** After cancellation: send it back with the file's digest (confirmExportAction). */
      receipt: string | null;
    }
  | { ok: false; message: string };

function exported(result: ExportResult, done: string): ExportActionResult {
  if (result.ok) {
    return {
      ok: true,
      filename: result.filename,
      body: result.body,
      message: done,
      receipt: result.receipt,
    };
  }
  switch (result.reason) {
    case "destroyed":
      return {
        ok: false,
        message: "Your records have been deleted, so there is nothing left to export.",
      };
    case "no_details":
      return {
        ok: false,
        message: "This conversation names no one in your records, so there is no one to export.",
      };
    case "requester":
      return { ok: false, message: "Choose who asked for the export." };
    case "not_found":
      return { ok: false, message: "That conversation isn't here any more. Reload the page." };
  }
}

export async function exportAllAction(slug: string): Promise<ExportActionResult> {
  const page = await requirePatientPage(String(slug));
  const result = await exportClinicRecords(page);
  return exported(result, "Export downloaded. Your clinic's address gets an email saying so.");
}

export type ConfirmExportActionResult = { ok: boolean; message: string };

/**
 * After cancellation: the browser saved the whole export, and reports it with
 * the receipt the export came with and the SHA-256 of the file it received.
 * A match records the export as delivered; anything else records nothing.
 */
export async function confirmExportAction(
  slug: string,
  receipt: string,
  digest: string,
): Promise<ConfirmExportActionResult> {
  const page = await requirePatientPage(String(slug));
  const result = await confirmClinicExport(page, receipt, digest);
  if (result.ok) {
    return {
      ok: true,
      message:
        "Export downloaded in full, and recorded as delivered. Your clinic's address gets an email saying so.",
    };
  }
  switch (result.reason) {
    case "incomplete":
      return {
        ok: false,
        message:
          "The export didn't arrive in full, so it isn't recorded as delivered. Download it again.",
      };
    case "destroyed":
      return {
        ok: false,
        message: "Your records have been deleted, so there is nothing left to export.",
      };
    case "open":
      return { ok: true, message: "Export downloaded. Your clinic's address gets an email saying so." };
  }
}

export async function exportPersonAction(
  slug: string,
  conversationId: string,
  requestedBy: string,
): Promise<ExportActionResult> {
  const page = await requirePatientPage(String(slug));
  const result = await exportPersonRecords(page, String(conversationId), requestedBy);
  return exported(result, "Export downloaded. Your clinic's address gets an email saying so.");
}
