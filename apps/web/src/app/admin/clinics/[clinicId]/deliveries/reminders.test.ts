import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { ClinicBillingView, LifecycleWave, OpsResult } from "@/lib/admin/ops-client";

import { mergeReminders, outcomeWords, Reminders, waveWords } from "./Reminders";

/**
 * The Deliveries tab's "Reminders" section (wave 2, lane A3): the clinic's
 * reminders from the outbox merged with the lifecycle watch's waves so a
 * send is listed once and the list is whole with the watch off; every wave
 * key apps/app can produce in words, never a code; newest first; the
 * watch's absence said in one line only while it has added nothing; a
 * failed read said as such.
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

type Notice = ClinicBillingView["notices"][number];
function notice(over: Partial<Notice>): Notice {
  return { kind: "setup_reminder", createdAt: "2026-10-07 09:00 UTC", sendAfter: "2026-10-07 09:00 UTC", sentAt: "2026-10-07 09:01 UTC", attempts: 1, recipientsCount: 1, lastError: null, ...over };
}

function billingWith(notices: Notice[]): OpsResult<ClinicBillingView> {
  return { ok: true, data: { notices } } as unknown as OpsResult<ClinicBillingView>;
}

const waves: LifecycleWave[] = [
  wave({}),
  wave({ id: "6c5b4d3e-2f10-4b0c-9d8e-7f6a5b4c3d2e", wave: "setup_reminder:2", queuedAt: "2026-10-12T09:00:00.000Z", sentAt: "2026-10-12T09:01:00.000Z", outcome: "bounced" }),
  wave({ id: "7d6c5e4f-3a21-4c1d-8e9f-8a7b6c5d4e3f", wave: "wait_4h:2026-10-14T10:00:00Z", target: "slack", queuedAt: "2026-10-14T14:00:00.000Z", sentAt: null, outcome: "skipped", skippedBecause: "snoozed", stage: "waiting_on_us" }),
  wave({ id: "8e7d6f50-4b32-4d2e-9fa0-9b8c7d6e5f40", wave: "day_22:2026-10-24", target: "ops_email", queuedAt: "2026-10-24T07:00:00.000Z", sentAt: "2026-10-24T07:00:30.000Z", outcome: "sent", escalated: true, manualBy: "ops@healdesk.test" }),
];

describe("the reminders ledger", () => {
  test("one line per wave, newest first, in words", () => {
    const html = renderToStaticMarkup(h(Reminders, { waves: { ok: true, data: waves }, billing: billingWith([]) }));
    const page = text(html);
    expect(html).toContain('id="reminders"');
    expect(page).toContain("Reminders — 4");
    expect(page).toContain("The clinic's six setup reminders are in this list, with every wave sent to ops about it.");
    expect(page).not.toContain("once the lifecycle watch is switched on");
    const order = ["Decision alert, day 22", "Waiting-on-us alert, 4 hours", "Setup reminder 2 of 6", "Setup reminder 1 of 6"].map((w) => page.indexOf(w));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(page).toContain("Setup reminder 1 of 6 to the clinic 2026-10-07 09:01 UTC delivered");
    expect(page).toContain("Setup reminder 2 of 6 to the clinic 2026-10-12 09:01 UTC bounced");
    expect(page).toContain("Waiting-on-us alert, 4 hours to Slack 2026-10-14 14:00 UTC snoozed");
    expect(page).toContain("Decision alert, day 22 to ops email 2026-10-24 07:00 UTC sent escalated sent by hand by ops@healdesk.test");
    expect(page).not.toMatch(/@radiance|Dear|Hello/);
  });

  test("with the watch off, the outbox's reminders are the list, and the watch's absence is one line", () => {
    const html = renderToStaticMarkup(
      h(Reminders, {
        waves: { ok: true, data: [] },
        billing: billingWith([
          notice({}),
          notice({ createdAt: "2026-10-12 09:00 UTC", sendAfter: "2026-10-12 09:00 UTC", sentAt: null, attempts: 3, lastError: "Resend answered 500" }),
          notice({ kind: "invoice_paid", createdAt: "2026-10-11 09:00 UTC" }),
        ]),
      }),
    );
    const page = text(html);
    expect(page).toContain("Reminders — 2");
    expect(page).toContain("Ops alerts about this clinic's setup appear here once the lifecycle watch is switched on.");
    expect(page).toContain("Setup reminder to the clinic 2026-10-12 09:00 UTC not sent yet due 2026-10-12 09:00 UTC · 3 attempts · Resend answered 500");
    expect(page).toContain("Setup reminder to the clinic 2026-10-07 09:00 UTC sent sent 2026-10-07 09:01 UTC · 1 attempt");
    expect(page).not.toContain("invoice_paid");
    expect(page.indexOf("2026-10-12")).toBeLessThan(page.indexOf("2026-10-07"));
  });

  test("a reminder the watch recorded is listed once, from its wave; one it did not is listed from the outbox", () => {
    const lines = mergeReminders(
      [wave({})],
      [notice({}), notice({ createdAt: "2026-10-12 09:00 UTC", sendAfter: "2026-10-12 09:00 UTC", sentAt: "2026-10-12 09:01 UTC" })],
    );
    expect(lines.map((l) => [l.words, l.at])).toEqual([
      ["Setup reminder", "2026-10-12T09:00:00.000Z"],
      ["Setup reminder 1 of 6", "2026-10-07T09:01:00.000Z"],
    ]);
    // A notice queued nine minutes from its wave is the same send; eleven minutes is not.
    expect(mergeReminders([wave({ queuedAt: "2026-10-07T09:09:00.000Z" })], [notice({})])).toHaveLength(1);
    expect(mergeReminders([wave({ queuedAt: "2026-10-07T09:11:00.000Z" })], [notice({})])).toHaveLength(2);
  });

  test("every wave key apps/app produces has words, and an unknown one is 'Other alert', never the key", () => {
    const cases: [string, boolean, string][] = [
      ["setup_reminder:1", false, "Setup reminder 1 of 6"],
      ["setup_reminder:6", false, "Setup reminder 6 of 6"],
      ["setup_reminder:live:voice+web", false, "Setup reminder after a channel went live"],
      ["day_7", false, "No-progress alert, day 7"],
      ["day_15", false, "No-progress alert, day 15"],
      ["day_22:2026-11-13", true, "Decision alert, day 22"],
      ["day_22:2026-11-13", false, "Closing-soon alert, day 22"],
      ["day_27:2026-11-13", true, "Decision alert, day 27"],
      ["day_30:2026-11-13", false, "Closing-soon alert, day 30"],
      ["wait_4h:2026-10-14T10:00:00Z", false, "Waiting-on-us alert, 4 hours"],
      ["wait_1bd:2026-10-14T10:00:00Z", false, "Waiting-on-us alert, 1 business day"],
      ["wait_2bd:2026-10-14T10:00:00Z", false, "Waiting-on-us alert, 2 business days"],
      ["wait_close_27:2026-11-13", true, "Closing warning while waiting on us, day 27"],
      ["wait_close_30:2026-11-13", true, "Closing warning while waiting on us, day 30"],
      ["live_7:2026-10-14T10:00:00Z", false, "Channel still waiting, 7 days after going live"],
      ["live_14:2026-10-14T10:00:00Z", false, "Channel still waiting, 14 days after going live"],
      ["undelivered:none", true, "Undelivered-reminder alert"],
      ["unanswered:never", true, "Reminders-unanswered alert"],
      ["something_new:1", false, "Other alert"],
    ];
    for (const [key, escalated, words] of cases) expect(waveWords(key, escalated), key).toBe(words);
    expect(waveWords("something_new:1")).not.toContain("something_new");
    expect(outcomeWords(wave({ outcome: "skipped", skippedBecause: "snoozed" })).words).toBe("snoozed");
    expect(outcomeWords(wave({ outcome: "skipped", skippedBecause: "let_close" })).words).toBe("skipped: let it close");
    expect(outcomeWords(wave({ outcome: "failed" }))).toEqual({ words: "failed", tone: "bad" });
  });

  test("an empty ledger and failed reads are each said as such", () => {
    const empty = text(renderToStaticMarkup(h(Reminders, { waves: { ok: true, data: [] }, billing: billingWith([]) })));
    expect(empty).toContain("No reminder sent yet.");
    const failed = { ok: false as const, code: "failed" as const, message: "Could not reach the ops API." };
    const both = text(renderToStaticMarkup(h(Reminders, { waves: failed, billing: failed })));
    expect(both).toContain("Could not read the ops waves: Could not reach the ops API.");
    expect(both).toContain("Could not read the setup reminders in the outbox: Could not reach the ops API.");
    expect(both).not.toContain("Reminders — 0");
    expect(both).not.toContain("No reminder sent yet.");
    const half = text(renderToStaticMarkup(h(Reminders, { waves: failed, billing: billingWith([notice({})]) })));
    expect(half).toContain("Could not read the ops waves");
    expect(half).toContain("Setup reminder to the clinic");
  });
});
