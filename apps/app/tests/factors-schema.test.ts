import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import nextConfig from "../next.config";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";

/**
 * drizzle/0046 (the portal's second factors and step-up), asserted.
 *
 * The factor tables are the record of which device could open patient data,
 * and when, so what matters is what the runtime role cannot do to them: no
 * DELETE anywhere, UPDATE of the moving columns only, and triggers that stop
 * those columns moving back (an un-revoked passkey, a re-armed challenge, a
 * counter or a TOTP step wound back for a replay). The CHECKs keep each kind
 * of factor to its own columns and each window to its length.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

type Client = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

/** One block on the RUNTIME role, always rolled back. Identity plane: no tenant. */
async function asApp<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    return await fn(client as unknown as Client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

const TABLES = [
  "user_factors",
  "user_backup_codes",
  "webauthn_challenges",
  "step_ups",
  "factor_lockouts",
];

async function tablePrivileges(table: string): Promise<Record<string, boolean>> {
  const { rows } = await getMigratorPool().query<Record<string, boolean>>(
    `select has_table_privilege('healdesk_app', $1::regclass, 'SELECT') as select,
            has_table_privilege('healdesk_app', $1::regclass, 'INSERT') as insert,
            has_table_privilege('healdesk_app', $1::regclass, 'UPDATE') as update,
            has_table_privilege('healdesk_app', $1::regclass, 'DELETE') as delete`,
    [table],
  );
  return rows[0]!;
}

async function updatableColumns(table: string): Promise<string[]> {
  const { rows } = await getMigratorPool().query<{ attname: string }>(
    `select a.attname
       from pg_attribute a
      where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege('healdesk_app', a.attrelid, a.attnum, 'UPDATE')
      order by a.attname`,
    [table],
  );
  return rows.map((r) => r.attname);
}

const digest = () => createHash("sha256").update(randomBytes(16)).digest();

async function seedUser(): Promise<string> {
  const id = `usr_${randomUUID().slice(0, 12)}`;
  await getMigratorPool().query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, 'Owner', $2, false, now(), now())`,
    [id, `${id}@glowspa.test`],
  );
  return id;
}

async function seedPasskey(userId: string, counter = 3): Promise<string> {
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, transports, backed_up)
     values ($1, 'passkey', 'Front desk Mac', $2, $3, $4, array['internal','hybrid'], true) returning id`,
    [userId, randomBytes(16).toString("base64url"), randomBytes(77), counter],
  );
  return rows[0]!.id;
}

