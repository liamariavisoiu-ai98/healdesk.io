import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  assertPayloadAllowed,
  copyProblems,
  linkProblems,
  subjectProblems,
  visibleText,
} from "@/lib/email/lint";
import { clinicReason } from "@/lib/email/templates/context";
import {
  renderSetupReminder,
  SETUP_REMINDER_ENTRY,
  setupReminderAfterLiveFixture,
  type SetupReminderPayload,
} from "@/lib/email/templates/setup_reminder";
import type { EmailAudience, TemplateContext } from "@/lib/email/templates/types";
import { AFTER_LIVE_REMINDER_MS, queueSetupReminder } from "@/lib/setup/reminders";
import { SETUP_SCREENS } from "@/lib/setup/screen-ids";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * O7 once a channel is live (spec, "The first 48 hours": "Once a channel is
 * live, any other channel still not live after 48 hours triggers one
 * reminder of the same kind"; Annex X, O7, "At most one per channel"). The
 * five-day cadence stops when a channel goes live; this is what follows it.
 */

const ORIGIN = "https://app.healdesk.test";
const ENV = ["BETTER_AUTH_URL", "HEALDESK_APP_URL", "HEALDESK_CALL_BOOKING_URL"] as const;
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV) SAVED[key] = process.env[key];
  process.env.BETTER_AUTH_URL = ORIGIN;
  delete process.env.HEALDESK_APP_URL;
  delete process.env.HEALDESK_CALL_BOOKING_URL;
});

