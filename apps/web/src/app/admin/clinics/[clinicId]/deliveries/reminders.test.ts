import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { LifecycleWave } from "@/lib/admin/ops-client";

import { outcomeWords, Reminders, waveWords } from "./Reminders";

/**
 * The Deliveries tab's "Reminders" section (wave 2, lane A3): one line per
 * reminder or ops wave, newest first, with what, to whom, when and the
 * outcome in apps/app's words (a snoozed skip reads "snoozed"); the sentence
 * that the clinic's six setup reminders are in it; an empty ledger and a
 * failed read each said as such.
 */

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function wave(over: Partial<LifecycleWave>): LifecycleWave {
  return {
    id: "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
    stage: "in_setup",
    wave: "setup_reminder:1",
    target: "clinic_email",
    queuedAt: "2026-10-07T09:00:00.000Z",
    sentAt: "2026-10-07T09:01:00.000Z",
    outcome: "delivered",
    providerId: null,
    escalated: false,
    manualBy: null,
    skippedBecause: null,
    ...over,
  };
}

const waves: LifecycleWave[] = [
  wave({}),
  wave({ id: "6c5b4d3e-2f10-4b0c-9d8e-7f6a5b4c3d2e", wave: "setup_reminder:2", queuedAt: "2026-10-12T09:00:00.000Z", sentAt: "2026-10-12T09:01:00.000Z", outcome: "bounced" }),
  wave({ id: "7d6c5e4f-3a21-4c1d-8e9f-8a7b6c5d4e3f", wave: "wait_4h:2026-10-14T10:00:00Z", target: "slack", queuedAt: "2026-10-14T14:00:00.000Z", sentAt: null, outcome: "skipped", skippedBecause: "snoozed", stage: "waiting_on_us" },
  ),
  wave({ id: "8e7d6f50-4b32-4d2e-9fa0-9b8c7d6e5f40", wave: "day_22:2026-10-24", target: "ops_email", queuedAt: "2026-10-24T07:00:00.000Z", sentAt: "2026-10-24T07:00:30.000Z", outcome: "sent", escalated: true, manualBy: "ops@healdesk.test" }),
];

describe("the reminders ledger", () => {
  test("one line per wave, newest first, in words, with the six-reminders sentence", () => {
    const html = renderToStaticMarkup(h(Reminders, { waves: { ok: true, data: waves } }));
    const page = text(html);
    expect(html).toContain('id="reminders"');
    expect(page).toContain("Reminders — 4");
    expect(page).toContain("The clinic's six setup reminders are in this list, with every wave sent to ops about it.");
    const order = ["Day-22 decision alert", "Waiting-on-us alert (4 hours)", "Setup reminder 2 of 6", "Setup reminder 1 of 6"].map((w) => page.indexOf(w));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(page).toContain("Setup reminder 1 of 6 to the clinic 2026-10-07 09:01 UTC delivered");
    expect(page).toContain("Setup reminder 2 of 6 to the clinic 2026-10-12 09:01 UTC bounced");
    expect(page).toContain("Waiting-on-us alert (4 hours) to Slack 2026-10-14 14:00 UTC snoozed");
    expect(page).toContain("Day-22 decision alert to ops email 2026-10-24 07:00 UTC sent escalated sent by hand by ops@healdesk.test");
    // Receipts without words: no address, no body.
    expect(page).not.toMatch(/@radiance|Dear|Hello/);
  });

  test("the words for keys and outcomes", () => {
    expect(waveWords("setup_reminder:6")).toBe("Setup reminder 6 of 6");
    expect(waveWords("day_22:2026-11-13")).toBe("Day-22 decision alert");
    expect(waveWords("wait_4h:2026-10-14T10:00:00Z")).toBe("Waiting-on-us alert (4 hours)");
    expect(waveWords("closing_soon")).toBe("Closing soon");
    expect(outcomeWords(wave({ outcome: "skipped", skippedBecause: "snoozed" })).words).toBe("snoozed");
    expect(outcomeWords(wave({ outcome: "skipped", skippedBecause: "let_close" })).words).toBe("skipped: let it close");
    expect(outcomeWords(wave({ outcome: "failed" }))).toEqual({ words: "failed", tone: "bad" });
  });

  test("an empty ledger and a failed read are each said as such", () => {
    expect(text(renderToStaticMarkup(h(Reminders, { waves: { ok: true, data: [] } })))).toContain("No reminder or ops wave yet.");
    const failed = text(renderToStaticMarkup(h(Reminders, { waves: { ok: false, code: "failed", message: "Could not reach the ops API." } })));
    expect(failed).toContain("Could not read the reminders: Could not reach the ops API.");
    expect(failed).not.toContain("Reminders — 0");
  });
});
