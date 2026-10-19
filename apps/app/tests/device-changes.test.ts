import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { notifyDeviceChange } from "@/lib/notices/device-changes";
import type {
  DeliveryResult,
  DeliveryTarget,
  EmailTransport,
  OutgoingEmail,
} from "@/lib/reporting/deliver";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedPortalUser } from "./setup/factories";

/**
 * O3 (Annex X5): the sign-in's address hears about every device that can
 * open patient details, except the first one when it is added in the browser
 * that paid, by the person reading the inbox, and about a lockout.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

type Sent = { target: DeliveryTarget; message: OutgoingEmail };

function fakeTransport(result: DeliveryResult = { status: "sent", messageId: "msg_o3" }) {
  const sent: Sent[] = [];
  const transport: EmailTransport = {
    name: "fake",
    send: async (target, message) => {
      sent.push({ target, message });
      return result;
    },
  };
  return { sent, transport };
}

async function seedPasskey(userId: string, label = "Front desk Mac"): Promise<string> {
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, transports, backed_up)
     values ($1, 'passkey', $2, $3, $4, 0, array['internal'], true) returning id`,
    [userId, label, randomBytes(16).toString("base64url"), randomBytes(77)],
  );
  return rows[0]!.id;
}

const NOW = new Date("2026-10-06T18:32:00Z");

describeDb("the device email (O3)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePools();
  });

  test("a device added names itself and the time, in the clinic's own zone, to the sign-in's address", async () => {
    const clinic = await seedClinic("glow");
    await inTenant(clinic.clinicId, (client) =>
      client.query(`update clinics set timezone = 'America/Los_Angeles' where id = $1`, [
        clinic.clinicId,
      ]),
    );
    const owner = await seedPortalUser(clinic.clinicId, "owner");
    const factorId = await seedPasskey(owner.userId, "Maria's iPhone");
    const { sent, transport } = fakeTransport();

    await notifyDeviceChange(
      { userId: owner.userId, kind: "added", factorId },
      { transport, now: NOW },
    );

    expect(sent).toHaveLength(1);
    const [{ target, message }] = sent as [Sent];
    expect(target.to).toBe(owner.email);
    expect(message.subject).toBe("A device was added to your healdesk sign-in");
    expect(message.text).toContain(
      "“Maria's iPhone” was added to your healdesk sign-in on Tuesday, October 6 at 11:32 AM PDT.",
    );
    expect(message.text).toContain("reply to this email now");
    expect(message.idempotencyKey).toBe(`hd-device_changed-${factorId}-added`);
    // A sign-in's email, not a clinic's: no clinic tag.
    expect(message.tags).toEqual([
      { name: "app", value: "app" },
      { name: "kind", value: "device_changed" },
    ]);
  });

  test("the first passkey, added in the browser that paid, sends nothing", async () => {
    const clinic = await seedClinic("glow");
    const owner = await seedPortalUser(clinic.clinicId, "owner");
    const factorId = await seedPasskey(owner.userId);
    const { sent, transport } = fakeTransport();

    await notifyDeviceChange(
      { userId: owner.userId, kind: "added", factorId, first: true, payingBrowser: true },
      { transport },
    );
    expect(sent).toEqual([]);
  });

  test("the first passkey from any other session is reported, like every later one", async () => {
    // Before go-live a first passkey needs only a session (Part D3), so one
    // added anywhere but the browser that paid is exactly what O3 is for.
    const clinic = await seedClinic("glow");
    const owner = await seedPortalUser(clinic.clinicId, "owner");
    const factorId = await seedPasskey(owner.userId, "Reception PC");
    const { sent, transport } = fakeTransport();

    await notifyDeviceChange(
      { userId: owner.userId, kind: "added", factorId, first: true, payingBrowser: false },
      { transport, now: NOW },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target.to).toBe(owner.email);
    expect(sent[0]!.message.text).toContain("“Reception PC” was added to your healdesk sign-in");

    // A later device in the paying browser is reported too: only the first is skipped there.
    const later = await seedPasskey(owner.userId, "Maria's iPhone");
    await notifyDeviceChange(
      { userId: owner.userId, kind: "added", factorId: later, first: false, payingBrowser: true },
      { transport, now: NOW },
    );
    expect(sent).toHaveLength(2);
  });

  test("a removal and a lockout each say what happened", async () => {
    const clinic = await seedClinic("glow");
    const owner = await seedPortalUser(clinic.clinicId, "owner");
    const factorId = await seedPasskey(owner.userId);
    const { sent, transport } = fakeTransport();

    await notifyDeviceChange(
      { userId: owner.userId, kind: "removed", factorId },
      { transport, now: NOW },
    );
    await notifyDeviceChange(
      { userId: owner.userId, kind: "locked", lockedUntil: new Date(NOW.getTime() + 15 * 60_000) },
      { transport, now: NOW },
    );

    expect(sent.map((s) => s.message.subject)).toEqual([
      "A device was removed from your healdesk sign-in",
      "Code entry on your healdesk sign-in was locked",
    ]);
    expect(sent[0]!.message.text).toContain("“Front desk Mac” was removed");
    expect(sent[1]!.message.text).toContain("code entry is locked for 15 minutes");
    expect(sent[1]!.message.idempotencyKey).toBe(
      `hd-device_changed-${owner.userId}-${NOW.getTime() + 15 * 60_000}-locked`,
    );
  });

  test("never throws, whatever the provider or the database does", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const clinic = await seedClinic("glow");
    const owner = await seedPortalUser(clinic.clinicId, "owner");
    const factorId = await seedPasskey(owner.userId);
    const failing: EmailTransport = {
      name: "failing",
      send: async () => {
        throw new Error("network down");
      },
    };
    await expect(
      notifyDeviceChange({ userId: owner.userId, kind: "added", factorId }, { transport: failing }),
    ).resolves.toBeUndefined();
    await expect(
      notifyDeviceChange({ userId: "usr_nobody", kind: "locked" }, { transport: failing }),
    ).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});
