import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  ClinicSettingsError,
  DEFAULT_CLINIC_SETTINGS,
  getClinicSettings,
  normaliseE164,
  updateClinicSettings,
} from "@/lib/billing/settings";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * clinic_settings (design D9): defaults without a row, one upsert path, and
 * the validation that keeps a fallback from looping back into the assistant.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
// A service actor: a user actor's id is a foreign key to "user", and the
// label passed to updateClinicSettings is what Pause AI records.
const actor = {
  type: "service",
  serviceName: "settings-test",
  label: "owner@example-clinic.test",
} as const;

describe("normaliseE164", () => {
  test("accepts typed numbers with separators and refuses anything that is not E.164", () => {
    expect(normaliseE164("+1 (415) 555-0100")).toBe("+14155550100");
    expect(normaliseE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(normaliseE164("4155550100")).toBeNull();
    expect(normaliseE164("+0 415 555 0100")).toBeNull();
    expect(normaliseE164("+1 415 555 01OO")).toBeNull();
    expect(normaliseE164("")).toBeNull();
  });
});

describeDb("clinic settings", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("a clinic that never saved anything reads the defaults, and the defaults match the columns", async () => {
    const { clinicId } = await seedClinic("settings-defaults");
    const read = await withTenant({ clinicId, actor }, (tx) => getClinicSettings(tx));
    expect(read).toEqual(DEFAULT_CLINIC_SETTINGS);

    // A bare row takes the column defaults; they must be the library's.
    const row = await inTenant(clinicId, async (c) => {
      await c.query(`insert into clinic_settings (clinic_id) values ($1)`, [clinicId]);
      const { rows } = await c.query<Record<string, unknown>>(
        `select * from clinic_settings where clinic_id = $1`,
        [clinicId],
      );
      return rows[0]!;
    });
    expect({
      depositsEnabled: row.deposits_enabled,
      bookVoiceWithoutDeposit: row.book_voice_without_deposit,
      bookChatWithoutDeposit: row.book_chat_without_deposit,
      depositUncollectable: row.deposit_uncollectable,
      depositHoldMinutes: row.deposit_hold_minutes,
      aiPausedAt: row.ai_paused_at,
      directLineE164: row.direct_line_e164,
    }).toEqual({
      depositsEnabled: DEFAULT_CLINIC_SETTINGS.depositsEnabled,
      bookVoiceWithoutDeposit: DEFAULT_CLINIC_SETTINGS.bookVoiceWithoutDeposit,
      bookChatWithoutDeposit: DEFAULT_CLINIC_SETTINGS.bookChatWithoutDeposit,
      depositUncollectable: DEFAULT_CLINIC_SETTINGS.depositUncollectable,
      depositHoldMinutes: DEFAULT_CLINIC_SETTINGS.depositHoldMinutes,
      aiPausedAt: null,
      directLineE164: null,
    });
  });

  test("updates upsert, keep the fields they do not name, and stamp Pause AI from the actor and the clock", async () => {
    const { clinicId } = await seedClinic("settings-upsert");
    const now = new Date("2026-10-05T12:00:00Z");

    const first = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(
        tx,
        { depositHoldMinutes: 90, depositUncollectable: "hold_and_alert" },
        actor.label,
        now,
      ),
    );
    expect(first.depositHoldMinutes).toBe(90);
    expect(first.depositUncollectable).toBe("hold_and_alert");
    expect(first.updatedAt?.getTime()).toBe(now.getTime());

    const later = new Date("2026-10-05T13:00:00Z");
    const second = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(
        tx,
        { aiPaused: true, directLineE164: "+1 415 555 0199" },
        actor.label,
        later,
      ),
    );
    expect(second.depositHoldMinutes).toBe(90);
    expect(second.aiPausedAt?.getTime()).toBe(later.getTime());
    expect(second.aiPausedByLabel).toBe(actor.label);
    expect(second.directLineE164).toBe("+14155550199");
    expect(second.directLineSetAt?.getTime()).toBe(later.getTime());

    const resumed = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(tx, { aiPaused: false, directLineE164: null }, actor.label, later),
    );
    expect(resumed.aiPausedAt).toBeNull();
    expect(resumed.aiPausedByLabel).toBeNull();
    expect(resumed.directLineE164).toBeNull();

    // The audit trail records that a line was set, never the number.
    const audits = await inTenant(clinicId, async (c) => {
      const { rows } = await c.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_log where clinic_id = $1 and resource_type = 'clinic_settings' order by occurred_at`,
        [clinicId],
      );
      return rows.map((r) => r.metadata);
    });
    expect(audits).toHaveLength(3);
    expect(audits[1]).toMatchObject({ aiPaused: true, directLineSet: true });
    expect(audits[2]).toMatchObject({ aiPaused: false, directLineSet: false });
    expect(JSON.stringify(audits)).not.toContain("5550199");
  });

  test("re-saving the same pause or the same direct line keeps the original stamps and writes no audit", async () => {
    const { clinicId } = await seedClinic("settings-resave");
    const first = new Date("2026-10-05T09:00:00Z");
    const later = new Date("2026-10-05T15:00:00Z");
    await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(tx, { aiPaused: true, directLineE164: "+14155550177" }, actor.label, first),
    );

    // A form re-sends the whole state with one field changed.
    const resaved = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(
        tx,
        { aiPaused: true, directLineE164: "+1 415 555 0177", depositHoldMinutes: 120 },
        "someone-else@example-clinic.test",
        later,
      ),
    );
    expect(resaved.aiPausedAt?.getTime()).toBe(first.getTime());
    expect(resaved.aiPausedByLabel).toBe(actor.label);
    expect(resaved.directLineSetAt?.getTime()).toBe(first.getTime());
    expect(resaved.depositHoldMinutes).toBe(120);

    // Saving exactly what is stored writes nothing at all.
    const unchanged = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(tx, { aiPaused: true, depositHoldMinutes: 120 }, actor.label, later),
    );
    expect(unchanged.updatedAt?.getTime()).toBe(later.getTime());

    const audits = await inTenant(clinicId, async (c) => {
      const { rows } = await c.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_log where clinic_id = $1 and resource_type = 'clinic_settings' order by occurred_at`,
        [clinicId],
      );
      return rows.map((r) => r.metadata);
    });
    expect(audits).toHaveLength(2);
    expect(audits[1]).toEqual({ fields: ["depositHoldMinutes"], depositHoldMinutes: 120 });
  });

  test("a direct line that is not a string is refused with the field, not a TypeError", async () => {
    const { clinicId } = await seedClinic("settings-direct-type");
    for (const value of [14155550100, true, { n: 1 }]) {
      await expect(
        withTenant({ clinicId, actor }, (tx) =>
          updateClinicSettings(tx, { directLineE164: value as never }, actor.label),
        ),
      ).rejects.toMatchObject({ name: "ClinicSettingsError", field: "directLineE164" });
    }
  });

  test("the direct line must be E.164 and must differ from the published and Synthflow numbers", async () => {
    const { clinicId } = await seedClinic("settings-direct");
    await getMigratorPool().query(
      `update clinics set published_phone_e164 = '+14155550100', synthflow_number_e164 = '+14155550111' where id = $1`,
      [clinicId],
    );
    const attempt = (directLineE164: string) =>
      withTenant({ clinicId, actor }, (tx) =>
        updateClinicSettings(tx, { directLineE164 }, actor.label),
      );

    await expect(attempt("415 555 0100")).rejects.toBeInstanceOf(ClinicSettingsError);
    await expect(attempt("+1 (415) 555-0100")).rejects.toThrow(/published number/);
    await expect(attempt("+14155550111")).rejects.toThrow(/assistant's own number/);
    const ok = await attempt("+14155550122");
    expect(ok.directLineE164).toBe("+14155550122");
  });

  test("the hold and the uncollectable choice are refused with words, not a constraint error", async () => {
    const { clinicId } = await seedClinic("settings-bounds");
    const attempt = (patch: Parameters<typeof updateClinicSettings>[1]) =>
      withTenant({ clinicId, actor }, (tx) => updateClinicSettings(tx, patch, actor.label));

    for (const minutes of [29, 1441, 45.5]) {
      await expect(attempt({ depositHoldMinutes: minutes })).rejects.toMatchObject({
        name: "ClinicSettingsError",
        field: "depositHoldMinutes",
      });
    }
    await expect(attempt({ depositUncollectable: "ignore" as never })).rejects.toMatchObject({
      field: "depositUncollectable",
    });
    await expect(attempt({ depositsEnabled: "yes" as never })).rejects.toMatchObject({
      field: "depositsEnabled",
    });
    // Nothing was written by any refusal.
    expect(await withTenant({ clinicId, actor }, (tx) => getClinicSettings(tx))).toEqual(
      DEFAULT_CLINIC_SETTINGS,
    );
    // The boundaries themselves are allowed.
    expect((await attempt({ depositHoldMinutes: 30 })).depositHoldMinutes).toBe(30);
    expect((await attempt({ depositHoldMinutes: 1440 })).depositHoldMinutes).toBe(1440);
  });

  test("one clinic's settings are invisible from another's tenant", async () => {
    const a = await seedClinic("settings-iso-a");
    const b = await seedClinic("settings-iso-b");
    await withTenant({ clinicId: a.clinicId, actor }, (tx) =>
      updateClinicSettings(tx, { depositsEnabled: true }, actor.label),
    );
    const fromB = await withTenant({ clinicId: b.clinicId, actor }, (tx) => getClinicSettings(tx));
    expect(fromB.depositsEnabled).toBe(false);
  });
});