describeDb("drizzle/0046: the portal's second factors and step-up", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("the factor tables are identity plane: no clinic_id, so no tenant policy hides them", async () => {
    const { rows } = await getMigratorPool().query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'clinic_id' and table_name = any($1::text[])`,
      [TABLES],
    );
    expect(rows).toEqual([]);
  });

  test("the runtime role may read and add, never delete, and update only the moving columns", async () => {
    for (const table of TABLES) {
      expect(await tablePrivileges(table), table).toEqual({
        select: true,
        insert: true,
        update: false,
        delete: false,
      });
    }
    expect(await updatableColumns("user_factors")).toEqual([
      "counter",
      "last_step",
      "last_used_at",
      "revoked_at",
    ]);
    expect(await updatableColumns("user_backup_codes")).toEqual(["revoked_at", "used_at"]);
    expect(await updatableColumns("webauthn_challenges")).toEqual(["used_at"]);
    expect(await updatableColumns("step_ups")).toEqual(["last_activity_at", "revoked_at"]);
    expect(await updatableColumns("factor_lockouts")).toEqual([
      "failures",
      "locked_until",
      "updated_at",
      "window_started_at",
    ]);
  });

  test("a passkey can't be re-pointed, deleted, un-revoked or have its counter wound back", async () => {
    const userId = await seedUser();
    const factorId = await seedPasskey(userId, 7);

    for (const statement of [
      `update user_factors set public_key = '\\x00'::bytea where id = $1`,
      `update user_factors set credential_id = 'someone-elses' where id = $1`,
      `update user_factors set device_label = 'Renamed' where id = $1`,
      `update user_factors set user_id = 'usr_other' where id = $1`,
      `delete from user_factors where id = $1`,
    ]) {
      await asApp(async (c) => {
        await expect(c.query(statement, [factorId]), statement).rejects.toMatchObject({
          code: "42501",
        });
      });
    }
    // The counter moves forward, never back, whoever asks.
    await asApp(async (c) => {
      const { rows } = await c.query(
        `update user_factors set counter = 8 where id = $1 returning id`,
        [factorId],
      );
      expect(rows).toHaveLength(1);
    });
    await expect(
      getMigratorPool().query(`update user_factors set counter = 6 where id = $1`, [factorId]),
    ).rejects.toMatchObject({ code: "42501" });

    // Revoked is final.
    await getMigratorPool().query(`update user_factors set revoked_at = now() where id = $1`, [
      factorId,
    ]);
    await asApp(async (c) => {
      await expect(
        c.query(`update user_factors set revoked_at = null where id = $1`, [factorId]),
      ).rejects.toMatchObject({
        code: "42501",
      });
    });
  });

  test("a spent TOTP step stays spent", async () => {
    const userId = await seedUser();
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into user_factors (user_id, kind, secret_sealed, last_step) values ($1, 'totp', '{"ciphertext":"x"}'::jsonb, 100) returning id`,
      [userId],
    );
    const id = rows[0]!.id;
    await asApp(async (c) => {
      await expect(
        c.query(`update user_factors set last_step = 99 where id = $1`, [id]),
      ).rejects.toMatchObject({
        code: "42501",
      });
    });
    await asApp(async (c) => {
      await expect(
        c.query(
          `update user_factors set secret_sealed = '{"ciphertext":"mine"}'::jsonb where id = $1`,
          [id],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  test("each kind keeps to its own columns, one authenticator secret per sign-in, and names stay names", async () => {
    const userId = await seedUser();
    const pool = getMigratorPool();
    // A passkey needs its device's name.
    await expect(
      pool.query(
        `insert into user_factors (user_id, kind, credential_id, public_key, counter, backed_up) values ($1, 'passkey', 'abc', '\\x01', 0, false)`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // A TOTP row may not carry a credential.
    await expect(
      pool.query(
        `insert into user_factors (user_id, kind, secret_sealed, last_step, credential_id) values ($1, 'totp', '{}'::jsonb, 0, 'abc')`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // Names: at most 60 characters, trimmed, no control characters.
    for (const label of ["x".repeat(61), " padded", "tab\tinside", ""]) {
      await expect(
        pool.query(
          `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
           values ($1, 'passkey', $2, $3, '\\x01', 0, false)`,
          [userId, label, randomBytes(16).toString("base64url")],
        ),
        JSON.stringify(label),
      ).rejects.toMatchObject({ code: "23514" });
    }
    await pool.query(
      `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
       values ($1, 'passkey', $2, $3, '\\x01', 0, false)`,
      [userId, "Maria’s iPhone 📱", randomBytes(16).toString("base64url")],
    );
    // One active authenticator secret; a revoked one makes room.
    await pool.query(
      `insert into user_factors (user_id, kind, secret_sealed, last_step) values ($1, 'totp', '{}'::jsonb, 0)`,
      [userId],
    );
    await expect(
      pool.query(
        `insert into user_factors (user_id, kind, secret_sealed, last_step) values ($1, 'totp', '{}'::jsonb, 0)`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await pool.query(
      `update user_factors set revoked_at = now() where user_id = $1 and kind = 'totp'`,
      [userId],
    );
    await pool.query(
      `insert into user_factors (user_id, kind, secret_sealed, last_step) values ($1, 'totp', '{}'::jsonb, 0)`,
      [userId],
    );
  });

  test("a consumed challenge can't be re-armed, and none lives longer than five minutes", async () => {
    const userId = await seedUser();
    const pool = getMigratorPool();
    await expect(
      pool.query(
        `insert into webauthn_challenges (user_id, session_token_hash, purpose, challenge, expires_at)
         values ($1, $2, 'authenticate', $3, now() + interval '6 minutes')`,
        [userId, digest(), randomBytes(32).toString("base64url")],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // A registration must say what allowed it; a step-up must not.
    await expect(
      pool.query(
        `insert into webauthn_challenges (user_id, session_token_hash, purpose, challenge, expires_at)
         values ($1, $2, 'register', $3, now() + interval '5 minutes')`,
        [userId, digest(), randomBytes(32).toString("base64url")],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const { rows } = await pool.query<{ id: string }>(
      `insert into webauthn_challenges (user_id, session_token_hash, purpose, challenge, expires_at)
       values ($1, $2, 'authenticate', $3, now() + interval '5 minutes') returning id`,
      [userId, digest(), randomBytes(32).toString("base64url")],
    );
    const id = rows[0]!.id;
    await asApp(async (c) => {
      await expect(
        c.query(
          `update webauthn_challenges set expires_at = now() + interval '1 year' where id = $1`,
          [id],
        ),
      ).rejects.toMatchObject({
        code: "42501",
      });
    });
    await pool.query(`update webauthn_challenges set used_at = now() where id = $1`, [id]);
    // One refusal per transaction: after the first, Postgres refuses the rest unread.
    await asApp(async (c) => {
      await expect(
        c.query(`update webauthn_challenges set used_at = null where id = $1`, [id]),
      ).rejects.toMatchObject({
        code: "42501",
      });
    });
    await asApp(async (c) => {
      await expect(
        c.query(`delete from webauthn_challenges where id = $1`, [id]),
      ).rejects.toMatchObject({
        code: "42501",
      });
    });
  });

  test("a spent backup code can't be spent again or un-spent", async () => {
    const userId = await seedUser();
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into user_backup_codes (user_id, code_hash) values ($1, $2) returning id`,
      [userId, digest()],
    );
    const id = rows[0]!.id;
    await asApp(async (c) => {
      const spent = await c.query(
        `update user_backup_codes set used_at = now() where id = $1 and used_at is null returning id`,
        [id],
      );
      expect(spent.rows).toHaveLength(1);
      await expect(
        c.query(`update user_backup_codes set used_at = null where id = $1`, [id]),
      ).rejects.toMatchObject({
        code: "42501",
      });
    });
    await asApp(async (c) => {
      await expect(
        c.query(`update user_backup_codes set code_hash = $2 where id = $1`, [id, digest()]),
      ).rejects.toMatchObject({
        code: "42501",
      });
    });
  });

  test("a step-up stays bound to its session and device, never runs backwards, and never outlives eight hours", async () => {
    const userId = await seedUser();
    const factorId = await seedPasskey(userId);
    const pool = getMigratorPool();
    await expect(
      pool.query(
        `insert into step_ups (session_token_hash, user_id, factor_id, device_label, created_at, last_activity_at)
         values ($1, $2, $3, 'Front desk Mac', now() - interval '9 hours', now())`,
        [digest(), userId, factorId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `insert into step_ups (session_token_hash, user_id, factor_id, device_label) values ('\\x0102', $1, $2, 'Mac')`,
        [userId, factorId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const { rows } = await pool.query<{ id: string }>(
      `insert into step_ups (session_token_hash, user_id, factor_id, device_label) values ($1, $2, $3, 'Front desk Mac') returning id`,
      [digest(), userId, factorId],
    );
    const id = rows[0]!.id;
    for (const statement of [
      `update step_ups set session_token_hash = '\\x00' where id = $1`,
      `update step_ups set device_label = 'Someone else' where id = $1`,
      `update step_ups set last_activity_at = last_activity_at - interval '1 minute' where id = $1`,
      `delete from step_ups where id = $1`,
    ]) {
      await asApp(async (c) => {
        await expect(c.query(statement, [id]), statement).rejects.toMatchObject({ code: "42501" });
      });
    }
    await pool.query(`update step_ups set revoked_at = now() where id = $1`, [id]);
    await asApp(async (c) => {
      await expect(
        c.query(`update step_ups set revoked_at = null where id = $1`, [id]),
      ).rejects.toMatchObject({
        code: "42501",
      });
    });
  });

  test("the lockout counter belongs to its sign-in", async () => {
    const userId = await seedUser();
    await getMigratorPool().query(
      `insert into factor_lockouts (user_id, failures) values ($1, 4)`,
      [userId],
    );
    await asApp(async (c) => {
      await expect(
        c.query(`update factor_lockouts set user_id = 'usr_other' where user_id = $1`, [userId]),
      ).rejects.toMatchObject({
        code: "42501",
      });
    });
    await asApp(async (c) => {
      await expect(
        c.query(`delete from factor_lockouts where user_id = $1`, [userId]),
      ).rejects.toMatchObject({
        code: "42501",
      });
    });
  });
});

describe("headers", () => {
  test("passkeys are allowed from this app's own pages only", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = rules.find((r) => r.source === "/:path*");
    expect(all?.headers).toContainEqual({
      key: "Permissions-Policy",
      value: "publickey-credentials-get=(self), publickey-credentials-create=(self)",
    });
  });
});
