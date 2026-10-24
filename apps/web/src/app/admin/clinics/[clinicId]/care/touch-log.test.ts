import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { ClinicHealth } from "@/lib/admin/ops-client";

import { TouchLog } from "./TouchLog";

/**
 * The Care tab's touch log: a health read that failed says so and is never
 * "Touch log — 0"; a clinic outside its first sixty days live has no list
 * and is told why; a clinic with touches lists them. The Record form is
 * offered for every clinic (lane N3), because ten alerts' steps send the
 * operator here whatever the clinic's age or state; apps/app refuses only a
 * closed account, and the card says so.
 */

const NEVER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};

function text(node: React.ReactElement): string {
  return renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const row: ClinicHealth = {
  clinicId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  slug: "radiance",
  name: "Radiance Med Spa",
  plan: null,
  wentLiveOn: "2026-10-11",
  daysLive: 12,
  conversations: { total: 4, last7: 1 },
  recovered: { total: 1, last7: 0 },
  bookings: 1,
  firstRecoveredBookingOn: null,
  lastConversationAt: null,
  recipients: 1,
  forwardingTested: true,
  connected: false,
  usage: null,
  touches: [{ touchedAt: "2026-10-20 10:00 UTC", byLabel: "ops", kind: "call", summary: "Walked through forwarding.", outcome: "will forward tonight" }],
  flags: [],
};

describe("the touch log", () => {
  test("a read that failed is said as such, never as an empty log", () => {
    const page = text(h(TouchLog, { health: { ok: false, code: "unreachable", message: "Could not reach the ops API." }, onTouch: NEVER }));
    expect(page).toContain("Could not read the touch log: Could not reach the ops API.");
    expect(page).not.toContain("Touch log — 0");
    // The form does not need the read: a note can still be recorded.
    expect(page).toContain("Record");
  });

  test("a clinic outside its first sixty days has no list, is told why, and still takes a note", () => {
    const page = text(h(TouchLog, { health: { ok: true, data: null }, onTouch: NEVER }));
    expect(page).toContain("Earlier notes are listed here only in a clinic's first sixty days live.");
    expect(page).toContain("every clinic takes a note until its account is closed");
    expect(page).toContain("What was said (no patient details)");
    expect(page).toContain("Record");
    expect(page).not.toContain("Touch log — 0");
  });

  test("touches are listed and the form offered", () => {
    const page = text(h(TouchLog, { health: { ok: true, data: row }, onTouch: NEVER }));
    expect(page).toContain("Touch log — 1");
    expect(page).toContain("call by ops: Walked through forwarding. → will forward tonight");
    expect(page).toContain("What was said (no patient details)");
    expect(page).toContain("Record");
  });
});
