import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { composeClinicRows, filterClinicRows, type ClinicRow } from "@/lib/admin/clinic-rows";
import type { ClinicCards, ClinicHealth, OpsClinics, OpsResult } from "@/lib/admin/ops-client";
import type { ClinicStripRow } from "@/lib/admin/strip-types";

import { ClinicFilters, ClinicTable } from "./ClinicTable";

/**
 * /admin/clinics, rendered as the operator sees it (E1 steps 1 and 2): one
 * row per clinic with a chip per column, the name a link to the panel and
 * each chip a link to the tab that owns it; a column the strip has not
 * filled says "not measured yet" and is never a good or bad state; synthetic
 * clinics are behind their own filter. Fixtures as in account-copy.test.ts's
 * clinic cards, which this table replaces.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const DEMO = "7a2c1d0f-9e3b-4e42-8d88-2b3c4d5e6f70";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const clinics: OpsResult<OpsClinics> = {
  ok: true,
  data: {
    connectionStateLimit: 50,
    clinics: [
      {
        id: CLINIC,
        name: "Radiance Med Spa",
        specialty: "med-spa",
        timezone: "America/New_York",
        dataClassification: "production",
        attributionMode: "estimated",
        isCoveredEntity: null,
        baaSignedOn: null,
        blockers: [{ level: "blocked", message: "Covered-entity status not determined." }],
        connection: "unknown",
      },
      {
        // A paying clinic still in setup: classed "synthetic" until go-live (the BAA gate), not a demo.
        id: DEMO,
        name: "Quiet Clinic",
        specialty: "med-spa",
        timezone: "America/New_York",
        dataClassification: "synthetic",
        attributionMode: "estimated",
        isCoveredEntity: false,
        baaSignedOn: null,
        blockers: [{ level: "attention", message: "Synthetic only — not yet accepting real patient data." }],
        connection: "unknown",
      },
    ],
  },
};

const cards: OpsResult<ClinicCards> = {
  ok: true,
  data: {
    limit: 50,
    cards: [
      {
        id: CLINIC,
        agreementKind: "dpa",
        agreementLabel: "Data protection agreement",
        channels: [
          { channel: "web", status: "live" },
          { channel: "voice", status: "waiting" },
        ],
        tracker: [
          { id: "agreement", label: "Agreement signed", state: "done" },
          { id: "built", label: "Assistant built", state: "not_done" },
        ],
        trackerLeft: ["Assistant built"],
      },
      {
        id: DEMO,
        agreementKind: null,
        agreementLabel: "No agreement",
        channels: [{ channel: "web", status: "setting_up" }],
        tracker: [],
        trackerLeft: [],
      },
    ],
  },
};

const health: OpsResult<ClinicHealth[]> = {
  ok: true,
  data: [
    {
      clinicId: CLINIC,
      slug: "radiance",
      name: "Radiance Med Spa",
      plan: "AYA Voice, 500 minutes",
      wentLiveOn: "2026-10-11",
      daysLive: 12,
      conversations: { total: 40, last7: 9 },
      recovered: { total: 3, last7: 1 },
      bookings: 4,
      firstRecoveredBookingOn: null,
      lastConversationAt: null,
      recipients: 1,
      forwardingTested: true,
      connected: false,
      usage: {
        voiceMinutesUsed: 460,
        voiceMinutesIncluded: 500,
        chatUsed: 20,
        chatIncluded: 300,
        voicePercent: 92,
        chatPercent: 7,
        resetsOn: "2026-11-11",
        overageMode: "allow",
        clinicEmailed: true,
      },
      touches: [],
      flags: ["near_allowance"],
    },
  ],
};

const strip: OpsResult<ClinicStripRow[]> = {
  ok: true,
  data: [
    {
      // The strip alone says which clinic is a demo (apps/app's app_clinic_is_demo).
      clinicId: DEMO,
      name: "Quiet Clinic",
      synthetic: true,
      stage: { kind: "setup", day: 4, of: 30, deadlineAt: "2026-11-18T00:00:00.000Z" },
      channels: { web: "waiting", meta: "off", voice: "off" },
      availability: null,
      calendar: "none",
      voice: "not_provisioned",
      transcripts: { waiting: 0, bounced: 0 },
      usage: { percent: null, meter: null },
      lastReminder: null,
      blocking: null,
    },
    {
      clinicId: CLINIC,
      name: "Radiance Med Spa",
      synthetic: false,
      stage: { kind: "live", since: "2026-10-11T09:00:00.000Z" },
      channels: { web: "live", meta: "off", voice: "waiting" },
      availability: { changedAt: "2026-10-20T10:00:00.000Z", audit: "fail" },
      calendar: "broken",
      voice: "drift",
      transcripts: { waiting: 2, bounced: 1 },
      usage: { percent: 92, meter: "voice" },
      lastReminder: { day: null },
      blocking: "Covered-entity status not determined.",
    },
  ],
};

describe("the clinic rows", () => {
  test("from the existing reads alone: stage, channels, blocking and first-weeks usage, and the rest not measured yet", () => {
    const rows = composeClinicRows({ clinics, cards, health, strip: null });
    const radiance = rows.find((r) => r.clinicId === CLINIC)!;
    expect(radiance.stage).toEqual({ kind: "live", day: null, of: null, deadlineAt: null, since: "2026-10-11" });
    expect(radiance.channels).toEqual({ web: "live", meta: "off", voice: "waiting" });
    expect(radiance.blocking).toBe("Covered-entity status not determined.");
    expect(radiance.usage).toEqual({ percent: 92, meter: "voice" });
    expect(radiance.availability).toBeNull();
    expect(radiance.calendar).toBeNull();
    expect(radiance.voice).toBeNull();
    expect(radiance.transcripts).toBeNull();
    expect(radiance.lastReminder).toBeNull();
    expect(radiance.attention).toBe(true);

    // A clinic classed "synthetic" by dataClassification is NOT a demo: it is in setup, and it shows.
    const quiet = rows.find((r) => r.clinicId === DEMO)!;
    expect(quiet.synthetic).toBe(false);
    expect(quiet.stage?.kind).toBe("setup");
    expect(quiet.stage?.day).toBeNull();
    expect(quiet.usage).toBeNull();
    // An attention-level blocker is neither Blocking nor Attention.
    expect(quiet.blocking).toBeNull();
    expect(quiet.attention).toBe(false);
  });

  test("the strip fills the rest and wins where both say something", () => {
    const rows = composeClinicRows({ clinics, cards, health, strip });
    const radiance = rows.find((r) => r.clinicId === CLINIC)!;
    expect(radiance.availability).toEqual({ changedAt: "2026-10-20T10:00:00.000Z", audit: "fail" });
    expect(radiance.calendar).toBe("broken");
    expect(radiance.voice).toBe("drift");
    expect(radiance.transcripts).toEqual({ waiting: 2, bounced: 1 });
    expect(radiance.lastReminder).toEqual({ day: null });
    expect(radiance.stage?.since).toBe("2026-10-11T09:00:00.000Z");
    const quiet = rows.find((r) => r.clinicId === DEMO)!;
    expect(quiet.synthetic).toBe(true);
    expect(quiet.stage).toEqual({ kind: "setup", day: 4, of: 30, deadlineAt: "2026-11-18T00:00:00.000Z", since: null });
  });

  test("a read that failed costs its columns, never the list", () => {
    const rows = composeClinicRows({
      clinics,
      cards: { ok: false, code: "failed", message: "Could not reach the ops API." },
      health: undefined,
      strip: { ok: false, code: "failed", message: "x" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.stage).toBeNull();
    expect(rows[0]?.channels).toBeNull();
    expect(composeClinicRows({ clinics: { ok: false, code: "unreachable", message: "x" }, cards, health, strip })).toEqual([]);
  });

  test("without the strip no clinic is synthetic: a paying clinic in setup shows under All and Setting up", () => {
    const rows = composeClinicRows({ clinics, cards, health, strip: null });
    expect(filterClinicRows(rows, "all").map((r) => r.clinicId)).toEqual([CLINIC, DEMO]);
    expect(filterClinicRows(rows, "setup").map((r) => r.clinicId)).toEqual([DEMO]);
    expect(filterClinicRows(rows, "synthetic")).toEqual([]);
    expect(filterClinicRows(rows, "live").map((r) => r.clinicId)).toEqual([CLINIC]);
    // Attention is the blocked clinic, not the one carrying the setup-stage attention blocker.
    expect(filterClinicRows(rows, "attention").map((r) => r.clinicId)).toEqual([CLINIC]);
  });

  test("with the strip, a clinic it flags synthetic is hidden by default and shown under Synthetic", () => {
    const rows = composeClinicRows({ clinics, cards, health, strip });
    expect(filterClinicRows(rows, "all").map((r) => r.clinicId)).toEqual([CLINIC]);
    expect(filterClinicRows(rows, "setup")).toEqual([]);
    expect(filterClinicRows(rows, "synthetic").map((r) => r.clinicId)).toEqual([DEMO]);
  });

  test("Attention is a blocked blocker or a warning chip from the strip, never the attention-level blocker alone", () => {
    const quietOnly: OpsResult<OpsClinics> = { ok: true, data: { connectionStateLimit: 50, clinics: [clinics.data.clinics[1]!] } };
    const calm = composeClinicRows({ clinics: quietOnly, cards, health, strip: null });
    expect(calm[0]?.attention).toBe(false);
    expect(calm[0]?.blocking).toBeNull();
    const drifting = composeClinicRows({ clinics: quietOnly, cards, health, strip: { ok: true, data: [{ ...strip.data[0]!, voice: "drift" }] } });
    expect(drifting[0]?.attention).toBe(true);
    expect(drifting[0]?.blocking).toBeNull();
  });
});

describe("the clinic table", () => {
  const rows: ClinicRow[] = composeClinicRows({ clinics, cards, health, strip });

  test("each row is chips linking to their tabs, the name a link to the panel, the id selectable", () => {
    const html = renderToStaticMarkup(h(ClinicTable, { rows: filterClinicRows(rows, "all"), filter: "all", stripRead: true }));
    const page = text(html);
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/setup"`);
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/deliveries"`);
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/billing"`);
    expect(html).toContain(`<code class="font-mono select-all">${CLINIC}</code>`);
    expect(page).toContain("live since 2026-10-11");
    expect(page).toContain("changed, audit ✗");
    expect(page).toContain("broken");
    expect(page).toContain("drift");
    expect(page).toContain("1 undelivered, 2 waiting");
    expect(page).toContain("92% voice");
    expect(page).toContain("Covered-entity status not determined.");
    // The same rows twice: a table from 640 px and cards under it.
    expect(html).toContain("<table");
    expect(html).toContain('class="mt-4 grid gap-3 sm:hidden"');
    expect(page).not.toContain("Quiet Clinic");
    expect(page).not.toContain("not measured yet");
  });

  test("while the strip is not read, its columns are a dash explained once in a legend, never six muted chips a row", () => {
    const partial = composeClinicRows({ clinics, cards, health, strip: null });
    const html = renderToStaticMarkup(h(ClinicTable, { rows: filterClinicRows(partial, "all"), filter: "all", stripRead: false }));
    const page = text(html);
    expect(page.match(/not measured yet/g)?.length).toBe(1);
    expect(page).toContain("— means not measured yet");
    expect(html.match(/aria-label="not measured yet"/g)?.length).toBeGreaterThanOrEqual(10);
    const chips = html.match(/<a href="[^"]+" class="[^"]*">/g) ?? [];
    // Red appears only for the blocking line, not for a column nobody measured.
    expect(chips.filter((c) => c.includes("text-red-deep"))).toEqual([]);
  });

  test("with the strip read, a null it sends is a 'not measured yet' chip, as its contract says", () => {
    const html = renderToStaticMarkup(h(ClinicTable, { rows: filterClinicRows(rows, "synthetic"), filter: "synthetic", stripRead: true }));
    // Quiet Clinic's availability and last reminder are null from the strip; the table and the cards each draw them.
    expect(text(html).match(/not measured yet/g)?.length).toBe(4);
  });

  test("an empty list says which empty, and the Synthetic filter says it is not measured until the strip lands", () => {
    expect(text(renderToStaticMarkup(h(ClinicTable, { rows: [], filter: "all", stripRead: false })))).toContain("No clinics. They appear here once someone completes checkout.");
    expect(text(renderToStaticMarkup(h(ClinicTable, { rows: [], filter: "paused", stripRead: true })))).toBe("No clinics under &quot;Paused&quot;.");
    expect(text(renderToStaticMarkup(h(ClinicTable, { rows: [], filter: "synthetic", stripRead: false })))).toContain("Which clinics are synthetic is not measured yet");
  });

  test("the filter chips carry their counts and mark the current one; Synthetic says 'not measured yet' until the strip lands", () => {
    const html = renderToStaticMarkup(
      h(ClinicFilters, { counts: { all: 1, setup: 0, live: 1, paused: 0, attention: 1, synthetic: 1 }, current: "live", stripRead: true }),
    );
    expect(html).toContain('href="/admin/clinics?filter=synthetic"');
    expect(html).toMatch(/aria-current="page"[^>]*>Live/);
    expect(text(html)).toContain("Synthetic 1");
    const unread = text(renderToStaticMarkup(h(ClinicFilters, { counts: { all: 2, setup: 1, live: 1, paused: 0, attention: 1, synthetic: 0 }, current: "all", stripRead: false })));
    expect(unread).toContain("Synthetic not measured yet");
    expect(unread).not.toContain("Synthetic 0");
  });
});
