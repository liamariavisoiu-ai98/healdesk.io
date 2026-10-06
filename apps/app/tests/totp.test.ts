import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  base32Decode,
  base32Encode,
  checkSecondFactorCode,
  enrolTotp,
  hashBackupCode,
  hotp,
  matchTotpStep,
  normaliseBackupCode,
  proposeTotp,
  regenerateBackupCodes,
  totpAt,
  totpEnrolmentUri,
  totpStep,
} from "@/lib/factors/totp";
import { LOCKOUT_THRESHOLD } from "@/lib/factors/lockout";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";

/**
 * The authenticator-app backup (plan Part D3): RFC 6238 on node:crypto, a
 * sealed secret, a replay guard, a lockout that lives in the database, and
 * backup codes that work once.
 *
 * The arithmetic is checked against the RFCs' own published vectors, and the
 * codes the database tests submit come from an independent HOTP written out
 * here, so agreement is evidence rather than the module agreeing with itself.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

const SEED_SHA1 = Buffer.from("12345678901234567890", "ascii");
const SEED_SHA256 = Buffer.from("12345678901234567890123456789012", "ascii");
const SEED_SHA512 = Buffer.from(
  "1234567890123456789012345678901234567890123456789012345678901234",
  "ascii",
);

describe("RFC 4226 and RFC 6238, against their published vectors", () => {
  test("HOTP (RFC 4226 Appendix D)", () => {
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    expected.forEach((code, counter) =>
      expect(hotp(SEED_SHA1, counter), String(counter)).toBe(code),
    );
  });

  test("TOTP (RFC 6238 Appendix B), eight digits, SHA-1, SHA-256 and SHA-512", () => {
    const vectors: [number, string, string, string][] = [
      [59, "94287082", "46119246", "90693936"],
      [1111111109, "07081804", "68084774", "25091201"],
      [1111111111, "14050471", "67062674", "99943326"],
      [1234567890, "89005924", "91819424", "93441116"],
      [2000000000, "69279037", "90698825", "38618901"],
      [20000000000, "65353130", "77737706", "47863826"],
    ];
    for (const [seconds, sha1, sha256, sha512] of vectors) {
      const at = new Date(seconds * 1000);
      expect(totpAt(SEED_SHA1, at, { digits: 8 }), `${seconds} sha1`).toBe(sha1);
      expect(totpAt(SEED_SHA256, at, { digits: 8, algorithm: "sha256" }), `${seconds} sha256`).toBe(
        sha256,
      );
      expect(totpAt(SEED_SHA512, at, { digits: 8, algorithm: "sha512" }), `${seconds} sha512`).toBe(
        sha512,
      );
      // What the portal uses: SHA-1, six digits, the same truncation.
      expect(totpAt(SEED_SHA1, at), `${seconds} six digits`).toBe(sha1.slice(2));
    }
  });

  test("T is whole thirty-second periods since the epoch", () => {
    expect(totpStep(new Date(59_000))).toBe(1);
    expect(totpStep(new Date(1111111109_000))).toBe(0x23523ec);
  });

  test("a code is accepted one step either side of now, and no further", () => {
    const step = totpStep(new Date(1234567890_000));
    expect(matchTotpStep(SEED_SHA1, hotp(SEED_SHA1, step), step)).toBe(step);
    expect(matchTotpStep(SEED_SHA1, hotp(SEED_SHA1, step - 1), step)).toBe(step - 1);
    expect(matchTotpStep(SEED_SHA1, hotp(SEED_SHA1, step + 1), step)).toBe(step + 1);
    expect(matchTotpStep(SEED_SHA1, hotp(SEED_SHA1, step - 2), step)).toBeNull();
    expect(matchTotpStep(SEED_SHA1, hotp(SEED_SHA1, step + 2), step)).toBeNull();
    for (const junk of ["", "12345", "1234567", "12345a", " 123456"]) {
      expect(matchTotpStep(SEED_SHA1, junk, step), junk).toBeNull();
    }
  });

  test("base32 (RFC 4648 §10, unpadded) round-trips, and refuses what isn't", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Encode(Buffer.from("fooba"))).toBe("MZXW6YTB");
    const secret = randomBytes(20);
    expect(base32Decode(base32Encode(secret))?.equals(secret)).toBe(true);
    expect(base32Decode("mzxw6ytboi")).toBeNull();
    expect(base32Decode("MZXW1YTB")).toBeNull();
  });

  test("the enrolment URI is the one authenticator apps read", () => {
    const uri = totpEnrolmentUri("JBSWY3DPEHPK3PXP", "info@glow spa.test");
    expect(uri).toBe(
      "otpauth://totp/healdesk%3Ainfo%40glow%20spa.test?secret=JBSWY3DPEHPK3PXP&issuer=healdesk&algorithm=SHA1&digits=6&period=30",
    );
  });

  test("backup codes are matched however they are typed", () => {
    expect(normaliseBackupCode(" abcde-fghjk ")).toBe("ABCDEFGHJK");
    expect(hashBackupCode("abcde fghjk").equals(hashBackupCode("ABCDE-FGHJK"))).toBe(true);
    expect(
      hashBackupCode("ABCDE-FGHJK").equals(createHash("sha256").update("ABCDEFGHJK").digest()),
    ).toBe(true);
  });
});

/** An independent RFC 4226 HOTP over a base32 secret, not the module's own. */
function codeFor(secretBase32: string, step: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let acc = 0;
  const bytes: number[] = [];
  for (const character of secretBase32) {
    acc = (acc << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest.readUInt8(19) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000).padStart(6, "0");
}

const STEP = 60_000_000; // a fixed T, far from now, so nothing depends on the clock
const at = (step: number) => new Date(step * 30_000 + 5_000);
const session = () => createHash("sha256").update(randomBytes(16)).digest();

async function seedUser(): Promise<{ id: string; email: string }> {
  const id = `usr_${randomUUID().slice(0, 12)}`;
  const email = `${id}@glowspa.test`;
  await getMigratorPool().query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, 'Owner', $2, false, now(), now())`,
    [id, email],
  );
  return { id, email };
}

/** A passkey and a live step-up on `sessionTokenHash`, as the migrator. */
async function seedStepUp(userId: string, sessionTokenHash: Buffer): Promise<void> {
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
     values ($1, 'passkey', 'Front desk Mac', $2, '\\x01', 0, true) returning id`,
    [userId, randomBytes(16).toString("base64url")],
  );
  await getMigratorPool().query(
    `insert into step_ups (session_token_hash, user_id, factor_id, device_label) values ($1, $2, $3, 'Front desk Mac')`,
    [sessionTokenHash, userId, rows[0]!.id],
  );
}

