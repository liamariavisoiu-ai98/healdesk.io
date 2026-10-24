import type { FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  canonicalHours,
  changeStatusLine,
  cleanSummary,
  clinicActorOf,
  recordClinicChange,
  runClinicChangeAlerts,
} from "@/lib/clinic/change-events";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { retireOtherAccountProviders, saveProviders } from "@/lib/connections/google-calendar";
import { slackFields } from "@/lib/ops/slack";
import { saveKnowledge } from "@/lib/portal/knowledge";
import { saveHours } from "@/lib/setup/practice";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import {
  DESK_TZ,
  deskLocation,
  freshGoogle,
  installGoogleEnv,
  restoreGoogleEnv,
  type DeskLocation,
} from "./setup/desk-calendar";
import { inTenant, seedPortalUser } from "./setup/factories";

/**
 * Lane B, E4-1 and E4-2: a clinic's change to its hours, closed days or
 * providers is recorded in the save's own transaction (one row per kind
 * changed, counts and dates only), nothing is recorded for a save that is
 * refused or rolls back, and ops hears of it once per clinic and kind an
 * hour, from the sweep, after the change committed. Synthetic data only.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const SLOW = 120_000;
const ACTOR = { type: "service", serviceName: "clinic-change-test" } as const;
const EVERY_DAY = Object.fromEntries(
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["08:00", "20:00"]]]),
);
const DEVICE = "Front desk iPad";

function dayAfter(days: number): string {
  return clinicLocalDate(new Date(Date.now() + days * 86_400_000), DESK_TZ);
}

type ChangeRow = {
  kind: string;
  source: string;
  actor_kind: string;
  summary: Record<string, unknown>;
  alerted_at: Date | null;
  audit_status: string | null;
};

async function changes(clinicId: string): Promise<ChangeRow[]> {
  return inTenant(clinicId, async (c) =>
    (
      await c.query<ChangeRow>(
        `select kind, source, actor_kind, summary, alerted_at, audit_status
           from clinic_change_events order by changed_at, id`,
      )
    ).rows,
  );
}

async function alerts(clinicId: string): Promise<{ fields: Record<string, unknown>; repeats: number }[]> {
  return (
    await getMigratorPool().query<{ fields: Record<string, unknown>; repeats: number }>(
      `select fields, repeats from ops_alerts
        where event = 'clinic_availability_changed' and fields->>'clinicId' = $1`,
      [clinicId],
    )
  ).rows;
}

describe("the change summary and the clinic's status line", () => {
  test("a summary keeps counts, dates and a flag, and nothing else", () => {
    expect(
      cleanSummary({
        closuresAdded: ["2026-11-26", "Thanksgiving", "2026-11-26"],
        closuresRemoved: [],
        providersActive: 2,
        holdsReleased: -1,
        weeklyChanged: true,
        ...({ label: "Thanksgiving", name: "Dr Lee" } as object),
      }),
    ).toEqual({ closuresAdded: ["2026-11-26"], closuresRemoved: [], providersActive: 2, weeklyChanged: true });
  });

  test("in use since a time today, or a day before today; nothing about ops' audit", () => {
    const now = new Date("2026-10-23T20:00:00Z");
    expect(changeStatusLine(null, DESK_TZ, now)).toBeNull();
    expect(changeStatusLine({ changedAt: new Date("2026-10-23T18:14:00Z") }, DESK_TZ, now)).toBe(
      "In use since 2:14 pm.",
    );
    expect(changeStatusLine({ changedAt: new Date("2026-10-21T18:14:00Z") }, DESK_TZ, now)).toBe(
      "In use since 21 Oct.",
    );
  });

  test("hours compare in one spelling, whatever order their days and keys were stored in", () => {
    const hours = { sun: [], mon: [["09:00", "17:00"]], tue: [], wed: [], thu: [], fri: [], sat: [] };
    const reversed = Object.fromEntries(Object.entries(hours).reverse());
    expect(canonicalHours(reversed)).toBe(canonicalHours(hours));
    expect(canonicalHours({ ...hours, sat: [["10:00", "12:00"]] })).not.toBe(canonicalHours(hours));
    expect(canonicalHours("nonsense")).toBeNull();
  });

  test("a person's change is from a device or the clinic's sign-in, never the device's own name", () => {
    expect(clinicActorOf("Front desk iPad")).toBe("clinic_device");
    expect(clinicActorOf("the clinic's sign-in")).toBe("clinic_signin");
    expect(clinicActorOf(null)).toBe("clinic_signin");
  });

  test("Slack carries the change's kind and counts, never anything else", () => {
    expect(
      slackFields({
        clinicId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        section: "closures",
        count: 6,
        written: 6,
        deleted: 0,
        hint: "Thanksgiving",
      }),
    ).toEqual({ clinicId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", section: "closures", count: 6, written: 6, deleted: 0 });
    expect(slackFields({ section: "Dr Lee's days" })).toEqual({});
  });
});

describeDb("a clinic's changes to its availability", () => {
  let google: FakeGoogleCalendar;
  let f: DeskLocation;
  let userId: string;

  const save = (closures: { closedOn: string; label: string }[], hours: unknown = EVERY_DAY) =>
    saveKnowledge({ clinicId: f.clinicId, userId, actorLabel: DEVICE }, "hours", { hours, closures });

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    installGoogleEnv();
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 60_000);

  beforeEach(async () => {
    google = freshGoogle();
    f = await deskLocation(google, `chg${Date.now() % 100000}`);
    userId = (await seedPortalUser(f.clinicId, "owner")).userId;
  }, 60_000);

  afterAll(async () => {
    restoreGoogleEnv();
    await closePools();
  });

  test(
    "a saved closed day adds one row for the closures, from the portal, with the device and the date",
    async () => {
      const d = dayAfter(10);
      expect(await save([{ closedOn: d, label: "Staff training" }])).toMatchObject({ ok: true });
      const rows = await changes(f.clinicId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "closures",
        source: "portal",
        actor_kind: "clinic_device",
        summary: { closuresAdded: [d], closuresRemoved: [], closuresUpcoming: 1, holdsReleased: 0 },
        alerted_at: null,
        // The audits are off, so nothing waits for one.
        audit_status: null,
      });
      // Neither the label the clinic typed nor its device's name is in the row.
      expect(JSON.stringify(rows)).not.toMatch(/Staff training|Front desk/);

      // The same save again changes nothing and records nothing.
      expect(await save([{ closedOn: d, label: "Staff training" }])).toMatchObject({ ok: true });
      expect(await changes(f.clinicId)).toHaveLength(1);

      // The weekly hours changing is its own row; the closed day taken off is the closures' row.
      const shorter = { ...EVERY_DAY, sun: [] };
      expect(await save([], shorter)).toMatchObject({ ok: true });
      const after = await changes(f.clinicId);
      // One save, two rows of the same moment: the hours, and the closed day taken off.
      expect(after).toHaveLength(3);
      expect(after.slice(1).map((r) => r.kind).sort()).toEqual(["closures", "hours"]);
      expect(after.slice(1).find((r) => r.kind === "closures")!.summary).toMatchObject({
        closuresAdded: [],
        closuresRemoved: [d],
      });
    },
    SLOW,
  );

  test(
    "a refused save, and a save whose transaction rolls back, record nothing and alert nobody",
    async () => {
      const refused = await save([{ closedOn: "2020-01-01", label: "" }]);
      expect(refused).toMatchObject({ ok: false, field: "closures" });
      await expect(
        withTenant({ clinicId: f.clinicId, actor: ACTOR }, async (tx) => {
          await saveHours(tx, { hours: EVERY_DAY, closures: [{ closedOn: dayAfter(12), label: "" }] }, DESK_TZ);
          throw new Error("rolled back on purpose");
        }),
      ).rejects.toThrow("rolled back on purpose");
      expect(await changes(f.clinicId)).toEqual([]);
      await runClinicChangeAlerts();
      expect(await alerts(f.clinicId)).toEqual([]);
    },
    SLOW,
  );

  test(
    "the roster's save adds one row with counts, never a name or a calendar",
    async () => {
      // Seeded as the migrator: the safety net records that as `direct`.
      await inTenant(f.clinicId, (c) =>
        c.query(`insert into clinic_providers (clinic_id, display_name, calendar_id) values ($1, 'Dr Lee', 'primary')`, [
          f.clinicId,
        ]),
      );
      const saved = await saveProviders(f.clinicId, [], {
        actor: { type: "user", userId, label: DEVICE },
      });
      expect(saved).toMatchObject({ status: "saved" });
      const rows = (await changes(f.clinicId)).filter((r) => r.source !== "direct");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "providers",
        source: "portal",
        actor_kind: "clinic_device",
        summary: { providersActive: 0, holdsReleased: 0 },
      });
      expect(JSON.stringify(rows)).not.toMatch(/Dr Lee|primary/);
    },
    SLOW,
  );

  test(
    "the wizard's hours are recorded as the wizard's, with the device as the actor",
    async () => {
      const { saveSetupScreen } = await import("@/lib/setup/save");
      const saved = await saveSetupScreen(
        { clinicId: f.clinicId, slug: "x", userId, actorLabel: DEVICE },
        "hours",
        { hours: { ...EVERY_DAY, sun: [] }, closures: [] },
      );
      expect(saved).toMatchObject({ ok: true });
      expect((await changes(f.clinicId)).filter((r) => r.source !== "direct")).toEqual([
        expect.objectContaining({ kind: "hours", source: "wizard", actor_kind: "clinic_device" }),
      ]);
    },
    SLOW,
  );

  test(
    "providers retired by a change of Google account are a roster change too",
    async () => {
      await inTenant(f.clinicId, (c) =>
        c.query(
          `insert into clinic_providers (clinic_id, display_name, calendar_id) values ($1, 'Dr Lee', 'lee@group.calendar.google.com'), ($1, 'Dr Ray', 'primary')`,
          [f.clinicId],
        ),
      );
      const retired = await withTenant({ clinicId: f.clinicId, actor: ACTOR }, (tx) =>
        retireOtherAccountProviders(tx, { source: "calendar_link", actor: "clinic_signin" }),
      );
      expect(retired).toBe(1);
      const rows = (await changes(f.clinicId)).filter((r) => r.source !== "direct");
      expect(rows).toEqual([
        expect.objectContaining({ kind: "providers", source: "calendar_link", summary: { providersActive: 1 } }),
      ]);
    },
    SLOW,
  );

  test(
    "six closed days added one save at a time are one alert, whether the sweep runs between them or after",
    async () => {
      for (let i = 0; i < 3; i += 1) {
        const days = Array.from({ length: i + 1 }, (_, j) => ({ closedOn: dayAfter(20 + j), label: "" }));
        expect(await save(days)).toMatchObject({ ok: true });
        await runClinicChangeAlerts();
      }
      for (let i = 3; i < 6; i += 1) {
        const days = Array.from({ length: i + 1 }, (_, j) => ({ closedOn: dayAfter(20 + j), label: "" }));
        expect(await save(days)).toMatchObject({ ok: true });
      }
      const result = await runClinicChangeAlerts();
      expect(result.failures).toBe(0);
      const raised = await alerts(f.clinicId);
      expect(raised).toHaveLength(1);
      expect(raised[0]!.fields).toMatchObject({ clinicId: f.clinicId, section: "closures" });
      // Ids, the kind and counts: nothing else reached the alert. Nothing was
      // taken off, so `deleted` is not sent at all (lane N3: never "0 taken off").
      expect(Object.keys(raised[0]!.fields).sort()).toEqual(["clinicId", "count", "section", "written"]);
      // Each change told once; a sweep with nothing new raises nothing.
      expect((await changes(f.clinicId)).every((r) => r.alerted_at !== null)).toBe(true);
      expect((await runClinicChangeAlerts()).alerts).toBe(0);
    },
    SLOW,
  );

  test(
    "with the audits switched on, a change waits for its audit; the clinic's line still says it is in use",
    async () => {
      await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = 'clinic-audits'`);
      try {
        await withTenant({ clinicId: f.clinicId, actor: ACTOR }, (tx) =>
          recordClinicChange(tx, { kind: "hours", source: "wizard", actor: "clinic_signin", summary: { weeklyChanged: true } }),
        );
        const [row] = await changes(f.clinicId);
        const { hoursStatusLine } = await import("@/lib/portal/knowledge");
        expect(await hoursStatusLine(f.clinicId, ACTOR, DESK_TZ)).toMatch(/^In use since /);
        expect(row).toMatchObject({ kind: "hours", source: "wizard", actor_kind: "clinic_signin", audit_status: "queued" });
      } finally {
        await getMigratorPool().query(`update scheduled_jobs set enabled = false where name = 'clinic-audits'`);
      }
    },
    SLOW,
  );
});
