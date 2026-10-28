import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  ClinicSettingsError,
  DEFAULT_CLINIC_SETTINGS,
  getClinicSettings,
  normaliseE164,
  updateClinicSettings,
} from "@/lib/billing/settings";
import { isPaused } from "@/lib/channels/state";
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
 * The pause is judged by isPaused, so a timed pause ends by itself (BD26),
 * and deposits are switched only by lib/billing/deposits.ts (R24).
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
      aiPausedUntil: row.ai_paused_until,
      autoConfirmBookings: row.auto_confirm_bookings,
      autoConfirmChangedAt: row.auto_confirm_changed_at,
      autoConfirmChangedByLabel: row.auto_confirm_changed_by_label,
      directLineE164: row.direct_line_e164,
      textPaymentLink: row.text_payment_link,
      paymentAsk: row.payment_ask,
    }).toEqual({
      depositsEnabled: DEFAULT_CLINIC_SETTINGS.depositsEnabled,
      bookVoiceWithoutDeposit: DEFAULT_CLINIC_SETTINGS.bookVoiceWithoutDeposit,
      bookChatWithoutDeposit: DEFAULT_CLINIC_SETTINGS.bookChatWithoutDeposit,
      depositUncollectable: DEFAULT_CLINIC_SETTINGS.depositUncollectable,
      depositHoldMinutes: DEFAULT_CLINIC_SETTINGS.depositHoldMinutes,
      aiPausedAt: null,
      aiPausedUntil: DEFAULT_CLINIC_SETTINGS.aiPausedUntil,
      // Auto-confirm is on by default (spec), in drizzle/0057 as here.
      autoConfirmBookings: true,
      autoConfirmChangedAt: DEFAULT_CLINIC_SETTINGS.autoConfirmChangedAt,
      autoConfirmChangedByLabel: DEFAULT_CLINIC_SETTINGS.autoConfirmChangedByLabel,
      directLineE164: null,
      // The payment switches (drizzle/0133): off, and deposit only.
      textPaymentLink: DEFAULT_CLINIC_SETTINGS.textPaymentLink,
      paymentAsk: DEFAULT_CLINIC_SETTINGS.paymentAsk,
    });
    expect(DEFAULT_CLINIC_SETTINGS.autoConfirmBookings).toBe(true);
    expect(DEFAULT_CLINIC_SETTINGS.textPaymentLink).toBe(false);
    expect(DEFAULT_CLINIC_SETTINGS.paymentAsk).toBe("deposit_only");
  });

  test("switching Auto-confirm stamps who and when together and audits a boolean; re-saving moves neither", async () => {
    const { clinicId } = await seedClinic("settings-auto-confirm");
    const first = new Date("2026-10-08T09:00:00Z");
    const later = new Date("2026-10-08T15:00:00Z");

    const off = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(tx, { autoConfirmBookings: false }, actor.label, first),
    );
    expect(off).toMatchObject({
      autoConfirmBookings: false,
      autoConfirmChangedByLabel: actor.label,
    });
    expect(off.autoConfirmChangedAt?.getTime()).toBe(first.getTime());

    // The same value, from a form that re-sends it with another field.
    const resaved = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(
        tx,
        { autoConfirmBookings: false, depositHoldMinutes: 120 },
        "someone-else@example-clinic.test",
        later,
      ),
    );
    expect(resaved.autoConfirmChangedAt?.getTime()).toBe(first.getTime());
    expect(resaved.autoConfirmChangedByLabel).toBe(actor.label);

    const on = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(
        tx,
        { autoConfirmBookings: true },
        "someone-else@example-clinic.test",
        later,
      ),
    );
    expect(on).toMatchObject({
      autoConfirmBookings: true,
      autoConfirmChangedByLabel: "someone-else@example-clinic.test",
    });
    expect(on.autoConfirmChangedAt?.getTime()).toBe(later.getTime());

    await expect(
      withTenant({ clinicId, actor }, (tx) =>
        updateClinicSettings(tx, { autoConfirmBookings: "off" as never }, actor.label),
      ),
    ).rejects.toMatchObject({ name: "ClinicSettingsError", field: "autoConfirmBookings" });

    const audits = await inTenant(clinicId, async (c) => {
      const { rows } = await c.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_log where clinic_id = $1 and resource_type = 'clinic_settings' order by occurred_at`,
        [clinicId],
      );
      return rows.map((r) => r.metadata);
    });
    expect(audits).toEqual([
      { fields: ["autoConfirm"], autoConfirm: false },
      { fields: ["depositHoldMinutes"], depositHoldMinutes: 120 },
      { fields: ["autoConfirm"], autoConfirm: true },
    ]);
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
    expect(resumed.aiPausedUntil).toBeNull();
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
      updateClinicSettings(
        tx,
        { aiPaused: true, directLineE164: "+14155550177" },
        actor.label,
        first,
      ),
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

  test("the direct line must be E.164 and must differ from the published and assistant's numbers", async () => {
    const { clinicId } = await seedClinic("settings-direct");
    await getMigratorPool().query(
      `update clinics set published_phone_e164 = '+14155550100', assistant_number_e164 = '+14155550111' where id = $1`,
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
    await expect(attempt({ bookVoiceWithoutDeposit: "yes" as never })).rejects.toMatchObject({
      field: "bookVoiceWithoutDeposit",
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
      updateClinicSettings(tx, { depositHoldMinutes: 90 }, actor.label),
    );
    const fromB = await withTenant({ clinicId: b.clinicId, actor }, (tx) => getClinicSettings(tx));
    expect(fromB.depositHoldMinutes).toBe(DEFAULT_CLINIC_SETTINGS.depositHoldMinutes);
  });

  test("deposits are not switched here: a patch naming them is refused and writes nothing (R24)", async () => {
    const { clinicId } = await seedClinic("settings-deposits");
    await expect(
      withTenant({ clinicId, actor }, (tx) =>
        updateClinicSettings(tx, { depositsEnabled: true } as never, actor.label),
      ),
    ).rejects.toThrow(/setDepositSettings/);
    const read = await withTenant({ clinicId, actor }, (tx) => getClinicSettings(tx));
    expect(read).toEqual(DEFAULT_CLINIC_SETTINGS);
  });
});

describeDb("Pause AI (BD26)", () => {
  const at = (iso: string) => new Date(iso);
  const pauseOf = (s: { aiPausedAt: Date | null; aiPausedUntil: Date | null }) => ({
    pausedAt: s.aiPausedAt,
    pausedUntil: s.aiPausedUntil,
  });

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("a timed pause holds until its end and is over after it; pausing again then starts a new pause with fresh stamps", async () => {
    const { clinicId } = await seedClinic("pause-timed");
    const start = at("2026-10-06T09:00:00Z");
    const end = at("2026-10-06T10:00:00Z");
    const timed = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(tx, { aiPaused: true, aiPausedUntil: end }, actor.label, start),
    );
    expect(timed.aiPausedAt?.getTime()).toBe(start.getTime());
    expect(timed.aiPausedUntil?.getTime()).toBe(end.getTime());
    expect(isPaused(pauseOf(timed), at("2026-10-06T09:59:00Z"))).toBe(true);
    expect(isPaused(pauseOf(timed), at("2026-10-06T10:00:00Z"))).toBe(false);

    // After the hour, the stamps are still stored but the pause is over. A
    // new pause is a new pause: judged by the stamp alone it was dropped as
    // "already paused", and the assistant kept answering.
    const later = at("2026-10-06T14:00:00Z");
    const again = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(tx, { aiPaused: true }, "manager@example-clinic.test", later),
    );
    expect(again.aiPausedAt?.getTime()).toBe(later.getTime());
    expect(again.aiPausedByLabel).toBe("manager@example-clinic.test");
    // Until switched back on: the old, past end is not inherited.
    expect(again.aiPausedUntil).toBeNull();
    expect(isPaused(pauseOf(again), at("2026-10-07T14:00:00Z"))).toBe(true);
  });

  test("pausing again while paused moves only when it ends; who paused and since when stay", async () => {
    const { clinicId } = await seedClinic("pause-extend");
    const start = at("2026-10-06T09:00:00Z");
    await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(
        tx,
        { aiPaused: true, aiPausedUntil: at("2026-10-06T10:00:00Z") },
        actor.label,
        start,
      ),
    );
    const tomorrow = at("2026-10-07T08:00:00Z");
    const moved = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(
        tx,
        { aiPaused: true, aiPausedUntil: tomorrow },
        "someone-else@example-clinic.test",
        at("2026-10-06T09:30:00Z"),
      ),
    );
    expect(moved.aiPausedAt?.getTime()).toBe(start.getTime());
    expect(moved.aiPausedByLabel).toBe(actor.label);
    expect(moved.aiPausedUntil?.getTime()).toBe(tomorrow.getTime());

    // And to "until switched back on".
    const open = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(
        tx,
        { aiPaused: true, aiPausedUntil: null },
        actor.label,
        at("2026-10-06T09:45:00Z"),
      ),
    );
    expect(open.aiPausedAt?.getTime()).toBe(start.getTime());
    expect(open.aiPausedUntil).toBeNull();

    // A form re-sending "paused" with no end named changes nothing.
    const resent = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(tx, { aiPaused: true }, actor.label, at("2026-10-06T11:00:00Z")),
    );
    expect(resent.updatedAt?.getTime()).toBe(at("2026-10-06T09:45:00Z").getTime());
  });

  test("resuming clears all three, including a timed pause's stamps after it ended by itself", async () => {
    const { clinicId } = await seedClinic("pause-resume");
    await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(
        tx,
        { aiPaused: true, aiPausedUntil: at("2026-10-06T10:00:00Z") },
        actor.label,
        at("2026-10-06T09:00:00Z"),
      ),
    );
    const resumed = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(tx, { aiPaused: false }, actor.label, at("2026-10-06T12:00:00Z")),
    );
    expect(resumed).toMatchObject({ aiPausedAt: null, aiPausedByLabel: null, aiPausedUntil: null });

    // With nothing stored, a resume writes nothing.
    const again = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(tx, { aiPaused: false }, actor.label, at("2026-10-06T13:00:00Z")),
    );
    expect(again.updatedAt?.getTime()).toBe(at("2026-10-06T12:00:00Z").getTime());

    const audits = await inTenant(clinicId, async (c) => {
      const { rows } = await c.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_log where clinic_id = $1 and resource_type = 'clinic_settings' order by occurred_at`,
        [clinicId],
      );
      return rows.map((r) => r.metadata);
    });
    // Booleans only: whether the pause was timed, never when it ends.
    expect(audits).toEqual([
      { fields: ["aiPaused", "pauseTimed"], aiPaused: true, pauseTimed: true },
      { fields: ["aiPaused"], aiPaused: false },
    ]);
  });

  test("a pause's end is refused unless pausing, in the past, or not a date", async () => {
    const { clinicId } = await seedClinic("pause-bounds");
    const now = at("2026-10-06T09:00:00Z");
    const attempt = (patch: Parameters<typeof updateClinicSettings>[1]) =>
      withTenant({ clinicId, actor }, (tx) => updateClinicSettings(tx, patch, actor.label, now));

    await expect(attempt({ aiPausedUntil: at("2026-10-06T10:00:00Z") })).rejects.toMatchObject({
      name: "ClinicSettingsError",
      field: "aiPausedUntil",
    });
    await expect(
      attempt({ aiPaused: false, aiPausedUntil: at("2026-10-06T10:00:00Z") }),
    ).rejects.toMatchObject({ field: "aiPausedUntil" });
    await expect(attempt({ aiPaused: true, aiPausedUntil: now })).rejects.toThrow(/future/);
    await expect(
      attempt({ aiPaused: true, aiPausedUntil: "tomorrow" as never }),
    ).rejects.toMatchObject({ field: "aiPausedUntil" });
    expect(await withTenant({ clinicId, actor }, (tx) => getClinicSettings(tx))).toEqual(
      DEFAULT_CLINIC_SETTINGS,
    );
  });

  test("a new pause replaces the stamps of one that ended, in the upsert's conflict path too", async () => {
    const { clinicId } = await seedClinic("pause-race");
    // A timed pause that ended long ago, still stored.
    await inTenant(clinicId, (c) =>
      c.query(
        `insert into clinic_settings (clinic_id, ai_paused_at, ai_paused_by_label, ai_paused_until)
         values ($1, '2026-10-01T09:00:00Z', 'old@example-clinic.test', '2026-10-01T10:00:00Z')`,
        [clinicId],
      ),
    );
    const now = at("2026-10-06T09:00:00Z");
    const paused = await withTenant({ clinicId, actor }, (tx) =>
      updateClinicSettings(tx, { aiPaused: true }, actor.label, now),
    );
    expect(paused.aiPausedAt?.getTime()).toBe(now.getTime());
    expect(paused.aiPausedByLabel).toBe(actor.label);
    expect(paused.aiPausedUntil).toBeNull();
  });
});
