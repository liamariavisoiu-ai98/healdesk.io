import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { someoneLeft } from "@/lib/factors/someone-left";
import { hashSessionToken } from "@/lib/factors/step-ups";
import { readSignInFactors } from "@/lib/portal/devices";
import type { DeliveryResult, EmailTransport } from "@/lib/reporting/deliver";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { seedClinic } from "./setup/factories";

/**
 * "Someone left" (plan Part D3; spec, "Who gets access"): behind a passkey
 * step-up on this session, every session of the clinic's one sign-in ends,
 * the devices picked are removed, and the authenticator backup and backup
 * codes are revoked, in one transaction, and the address hears about it (O3).
 * The devices not picked keep their passkeys.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

type Fixture = {
  userId: string;
  sessionTokens: string[];
  passkeys: string[];
};

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getMigratorPool().query<T>(text, values)).rows;
}

/** A sign-in with three devices, an authenticator app, ten backup codes and two sessions. */
async function fixture(label: string): Promise<Fixture> {
  const clinic = await seedClinic(label);
  const userId = clinic.staffUserId;
  const passkeys: string[] = [];
  for (const device of ["Front desk Mac", "Maria's iPhone", "Back office PC"]) {
    const id = randomUUID();
    passkeys.push(id);
    await sql(
      `insert into user_factors (id, user_id, kind, device_label, credential_id, public_key, counter, transports, backed_up)
       values ($1, $2, 'passkey', $3, $4, $5, 0, '{internal}', true)`,
      [id, userId, device, randomBytes(16).toString("base64url"), randomBytes(77)],
    );
  }
  await sql(
    `insert into user_factors (id, user_id, kind, secret_sealed, last_step)
     values ($1, $2, 'totp', '{"v":1}'::jsonb, 0)`,
    [randomUUID(), userId],
  );
  for (let i = 0; i < 10; i += 1) {
    await sql(`insert into user_backup_codes (user_id, code_hash) values ($1, $2)`, [
      userId,
      createHash("sha256").update(randomBytes(8)).digest(),
    ]);
  }
  const sessionTokens: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const token = randomBytes(24).toString("base64url");
    sessionTokens.push(token);
    await sql(
      `insert into "session" (id, expires_at, token, updated_at, user_id)
       values ($1, now() + interval '14 days', $2, now(), $3)`,
      [randomUUID(), token, userId],
    );
  }
  return { userId, sessionTokens, passkeys };
}

function bindingFor(f: Fixture, n = 0) {
  return { userId: f.userId, sessionTokenHash: hashSessionToken(f.sessionTokens[n]!) };
}

async function stepUp(f: Fixture, factorId: string, n = 0) {
  await sql(
    `insert into step_ups (session_token_hash, user_id, factor_id, device_label) values ($1, $2, $3, 'Front desk Mac')`,
    [hashSessionToken(f.sessionTokens[n]!), f.userId, factorId],
  );
}

/** Captures the O3 email instead of sending it. */
function capture(): EmailTransport & { sent: { to: string; subject: string; text: string }[] } {
  const sent: { to: string; subject: string; text: string }[] = [];
  return {
    sent,
    async send(recipient, message): Promise<DeliveryResult> {
      sent.push({ to: recipient.to, subject: message.subject, text: message.text });
      return { status: "sent", messageId: `msg-${sent.length}` };
    },
  } as EmailTransport & { sent: { to: string; subject: string; text: string }[] };
}

describeDb("Someone left", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 120_000);

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePools();
  });

  test("refused without a passkey step-up on this session: nothing changes", async () => {
    const f = await fixture("nostep");
    expect(
      await someoneLeft({ session: bindingFor(f), removeFactorIds: [f.passkeys[1]!] }),
    ).toEqual({ ok: false, reason: "needs_step_up" });
    expect(
      await sql(`select count(*)::int as n from "session" where user_id = $1`, [f.userId]),
    ).toEqual([{ n: 2 }]);
    const factors = await readSignInFactors(f.userId, bindingFor(f));
    expect(factors.devices).toHaveLength(3);
    expect(factors.hasBackup).toBe(true);
    expect(factors.backupCodesLeft).toBe(10);
    expect(factors.steppedUp).toBe(false);
  });

  test("every session ends, the devices picked go, the backup and codes are revoked, and the others stay", async () => {
    const f = await fixture("left");
    await stepUp(f, f.passkeys[0]!);
    const before = await readSignInFactors(f.userId, bindingFor(f));
    expect(before.steppedUp).toBe(true);
    expect(before.devices.find((d) => d.isThisSession)?.label).toBe("Front desk Mac");

    const result = await someoneLeft({
      session: bindingFor(f),
      removeFactorIds: [f.passkeys[1]!],
      request: { ipAddress: "203.0.113.9", userAgent: "test" },
    });
    expect(result).toEqual({ ok: true, removedDevices: 1, sessionsEnded: 2 });

    expect(
      await sql(`select count(*)::int as n from "session" where user_id = $1`, [f.userId]),
    ).toEqual([{ n: 0 }]);
    expect(
      await sql(
        `select count(*)::int as n from step_ups where user_id = $1 and revoked_at is null`,
        [f.userId],
      ),
    ).toEqual([{ n: 0 }]);
    const after = await readSignInFactors(f.userId, null);
    expect(after.devices.map((d) => d.label)).toEqual(["Front desk Mac", "Back office PC"]);
    expect(after.hasBackup).toBe(false);
    expect(after.backupCodesLeft).toBe(0);

    const events = await sql<{ metadata: Record<string, unknown> }>(
      `select metadata from security_events where event = 'someone_left' and user_id = $1`,
      [f.userId],
    );
    expect(events).toEqual([
      {
        metadata: {
          viaFactorId: f.passkeys[0],
          devicesRemoved: 1,
          backupReset: true,
          codesRevoked: 10,
          sessionsEnded: 2,
        },
      },
    ]);
  });

  test("a device that is not this sign-in's stops the whole action", async () => {
    const f = await fixture("stale");
    const other = await fixture("other");
    await stepUp(f, f.passkeys[0]!);
    expect(
      await someoneLeft({ session: bindingFor(f), removeFactorIds: [other.passkeys[0]!] }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await sql(`select count(*)::int as n from "session" where user_id = $1`, [f.userId]),
    ).toEqual([{ n: 2 }]);
    expect((await readSignInFactors(other.userId, null)).devices).toHaveLength(3);
  });

  test("the address is told, in one email that names no device", async () => {
    const f = await fixture("told");
    await stepUp(f, f.passkeys[0]!);
    const transport = capture();
    const { notifyDeviceChange } = await import("@/lib/notices/device-changes");
    await notifyDeviceChange(
      { userId: f.userId, kind: "signed_out", removedCount: 2 },
      { transport, now: new Date("2026-10-07T18:32:00Z") },
    );
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      to: "told@example-clinic.test",
      subject: "Everyone was signed out of your healdesk sign-in",
    });
    expect(transport.sent[0]!.text).toContain("2 devices were removed");
    expect(transport.sent[0]!.text).toContain(
      "authenticator-app backup and backup codes were reset",
    );
  });
});
