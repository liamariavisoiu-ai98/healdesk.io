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
        id: DEMO,
        name: "Demo Clinic",
        specialty: "med-spa",
        timezone: "America/New_York",
        dataClassification: "synthetic",
        attributionMode: "estimated",
        isCoveredEntity: false,
        baaSignedOn: null,
        blockers: [],
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

    const demo = rows.find((r) => r.clinicId === DEMO)!;
    expect(demo.synthetic).toBe(true);
    expect(demo.stage?.kind).toBe("setup");
    expect(demo.stage?.day).toBeNull();
    expect(demo.usage).toBeNull();
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

  test("synthetic clinics are hidden unless their filter is chosen", () => {
    const rows = composeClinicRows({ clinics, cards, health, strip: null });
    expect(filterClinicRows(rows, "all").map((r) => r.clinicId)).toEqual([CLINIC]);
    expect(filterClinicRows(rows, "synthetic").map((r) => r.clinicId)).toEqual([DEMO]);
    expect(filterClinicRows(rows, "live").map((r) => r.clinicId)).toEqual([CLINIC]);
    expect(filterClinicRows(rows, "attention").map((r) => r.clinicId)).toEqual([CLINIC]);
    expect(filterClinicRows(rows, "setup")).toEqual([]);
  });
});

describe("the clinic table", () => {
  const rows: ClinicRow[] = composeClinicRows({ clinics, cards, health, strip });

  test("each row is chips linking to their tabs, the name a link to the panel, the id selectable", () => {
    const html = renderToStaticMarkup(h(ClinicTable, { rows: filterClinicRows(rows, "all"), filter: "all" }));
    const page = text(html);
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/setup"`);
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/deliveries"`);
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/billing"`);
    expect(html).toContain(`<code class="font-mono select-all">${CLINIC}</code>`);
    expect(page).toContain("live since 2026-10-11");
    expect(page).toContain("changed, audit ✗");
    expect(page).toContain("broken");
    expect(page).toContain("drift");
    expect(page).toContain("1 bounced, 2 waiting");
    expect(page).toContain("92% voice");
    expect(page).toContain("Covered-entity status not determined.");
    // The same rows twice: a table from 640 px and cards under it.
    expect(html).toContain("<table");
    expect(html).toContain('class="mt-4 grid gap-3 sm:hidden"');
    expect(page).not.toContain("Demo Clinic");
  });

  test("a column the strip has not filled says so, in the muted tone, and is never red", () => {
    const partial = composeClinicRows({ clinics, cards, health, strip: null });
    const html = renderToStaticMarkup(h(ClinicTable, { rows: filterClinicRows(partial, "all"), filter: "all" }));
    expect(text(html).match(/not measured yet/g)?.length).toBeGreaterThanOrEqual(5);
    const chips = html.match(/<a href="[^"]+" class="[^"]*">/g) ?? [];
    const red = chips.filter((c) => c.includes("text-red-deep"));
    // Red appears only for the blocking line, not for a column nobody measured.
    expect(red).toEqual([]);
  });

  test("an empty list says which empty", () => {
    expect(text(renderToStaticMarkup(h(ClinicTable, { rows: [], filter: "all" })))).toBe("No clinics. They appear here once someone completes checkout.");
    expect(text(renderToStaticMarkup(h(ClinicTable, { rows: [], filter: "paused" })))).toBe("No clinics under &quot;Paused&quot;.");
  });

  test("the filter chips carry their counts and mark the current one", () => {
    const html = renderToStaticMarkup(
      h(ClinicFilters, { counts: { all: 1, setup: 0, live: 1, paused: 0, attention: 1, synthetic: 1 }, current: "live" }),
    );
    expect(html).toContain('href="/admin/clinics?filter=synthetic"');
    expect(html).toMatch(/aria-current="page"[^>]*>Live/);
    expect(text(html)).toContain("Synthetic 1");
  });
});