afterEach(() => {
  for (const key of ENV) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

function contextFor(audience: EmailAudience = "patients"): TemplateContext {
  return {
    clinicName: "Radiance Med Spa",
    audience,
    reason: clinicReason("Radiance Med Spa"),
    raisedAt: new Date("2026-10-06T14:32:00Z"),
    timeZone: "America/New_York",
  };
}

describe("the reminder once a channel is live", () => {
  for (const audience of ["patients", "clients"] as const) {
    test(`for ${audience}: the snapshot`, () => {
      expect(
        renderSetupReminder(setupReminderAfterLiveFixture(), contextFor(audience)),
      ).toMatchSnapshot();
    });
  }

  test("names the channel answering and the one action left, offers the call for phone, and says nothing of a deadline", () => {
    const payload = setupReminderAfterLiveFixture();
    assertPayloadAllowed(payload, "setup_reminder");
    const r = renderSetupReminder(payload, contextFor());
    expect(r.subject).toBe("One step left for AYA on your phone");
    expect(r.text).toContain(
      "AYA is answering patients for Radiance Med Spa on your website chat.",
    );
    expect(r.text).toContain("Phone isn't answering yet, and it needs one thing from you:");
    expect(r.text).toContain("Phone: Set call forwarding on your main line");
    expect(r.text).toContain(`${ORIGIN}/c/radiance-med-spa/setup?s=channels`);
    expect(r.text).toContain("Book a five-minute call");
    expect(r.text).not.toMatch(/account closes|refunded|last day|until/i);
    expect(subjectProblems(r.subject)).toEqual([]);
    expect(copyProblems([r.subject, r.preheader, r.text, visibleText(r.html)].join("\n"))).toEqual(
      [],
    );
    expect(linkProblems(r, "setup_reminder")).toEqual([]);
  });

  test("two channels due together share one email", () => {
    const payload: SetupReminderPayload = {
      ...setupReminderAfterLiveFixture(),
      rows: [
        { channel: "voice", status: "forwarding" },
        { channel: "meta", status: "meta_connect" },
      ],
      callUrl: null,
    };
    const r = renderSetupReminder(payload, contextFor("clients"));
    expect(r.subject).toBe("One step left for AYA on your other channels");
    expect(r.text).toContain("AYA is answering clients for Radiance Med Spa on your website chat.");
    expect(r.text).toContain(
      "Phone and Instagram, Messenger & WhatsApp aren't answering yet, and each needs one thing from you:",
    );
    expect(r.text).toContain("Instagram, Messenger & WhatsApp: Connect Instagram and Messenger");
    expect(r.text).not.toContain("Book a five-minute call");
  });

  test("before go-live the reminder still needs its count and the window's last day", () => {
    const { closesOn: _closes, ...withoutDay } = SETUP_REMINDER_ENTRY.fixture;
    void _closes;
    expect(() => renderSetupReminder(withoutDay, contextFor())).toThrow(/last day/);
  });

  test("a channel whose skipped screen is what it waits on is named, not left out", () => {
    const r = renderSetupReminder(
      { ...setupReminderAfterLiveFixture(), rows: [{ channel: "voice", status: "finish_setup" }] },
      contextFor(),
    );
    expect(r.text).toContain("Phone: Finish setup");
  });
});

// -----------------------------------------------------------------------------
// Against the database: lib/setup/reminders.ts
// -----------------------------------------------------------------------------

const describeDb = hasTestDatabase ? describe : describe.skip;
const HOUR = 60 * 60 * 1000;
// Noon in New York, where provisioned clinics are.
const noon = new Date("2026-10-20T16:00:00Z");
const night = new Date("2026-10-20T07:00:00Z");

/** A clinic on voice, website chat and Meta, setup finished, nothing live yet. */
async function bought(label: string): Promise<PortalClinic> {
  const clinic = await provisionPortalClinic(label, { plan: "voice-metachat-1000-1000" });
  await inTenant(clinic.clinicId, async (c) => {
    for (const screen of SETUP_SCREENS) {
      if (screen === "backup") continue;
      await c.query(
        `insert into clinic_setup_screens (clinic_id, screen, outcome, at, actor_label)
         values ($1, $2, 'skipped', now(), 'test')
         on conflict (clinic_id, screen) do update set outcome = excluded.outcome`,
        [clinic.clinicId, screen],
      );
    }
  });
  await getMigratorPool().query(`update clinics set timezone = 'America/New_York' where id = $1`, [
    clinic.clinicId,
  ]);
  return clinic;
}

async function channel(clinic: PortalClinic, name: string, set: string, values: unknown[] = []) {
  await inTenant(clinic.clinicId, (c) =>
    c.query(`update clinic_channels set ${set} where clinic_id = $1 and channel = $2`, [
      clinic.clinicId,
      name,
      ...values,
    ]),
  );
}

async function reminders(clinic: PortalClinic) {
  return inTenant(
    clinic.clinicId,
    async (c) =>
      (
        await c.query<{ dedupe_key: string; payload: Record<string, unknown> }>(
          `select dedupe_key, payload from billing_notices where kind = 'setup_reminder' order by created_at`,
        )
      ).rows,
  );
}

const ago = (hours: number) => new Date(noon.getTime() - hours * HOUR);

describeDb("O7 once a channel is live, against the database", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("48 hours after website chat went live, phone still waiting on forwarding gets one reminder, in daytime, once", async () => {
    const clinic = await bought(`al-${randomUUID().slice(0, 4)}`);
    await channel(clinic, "web", `ready_at = $3, live_at = $3`, [ago(60)]);
    await channel(clinic, "voice", `ready_at = $3, waiting_on = 'forwarding'`, [ago(72)]);
    // Meta is still being prepared on our side: nothing for the clinic to do.

    expect(await queueSetupReminder(clinic.clinicId, night)).toBe("night");
    expect(await queueSetupReminder(clinic.clinicId, noon)).toBe("queued");
    const rows = await reminders(clinic);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupe_key).toBe("setup_reminder:live:voice");
    expect(rows[0]!.payload).toMatchObject({
      rows: [{ channel: "voice", status: "forwarding" }],
      liveRows: [{ channel: "web" }],
      setupUrl: `${ORIGIN}/c/${clinic.clinicSlug}/setup?s=channels`,
    });
    expect(rows[0]!.payload).not.toHaveProperty("closesOn");
    expect(() => assertPayloadAllowed(rows[0]!.payload, "setup_reminder")).not.toThrow();
    // It renders as the sender would render it.
    expect(
      renderSetupReminder(rows[0]!.payload as SetupReminderPayload, contextFor()).subject,
    ).toBe("One step left for AYA on your phone");

    // At most one per channel, ever.
    expect(await queueSetupReminder(clinic.clinicId, new Date(noon.getTime() + 24 * HOUR))).toBe(
      "live",
    );
    expect(await reminders(clinic)).toHaveLength(1);
  });

  test("not before 48 hours, counted from the later of the first live channel and the channel's own readiness", async () => {
    const clinic = await bought(`al-${randomUUID().slice(0, 4)}`);
    await channel(clinic, "web", `ready_at = $3, live_at = $3`, [ago(47)]);
    await channel(clinic, "voice", `ready_at = $3, waiting_on = 'forwarding'`, [ago(100)]);
    expect(await queueSetupReminder(clinic.clinicId, noon)).toBe("live");

    const later = await bought(`al-${randomUUID().slice(0, 4)}`);
    await channel(later, "web", `ready_at = $3, live_at = $3`, [ago(100)]);
    // Phone became ready long after website chat went live.
    await channel(later, "voice", `ready_at = $3, waiting_on = 'forwarding'`, [ago(24)]);
    expect(await queueSetupReminder(later.clinicId, noon)).toBe("live");
    const due = new Date(ago(24).getTime() + AFTER_LIVE_REMINDER_MS);
    expect(await queueSetupReminder(later.clinicId, due)).toBe("queued");
  });

  test("the 30-day window plays no part once a channel is live: it is sent after the window's last day too", async () => {
    const clinic = await bought(`al-${randomUUID().slice(0, 4)}`);
    await inTenant(clinic.clinicId, (c) =>
      c.query(`update entitlements set setup_deadline_at = $2 where clinic_id = $1`, [
        clinic.clinicId,
        ago(24 * 5),
      ]),
    );
    await channel(clinic, "web", `ready_at = $3, live_at = $3`, [ago(24 * 6)]);
    await channel(clinic, "voice", `ready_at = $3, waiting_on = 'forwarding'`, [ago(24 * 6)]);
    expect(await queueSetupReminder(clinic.clinicId, noon)).toBe("queued");

    // With nothing live, the window still ends the cadence.
    const unfinished = await bought(`al-${randomUUID().slice(0, 4)}`);
    await inTenant(unfinished.clinicId, (c) =>
      c.query(`update entitlements set setup_deadline_at = $2 where clinic_id = $1`, [
        unfinished.clinicId,
        ago(24),
      ]),
    );
    expect(await queueSetupReminder(unfinished.clinicId, noon)).toBe("window_over");
  });

  test("two channels due together share one email, and neither is named again", async () => {
    const clinic = await bought(`al-${randomUUID().slice(0, 4)}`);
    await channel(clinic, "web", `ready_at = $3, live_at = $3`, [ago(60)]);
    await channel(clinic, "voice", `ready_at = $3, waiting_on = 'forwarding'`, [ago(60)]);
    await channel(clinic, "meta", `ready_at = $3, waiting_on = 'meta_connect'`, [ago(60)]);
    expect(await queueSetupReminder(clinic.clinicId, noon)).toBe("queued");
    const rows = await reminders(clinic);
    expect(rows.map((r) => r.dedupe_key)).toEqual(["setup_reminder:live:meta+voice"]);
    expect(rows[0]!.payload.rows).toEqual([
      { channel: "meta", status: "meta_connect" },
      { channel: "voice", status: "forwarding" },
    ]);
    expect(await queueSetupReminder(clinic.clinicId, new Date(noon.getTime() + 72 * HOUR))).toBe(
      "live",
    );
  });

  test("a channel switched Off, or still being prepared on our side, has no action to name", async () => {
    const clinic = await bought(`al-${randomUUID().slice(0, 4)}`);
    await channel(clinic, "web", `ready_at = $3, live_at = $3`, [ago(60)]);
    await channel(clinic, "voice", `ready_at = $3, waiting_on = 'forwarding', enabled = false`, [
      ago(60),
    ]);
    // Meta: ready_at null, still being prepared.
    expect(await queueSetupReminder(clinic.clinicId, noon)).toBe("live");
    expect(await reminders(clinic)).toEqual([]);
  });

  test("before any channel is live, the five-day cadence is unchanged", async () => {
    const clinic = await bought(`al-${randomUUID().slice(0, 4)}`);
    await getMigratorPool().query(`update clinics set created_at = $2 where id = $1`, [
      clinic.clinicId,
      ago(24 * 5),
    ]);
    await inTenant(clinic.clinicId, (c) =>
      c.query(`update entitlements set setup_deadline_at = $2 where clinic_id = $1`, [
        clinic.clinicId,
        new Date(noon.getTime() + 25 * 24 * HOUR),
      ]),
    );
    await channel(clinic, "voice", `ready_at = $3, waiting_on = 'forwarding'`, [ago(72)]);
    expect(await queueSetupReminder(clinic.clinicId, noon)).toBe("queued");
    expect((await reminders(clinic)).map((r) => r.dedupe_key)).toEqual(["setup_reminder:1"]);
  });
});
