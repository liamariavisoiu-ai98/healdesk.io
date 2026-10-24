import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { OpsResult, TranscriptDeliveriesView } from "@/lib/admin/ops-client";
import { TRANSCRIPT_STATUSES, transcriptWindow } from "@/lib/admin/transcript-status";

import { LABELS, TranscriptsPanel } from "./TranscriptsPanel";

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const CONVERSATION = (n: number) => `7c9e6679-7425-40de-944b-e07fc1f9${String(n).padStart(4, "0")}`;
const noResend = async () => ({ ok: true as const, data: { status: "gone" as const } });

function render(view: OpsResult<TranscriptDeliveriesView>): string {
  return renderToStaticMarkup(createElement(TranscriptsPanel, { clinicId: CLINIC, days: 30, view, resend: noResend }));
}

const counts = Object.fromEntries(TRANSCRIPT_STATUSES.map((s) => [s, 0])) as TranscriptDeliveriesView["counts"];

describe("the transcript receipts page", () => {
  test("?days= is one of the offered windows or 30, whatever it carries", () => {
    expect(transcriptWindow("7")).toBe(7);
    expect(transcriptWindow(["90", "7"])).toBe(90);
    expect(transcriptWindow("7.0")).toBe(7);
    for (const raw of [undefined, "", "abc", "365", "-7", "0", ["x"]]) expect(transcriptWindow(raw)).toBe(30);
  });

  test("every status has words, and the copy keeps the engine's 72 hours and 30 days", () => {
    for (const status of TRANSCRIPT_STATUSES) expect(LABELS[status].name.length).toBeGreaterThan(0);
    expect(LABELS.unconfirmed.note).toMatch(/72 hours/);
    expect(LABELS.expired.note).toMatch(/30 days/);
  });

  test("Send again appears only where a sealed copy still exists", () => {
    const receipts = TRANSCRIPT_STATUSES.map((status, i) => ({
      conversationId: CONVERSATION(i),
      status,
      sentAt: null,
      deliveredAt: null,
      attempts: 0,
    }));
    const html = render({ ok: true, data: { sinceDays: 30, counts, receipts } });
    expect(html.match(/<button[^>]*>Send again<\/button>/g)).toHaveLength(3);
  });

  test("an out-of-date engine and a failed read say so, in words", () => {
    expect(render({ ok: false, code: "outdated", message: "x" })).toMatch(/older than this page/);
    expect(render({ ok: false, code: "failed", message: "Could not reach the ops API." })).toMatch(/Could not reach the ops API/);
  });
});