async function enrolled(): Promise<{
  userId: string;
  secret: string;
  backupCodes: string[];
  sessionTokenHash: Buffer;
}> {
  const owner = await seedUser();
  const sessionTokenHash = session();
  const proposal = proposeTotp({ userId: owner.id, email: owner.email });
  const result = await enrolTotp({
    userId: owner.id,
    sessionTokenHash,
    proposal: proposal.proposal,
    code: codeFor(proposal.secret, STEP),
    at: at(STEP),
  });
  if (!result.ok) throw new Error(`enrolment failed: ${result.reason}`);
  return {
    userId: owner.id,
    secret: proposal.secret,
    backupCodes: result.backupCodes,
    sessionTokenHash,
  };
}

describeDb("the authenticator backup", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closePools();
  });

  test("enrolment seals the secret, spends the code that proved it, and returns ten backup codes once", async () => {
    const { userId, secret, backupCodes } = await enrolled();
    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10);
    for (const code of backupCodes)
      expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/);

    const pool = getMigratorPool();
    const { rows } = await pool.query<{ sealed: string; last_step: string }>(
      `select secret_sealed::text as sealed, last_step from user_factors where user_id = $1 and kind = 'totp'`,
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sealed).not.toContain(secret);
    expect(rows[0]!.sealed).toContain("wrappedDek");
    expect(Number(rows[0]!.last_step)).toBe(STEP);

    const codes = await pool.query<{ code_hash: Buffer }>(
      `select code_hash from user_backup_codes where user_id = $1`,
      [userId],
    );
    expect(codes.rows.map((r) => r.code_hash.toString("hex")).sort()).toEqual(
      backupCodes.map((c) => hashBackupCode(c).toString("hex")).sort(),
    );

    const events = await pool.query<{ event: string; metadata: unknown }>(
      `select event, metadata from security_events where user_id = $1 order by event`,
      [userId],
    );
    expect(events.rows.map((r) => r.event)).toEqual(["backup_codes_generated", "totp_enrolled"]);
    expect(JSON.stringify(events.rows)).not.toContain(secret);
    for (const code of backupCodes) expect(JSON.stringify(events.rows)).not.toContain(code);

    // The code that enrolled is spent: it cannot then add a device.
    expect(await checkSecondFactorCode(userId, codeFor(secret, STEP), undefined, at(STEP))).toEqual(
      {
        ok: false,
        reason: "incorrect",
      },
    );
  });

  test("a wrong code, someone else's proposal, a tampered or a stale one enrol nothing", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const proposal = proposeTotp({ userId: owner.id, email: owner.email });
    const base = { userId: owner.id, sessionTokenHash: session(), at: at(STEP) };

    expect(
      await enrolTotp({
        ...base,
        proposal: proposal.proposal,
        code: codeFor(proposal.secret, STEP + 3),
      }),
    ).toEqual({
      ok: false,
      reason: "code_incorrect",
    });
    expect(
      await enrolTotp({
        ...base,
        userId: other.id,
        proposal: proposal.proposal,
        code: codeFor(proposal.secret, STEP),
      }),
    ).toEqual({ ok: false, reason: "proposal_expired" });
    const mac = proposal.proposal.split(".")[1];
    const forged = Buffer.from(
      JSON.stringify({ u: owner.id, s: "JBSWY3DPEHPK3PXP", t: Date.now() }),
    ).toString("base64url");
    expect(
      await enrolTotp({
        ...base,
        proposal: `${forged}.${mac}`,
        code: codeFor("JBSWY3DPEHPK3PXP", STEP),
      }),
    ).toEqual({
      ok: false,
      reason: "proposal_expired",
    });

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
    expect(
      await enrolTotp({
        ...base,
        proposal: proposal.proposal,
        code: codeFor(proposal.secret, STEP),
      }),
    ).toEqual({
      ok: false,
      reason: "proposal_expired",
    });
    const { rows } = await getMigratorPool().query(`select 1 from user_factors`);
    expect(rows).toHaveLength(0);
  });

  test("once a sign-in has a factor, enrolling or replacing the backup needs a step-up", async () => {
    const owner = await seedUser();
    const sessionTokenHash = session();
    await getMigratorPool().query(
      `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
       values ($1, 'passkey', 'Front desk Mac', $2, '\\x01', 0, true)`,
      [owner.id, randomBytes(16).toString("base64url")],
    );
    const proposal = proposeTotp({ userId: owner.id, email: owner.email });
    const attempt = () =>
      enrolTotp({
        userId: owner.id,
        sessionTokenHash,
        proposal: proposal.proposal,
        code: codeFor(proposal.secret, STEP),
        at: at(STEP),
      });
    expect(await attempt()).toEqual({ ok: false, reason: "needs_step_up" });
    expect(await regenerateBackupCodes({ userId: owner.id, sessionTokenHash })).toEqual({
      ok: false,
      reason: "needs_step_up",
    });

    await seedStepUp(owner.id, sessionTokenHash);
    expect((await attempt()).ok).toBe(true);
    // One authenticator secret per sign-in.
    const again = proposeTotp({ userId: owner.id, email: owner.email });
    expect(
      await enrolTotp({
        userId: owner.id,
        sessionTokenHash,
        proposal: again.proposal,
        code: codeFor(again.secret, STEP),
        at: at(STEP),
      }),
    ).toEqual({ ok: false, reason: "already_enrolled" });
  });

  test("each code works once: a step at or below the last one spent is refused", async () => {
    const { userId, secret } = await enrolled();
    const next = codeFor(secret, STEP + 1);
    expect(await checkSecondFactorCode(userId, next, undefined, at(STEP + 1))).toEqual({
      ok: true,
      method: "totp",
    });
    expect(await checkSecondFactorCode(userId, next, undefined, at(STEP + 1))).toEqual({
      ok: false,
      reason: "incorrect",
    });
    // The previous step's code is still inside the drift window, and still spent.
    expect(
      await checkSecondFactorCode(userId, codeFor(secret, STEP), undefined, at(STEP + 1)),
    ).toEqual({
      ok: false,
      reason: "incorrect",
    });
    // Two submissions of one fresh code at once: exactly one wins.
    const fresh = codeFor(secret, STEP + 2);
    const raced = await Promise.all([
      checkSecondFactorCode(userId, fresh, undefined, at(STEP + 2)),
      checkSecondFactorCode(userId, fresh, undefined, at(STEP + 2)),
    ]);
    expect(raced.filter((r) => r.ok)).toHaveLength(1);
  });

  test("five wrong codes lock code entry for fifteen minutes, in the database, and a right code then waits", async () => {
    const { userId, secret } = await enrolled();
    const wrong = codeFor(secret, STEP + 10);
    for (let i = 1; i < LOCKOUT_THRESHOLD; i += 1) {
      expect(await checkSecondFactorCode(userId, wrong, undefined, at(STEP + 1))).toEqual({
        ok: false,
        reason: "incorrect",
      });
    }
    const locked = await checkSecondFactorCode(userId, wrong, undefined, at(STEP + 1));
    expect(locked).toMatchObject({ ok: false, reason: "locked" });

    const pool = getMigratorPool();
    const { rows } = await pool.query<{ minutes: string; failures: number }>(
      `select extract(epoch from (locked_until - now())) / 60 as minutes, failures from factor_lockouts where user_id = $1`,
      [userId],
    );
    expect(Number(rows[0]!.minutes)).toBeGreaterThan(14);
    expect(Number(rows[0]!.minutes)).toBeLessThanOrEqual(15);
    const events = await pool.query(
      `select 1 from security_events where user_id = $1 and event = 'factor_locked_out'`,
      [userId],
    );
    expect(events.rows).toHaveLength(1);

    // The right code, during the lock, is refused unread and does not count.
    expect(
      await checkSecondFactorCode(userId, codeFor(secret, STEP + 1), undefined, at(STEP + 1)),
    ).toMatchObject({
      ok: false,
      reason: "locked",
    });
    // The lock lapses; the right code works and clears the count.
    await pool.query(
      `update factor_lockouts set locked_until = now() - interval '1 second' where user_id = $1`,
      [userId],
    );
    expect(
      await checkSecondFactorCode(userId, codeFor(secret, STEP + 1), undefined, at(STEP + 1)),
    ).toEqual({
      ok: true,
      method: "totp",
    });
  });

  test("wrong codes further apart than fifteen minutes are not counted together", async () => {
    const { userId, secret } = await enrolled();
    const wrong = codeFor(secret, STEP + 10);
    for (let i = 1; i < LOCKOUT_THRESHOLD; i += 1)
      await checkSecondFactorCode(userId, wrong, undefined, at(STEP + 1));
    await getMigratorPool().query(
      `update factor_lockouts set window_started_at = now() - interval '16 minutes' where user_id = $1`,
      [userId],
    );
    expect(await checkSecondFactorCode(userId, wrong, undefined, at(STEP + 1))).toEqual({
      ok: false,
      reason: "incorrect",
    });
    const { rows } = await getMigratorPool().query<{ failures: number }>(
      `select failures from factor_lockouts where user_id = $1`,
      [userId],
    );
    expect(rows[0]!.failures).toBe(1);
  });

  test("a backup code works once, however it is typed, and a new set retires the old", async () => {
    const { userId, backupCodes, sessionTokenHash } = await enrolled();
    const [first, second] = backupCodes as [string, string];
    const typed = ` ${first.toLowerCase().replace("-", " ")} `;
    expect(await checkSecondFactorCode(userId, typed)).toEqual({ ok: true, method: "backup_code" });
    expect(await checkSecondFactorCode(userId, first)).toEqual({ ok: false, reason: "incorrect" });

    await seedStepUp(userId, sessionTokenHash);
    const fresh = await regenerateBackupCodes({ userId, sessionTokenHash });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.backupCodes).toHaveLength(10);
    // The old set's unspent code no longer works; the new set's does.
    expect(await checkSecondFactorCode(userId, second)).toEqual({ ok: false, reason: "incorrect" });
    expect(await checkSecondFactorCode(userId, fresh.backupCodes[0]!)).toEqual({
      ok: true,
      method: "backup_code",
    });

    const { rows } = await getMigratorPool().query<{ live: number; used: number; revoked: number }>(
      `select count(*) filter (where used_at is null and revoked_at is null)::int as live,
              count(*) filter (where used_at is not null)::int as used,
              count(*) filter (where revoked_at is not null)::int as revoked
         from user_backup_codes where user_id = $1`,
      [userId],
    );
    expect(rows[0]).toEqual({ live: 9, used: 2, revoked: 9 });
  });

  test("a sign-in with no backup at all has no code that works", async () => {
    const owner = await seedUser();
    expect(await checkSecondFactorCode(owner.id, "123456")).toEqual({
      ok: false,
      reason: "incorrect",
    });
    expect(await checkSecondFactorCode(owner.id, "ABCDE-FGHJK")).toEqual({
      ok: false,
      reason: "incorrect",
    });
    expect(await checkSecondFactorCode(owner.id, { not: "a code" })).toEqual({
      ok: false,
      reason: "incorrect",
    });
  });
});
