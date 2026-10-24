import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { MachineQueue, OpsResult, StuckCalendarWrites, StuckCalendarWriteView, UndeliveredTranscriptClinicView } from "@/lib/admin/ops-client";

import { Attention, BeingWatched, writesByClinic } from "./Attention";

/**
 * The System page's "Requires your attention" and "Being watched" sections
 * (Phase 5, lane P5b): the queues past their patience in words with the age
 * of the oldest, linked where apps/app's href is not this section; the stuck
 * writes by clinic with the oldest problem; the undelivered transcript
 * copies by clinic; "Nothing needs you here." when nothing does; a part not
 * read named and never a zero; the fine queues as counts. Every anchor Home
 * links to is rendered.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const OTHER = "7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a";
const APPT = "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a";
const SELF = "/admin/system#attention";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function queue(key: string, over: Partial<MachineQueue> = {}): MachineQueue {
  return { key, words: key, count: 0, oldestAgeMinutes: null, needsAttention: false, tone: "ok", href: SELF, lowerBound: false, ...over };
}

const queues: OpsResult<{ queues: MachineQueue[]; partial: string[] }> = {
  ok: true,
  data: {
    queues: [
      queue("outbox", { words: "Emails waiting to send", count: 3, oldestAgeMinutes: 125, needsAttention: true, tone: "warn" }),
      queue("outbox_dead", {
        words: "Emails to clinics that gave up after every attempt, in the last 7 days",
        count: 1,
        oldestAgeMinutes: 30,
        needsAttention: true,
        tone: "warn",
        href: `/admin/clinics/${CLINIC}/deliveries`,
      }),
      queue("pgboss_failed:ops-slack", { words: "Background jobs failed in ops-slack", count: 2, oldestAgeMinutes: 3 * 24 * 60, needsAttention: true, tone: "warn", href: "/admin/system/jobs" }),
      // A clinic could not be read: the count is a floor.
      queue("billing_requests_stuck", { words: "Billing requests not done", count: 5, oldestAgeMinutes: 70, needsAttention: true, tone: "warn", lowerBound: true }),
      queue("transcript_emails", { words: "Transcript copies waiting for delivery", count: 4, oldestAgeMinutes: 80 * 60, lowerBound: true }),
      queue("outbox_fine", { words: "Emails waiting to send today", count: 0 }),
      queue("billing_events_parked", { words: "Stripe events parked", count: 0 }),
    ],
    partial: [],
  },
};

const write = (clinicId: string, over: Partial<StuckCalendarWriteView> = {}): StuckCalendarWriteView => ({
  clinicId,
  clinicName: clinicId === CLINIC ? "Radiance Med Spa" : "Other Clinic",
  appointmentId: APPT,
  status: "unknown",
  reason: "timeout",
  attempts: 2,
  nextAttemptAt: null,
  slotInDays: 3,
  retryable: true,
  ...over,
});

const writes: OpsResult<StuckCalendarWrites> = {
  ok: true,
  data: {
    // Newest problem first, as apps/app sends them: Radiance's oldest is the one that gave up.
    writes: [write(CLINIC), write(OTHER, { status: "failed", reason: "api_disabled", retryable: false }), write(CLINIC, { attempts: 5, retryable: false })],
    count: 3,
    truncated: false,
    unreadClinics: 0,
  },
};

const transcripts: OpsResult<{ clinics: UndeliveredTranscriptClinicView[]; unreadClinics: number }> = {
  ok: true,
  data: {
    clinics: [
      { clinicId: CLINIC, clinicName: "Radiance Med Spa", counts: { overdue: 1, bounced: 0, expired: 2, unconfirmed: 0 }, oldestAgeHours: 80 },
      { clinicId: OTHER, clinicName: "Other Clinic", counts: { overdue: 0, bounced: 1, expired: 0, unconfirmed: 1 }, oldestAgeHours: null },
    ],
    unreadClinics: 0,
  },
};

const EMPTY_QUEUES: typeof queues = { ok: true, data: { queues: [queue("outbox", { words: "Emails waiting to send" }), queue("transcript_emails", { words: "Transcript copies not delivered", count: 2, oldestAgeMinutes: 60 })], partial: [] } };
const EMPTY_WRITES: typeof writes = { ok: true, data: { writes: [], count: 0, truncated: false, unreadClinics: 0 } };
const EMPTY_TRANSCRIPTS: typeof transcripts = { ok: true, data: { clinics: [], unreadClinics: 0 } };

describe("Requires your attention", () => {
  test("the queues past their patience: words, count, how long the oldest waited; a link only where the href is not this section", () => {
    const html = renderToStaticMarkup(h(Attention, { queues, writes, transcripts }));
    const page = text(html);
    expect(html).toContain('id="attention"');
    expect(page).toContain("Requires your attention");
    expect(page).toContain("Emails waiting to send 3 oldest waiting 2 hours");
    expect(page).toContain("Emails to clinics that gave up after every attempt, in the last 7 days 1 oldest waiting 30 minutes");
    expect(page).toContain("Background jobs failed in ops-slack 2 oldest waiting 3 days");
    // A count some clinic is missing from reads "at least".
    expect(page).toContain("Billing requests not done at least 5 oldest waiting 1 hour");
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/deliveries"`);
    expect(html).toContain('href="/admin/system/jobs"');
    expect(html).not.toContain(`href="${SELF}"`);
    // The fine queues are not here, and the transcript queue is never a row here (it has its own list below).
    expect(page).not.toContain("Emails waiting to send today");
    expect(page).not.toContain("Transcript copies waiting for delivery");
    expect(page).not.toContain("Nothing needs you here.");
  });

  test("Calendar writes stuck: one row per clinic with the count and how many the sweep will not retry, linking to its Setup tab's section", () => {
    const html = renderToStaticMarkup(h(Attention, { queues, writes, transcripts }));
    const page = text(html);
    expect(html).toContain('id="calendar-writes"');
    expect(page).toContain("Calendar writes stuck");
    expect(page).toContain("Radiance Med Spa 2 stuck, 1 will not be retried by itself");
    expect(page).toContain("Other Clinic 1 stuck, 1 will not be retried by itself");
    // Not an age: "oldest gave up after 5 tries" read as one.
    expect(page).not.toContain("oldest gave up");
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/setup#calendar-writes"`);
    expect(page).not.toContain("Counts are of the first");
    expect(writesByClinic(writes.ok ? writes.data.writes : []).map((c) => [c.clinicName, c.writes.length])).toEqual([
      ["Radiance Med Spa", 2],
      ["Other Clinic", 1],
    ]);
    const cut = renderToStaticMarkup(h(Attention, { queues, writes: { ok: true, data: { ...writes.data, count: 140, truncated: true } }, transcripts }));
    expect(text(cut)).toContain("Counts are of the first 3 read; 140 stuck writes were found in all, so a clinic may have more, or be missing here.");
    expect(cut).toMatch(/<p role="status" class="text-red-deep[^"]*">Counts are of the first/);
  });

  test("Transcript copies not delivered: one row per clinic in Home's words for the states, with the oldest held copy's age, linking to its Deliveries tab", () => {
    const html = renderToStaticMarkup(h(Attention, { queues, writes, transcripts }));
    const page = text(html);
    expect(html).toContain('id="transcripts"');
    expect(page).toContain("Transcript copies not delivered");
    expect(page).toContain("Radiance Med Spa 1 waiting more than 72 hours, 2 deleted unsent after 30 days oldest held copy queued 3 days ago");
    expect(page).toContain("Other Clinic 1 bounced, 1 deleted after 72 hours with no answer from the mail service");
    for (const old of ["overdue", "expired", "unconfirmed", "0 bounced"]) expect(page).not.toContain(old);
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/deliveries"`);
    expect(html).toContain(`href="/admin/clinics/${OTHER}/deliveries"`);
  });

  test("nothing needing a person is one line, with no sub-heading and no zero", () => {
    const html = renderToStaticMarkup(h(Attention, { queues: EMPTY_QUEUES, writes: EMPTY_WRITES, transcripts: EMPTY_TRANSCRIPTS }));
    const page = text(html);
    expect(page).toContain("Nothing needs you here.");
    expect(page).not.toContain("Calendar writes stuck");
    expect(page).not.toContain("Transcript copies not delivered");
    expect(page).not.toContain(" 0 ");
    expect(html).toContain('id="attention"');
  });

  test("the two anchors the alerts link to are in the page even when their lists are empty, as empty blocks", () => {
    // An alert's "Open System" lands on #calendar-writes or #transcripts; with
    // nothing listed the link must still land in this section, not at the top.
    const html = renderToStaticMarkup(h(Attention, { queues: EMPTY_QUEUES, writes: EMPTY_WRITES, transcripts: EMPTY_TRANSCRIPTS }));
    expect(html).toContain('<div id="calendar-writes" class="scroll-mt-24"></div>');
    expect(html).toContain('<div id="transcripts" class="scroll-mt-24"></div>');
    expect(text(html)).toBe("Requires your attention Nothing needs you here.");
    // With lists, the same ids wrap the sub-heading and its rows.
    const full = renderToStaticMarkup(h(Attention, { queues, writes, transcripts }));
    expect(full).toMatch(/<div id="calendar-writes" class="scroll-mt-24"><h3[^>]*>Calendar writes stuck<\/h3>/);
    expect(full).toMatch(/<div id="transcripts" class="scroll-mt-24"><h3[^>]*>Transcript copies not delivered<\/h3>/);
  });

  test("a part that could not be read is named and is never a zero, and 'Nothing needs you here' is not claimed", () => {
    const partial = text(
      renderToStaticMarkup(
        h(Attention, {
          queues: { ok: true, data: { queues: EMPTY_QUEUES.ok ? EMPTY_QUEUES.data.queues : [], partial: ["Stripe events", "2 clinic(s)"] } },
          writes: { ok: true, data: { writes: [], count: 0, truncated: false, unreadClinics: 1 } },
          transcripts: { ok: true, data: { clinics: [], unreadClinics: 3 } },
        }),
      ),
    );
    expect(partial).toContain("Stripe events could not be read.");
    expect(partial).toContain("2 clinic(s) could not be read.");
    expect(partial).toContain("1 clinic(s) could not be read for stuck calendar writes.");
    expect(partial).toContain("3 clinic(s) could not be read for transcript copies.");
    expect(partial).not.toContain("Nothing needs you here.");
    expect(partial).not.toContain("Stripe events parked 0");
  });

  test("a whole read that failed says so once, under its own heading, and the rest still draw", () => {
    const failed = { ok: false as const, code: "failed" as const, message: "The machine queues could not be read." };
    const html = renderToStaticMarkup(h(Attention, { queues: failed, writes: { ...failed, message: "The stuck writes could not be read." }, transcripts: { ...failed, message: "The copies could not be read." } }));
    const page = text(html);
    expect(page).toContain("Could not read the machine queues: The machine queues could not be read.");
    expect(page).toContain("Calendar writes stuck Could not read the stuck calendar writes: The stuck writes could not be read.");
    expect(page).toContain("Transcript copies not delivered Could not read the undelivered transcript copies: The copies could not be read.");
    expect(page).not.toContain("Nothing needs you here.");
    expect(renderToStaticMarkup(h(BeingWatched, { queues: failed }))).toBe("");
  });
});

describe("Being watched", () => {
  test("the queues that are fine, name and count ('at least' when a clinic is missing), including the transcript queue and the zeros read in full; not those needing a person", () => {
    const page = text(renderToStaticMarkup(h(BeingWatched, { queues })));
    expect(page).toContain("Being watched");
    expect(page).toContain("Transcript copies waiting for delivery at least 4");
    expect(page).toContain("Emails waiting to send today 0");
    expect(page).toContain("Stripe events parked 0");
    expect(page).not.toContain("Emails waiting to send 3");
    expect(page).not.toContain("Background jobs failed");
    expect(page).not.toContain("Billing requests not done");
  });

  test("when every queue read needs a person it says they are above, never that nothing was read; an empty read says that", () => {
    const allAbove = { ok: true as const, data: { queues: [queue("outbox", { words: "Emails waiting to send", count: 3, needsAttention: true })], partial: [] } };
    const page = text(renderToStaticMarkup(h(BeingWatched, { queues: allAbove })));
    expect(page).toContain("Every queue read is listed above.");
    expect(page).not.toContain("No queue was read in full.");
    expect(text(renderToStaticMarkup(h(BeingWatched, { queues: { ok: true, data: { queues: [], partial: ["Stripe events"] } } })))).toContain("No queue was read in full.");
  });
});
