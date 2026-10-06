import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { auth } from "@/lib/auth";
import { hashSessionToken } from "@/lib/factors/step-ups";
import {
  consumeSignInLink,
  isSafeRedirect,
  issueSignInLink,
  lookUpSignInLink,
  maskEmail,
  SIGN_IN_LINK_TTL_MS,
} from "@/lib/sign-in/links";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";

/**
 * Sign-in links and the session they start (plan Part D1, design D4): the
 * only way into the clinic portal.
 *
 * What must hold: the token is never stored; looking a link up spends
 * nothing; spending it works once, however many browsers race for it; an
 * expired link is dead; one source mints one link; and the session endpoint
 * that a spent link unlocks has no HTTP route for anyone to call.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3001";

async function seedUser(email = `owner-${randomUUID().slice(0, 8)}@glowspa.test`): Promise<{ id: string; email: string }> {
  const id = `usr_${randomUUID().slice(0, 12)}`;
  await getMigratorPool().query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, false, now(), now())`,
    [id, "Owner", email],
  );
  return { id, email };
}

describe("redirect targets and masking", () => {
  test("only a path on this app may follow a sign-in", () => {
    expect(isSafeRedirect("/c/glow/setup")).toBe(true);
    for (const bad of ["//evil.test", "/\\evil.test", "/\tevil", "https://evil.test", "c/glow", "", null, 7]) {
      expect(isSafeRedirect(bad), String(bad)).toBe(false);
    }
  });

  test("an address is masked to its first letter and its domain", () => {
    expect(maskEmail("laura@glowspa.com")).toBe("l•••@glowspa.com");
    expect(maskEmail("nonsense")).toBe("•••");
  });
});

describeDb("sign-in links", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePools();
  });

  test("the token is returned once and only its digest is stored", async () => {
    const owner = await seedUser();
    const issued = await issueSignInLink({ userId: owner.id, purpose: "sign_in", issuedBy: "test" });
    expect(issued?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const { rows } = await getMigratorPool().query<{ token_hash: Buffer; ttl_ms: string }>(
      `select token_hash, extract(epoch from (expires_at - created_at)) * 1000 as ttl_ms from sign_in_links`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash.equals(createHash("sha256").update(issued!.token).digest())).toBe(true);
    expect(Math.abs(Number(rows[0]!.ttl_ms) - SIGN_IN_LINK_TTL_MS.sign_in)).toBeLessThan(2000);
  });

  test("looking a link up spends nothing; spending it works once", async () => {
    const owner = await seedUser("laura@glowspa.test");
    const issued = await issueSignInLink({ userId: owner.id, purpose: "welcome", redirectTo: "/c/glow/setup", issuedBy: "test" });

    const looked = await lookUpSignInLink(issued!.token);
    expect(looked).toMatchObject({ ok: true, userId: owner.id, email: "laura@glowspa.test", purpose: "welcome" });
    expect((await lookUpSignInLink(issued!.token)).ok).toBe(true);

    expect(await consumeSignInLink(issued!.token, "203.0.113.9")).toEqual({
      ok: true,
      userId: owner.id,
      purpose: "welcome",
      redirectTo: "/c/glow/setup",
    });
    expect(await consumeSignInLink(issued!.token, null)).toEqual({ ok: false, reason: "used" });
    expect(await lookUpSignInLink(issued!.token)).toEqual({ ok: false, reason: "used" });

    const { rows } = await getMigratorPool().query<{ consumed_ip: string }>(`select host(consumed_ip) as consumed_ip from sign_in_links`);
    expect(rows[0]!.consumed_ip).toBe("203.0.113.9");
  });

  test("of two browsers racing for one link, exactly one signs in", async () => {
    const owner = await seedUser();
    const issued = await issueSignInLink({ userId: owner.id, purpose: "sign_in", issuedBy: "test" });
    const results = await Promise.all([consumeSignInLink(issued!.token, null), consumeSignInLink(issued!.token, null)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  test("an expired link is dead, and a junk IP never costs a sign-in", async () => {
    const owner = await seedUser();
    // Written already expired: the no-rewrite trigger refuses moving an
    // existing link's expiry, from any role, which is the point of it.
    const staleToken = randomBytes(32).toString("base64url");
    await getMigratorPool().query(
      `insert into sign_in_links (user_id, token_hash, purpose, created_at, expires_at, issued_by)
       values ($1, $2, 'sign_in', now() - interval '2 hours', now() - interval '1 hour', 'test')`,
      [owner.id, createHash("sha256").update(staleToken).digest()],
    );
    expect(await lookUpSignInLink(staleToken)).toEqual({ ok: false, reason: "expired" });
    expect(await consumeSignInLink(staleToken, null)).toEqual({ ok: false, reason: "expired" });

    const fresh = await issueSignInLink({ userId: owner.id, purpose: "sign_in", issuedBy: "test" });
    expect((await consumeSignInLink(fresh!.token, "not-an-ip, 10.0.0.1")).ok).toBe(true);
    const { rows } = await getMigratorPool().query<{ consumed_ip: string | null }>(
      `select consumed_ip from sign_in_links where id = $1`,
      [fresh!.id],
    );
    expect(rows[0]!.consumed_ip).toBeNull();
  });

  test("anything that isn't one of our tokens is unknown", async () => {
    for (const bad of ["", "short", "x".repeat(43).replace("x", "*"), null, 42, ["a"]]) {
      expect(await lookUpSignInLink(bad)).toEqual({ ok: false, reason: "unknown" });
      expect(await consumeSignInLink(bad, null)).toEqual({ ok: false, reason: "unknown" });
    }
    expect(await lookUpSignInLink("A".repeat(43))).toEqual({ ok: false, reason: "unknown" });
  });

  test("one source mints one link of a purpose", async () => {
    const owner = await seedUser();
    const ref = createHash("sha256").update("intent-ref").digest("hex");
    expect(await issueSignInLink({ userId: owner.id, purpose: "checkout", sourceRef: ref, issuedBy: "test" })).not.toBeNull();
    expect(await issueSignInLink({ userId: owner.id, purpose: "checkout", sourceRef: ref, issuedBy: "test" })).toBeNull();
    expect(await issueSignInLink({ userId: owner.id, purpose: "welcome", sourceRef: ref, issuedBy: "test" })).not.toBeNull();
  });

  test("a link may not be minted to land off this app", async () => {
    const owner = await seedUser();
    await expect(
      issueSignInLink({ userId: owner.id, purpose: "sign_in", redirectTo: "//evil.test", issuedBy: "test" }),
    ).rejects.toThrow(/path of this app/);
  });
});

describeDb("the session a spent link starts", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePools();
  });

  test("starts a fourteen-day session and sets its cookie", async () => {
    const owner = await seedUser();
    const response = await auth.api.startLinkSession({
      body: { userId: owner.id },
      headers: new Headers(),
      asResponse: true,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/hd\.session_token=/);

    const { rows } = await getMigratorPool().query<{ days: string }>(
      `select extract(epoch from (expires_at - created_at)) / 86400 as days from session where user_id = $1`,
      [owner.id],
    );
    expect(rows).toHaveLength(1);
    expect(Math.round(Number(rows[0]!.days))).toBe(14);
  });

  test("has no HTTP route: nobody on the internet can ask for a session", async () => {
    const owner = await seedUser();
    for (const path of ["/api/auth/start-link-session", "/api/auth/startLinkSession"]) {
      const response = await auth.handler(
        new Request(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: owner.id }),
        }),
      );
      expect(response.status, path).toBe(404);
    }
    const { rows } = await getMigratorPool().query(`select 1 from session where user_id = $1`, [owner.id]);
    expect(rows).toHaveLength(0);
  });

  test("there is no password sign-in to try", async () => {
    const response = await auth.handler(
      new Request(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "anyone@glowspa.test", password: "correct horse battery" }),
      }),
    );
    expect(response.status).not.toBe(200);
  });

  test("signing out ends the session's passkey step-ups (plan Part D2)", async () => {
    const owner = await seedUser();
    const pool = getMigratorPool();
    const started = await auth.api.startLinkSession({
      body: { userId: owner.id },
      headers: new Headers(),
      asResponse: true,
    });
    const cookie = started.headers
      .getSetCookie()
      .find((c) => c.startsWith("hd.session_token="))!
      .split(";")[0]!;
    const { rows } = await pool.query<{ token: string }>(
      `select token from session where user_id = $1`,
      [owner.id],
    );
    const factor = await pool.query<{ id: string }>(
      `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
       values ($1, 'passkey', 'Front desk Mac', $2, '\\x01', 0, true) returning id`,
      [owner.id, randomBytes(16).toString("base64url")],
    );
    await pool.query(
      `insert into step_ups (session_token_hash, user_id, factor_id, device_label) values ($1, $2, $3, 'Front desk Mac')`,
      [hashSessionToken(rows[0]!.token), owner.id, factor.rows[0]!.id],
    );

    await auth.api.signOut({ headers: new Headers({ cookie }) });

    expect(
      (await pool.query(`select 1 from session where user_id = $1`, [owner.id])).rows,
    ).toHaveLength(0);
    const after = await pool.query<{ revoked_at: Date | null }>(
      `select revoked_at from step_ups where user_id = $1`,
      [owner.id],
    );
    expect(after.rows[0]!.revoked_at).not.toBeNull();
  });

  test("refuses a user that doesn't exist", async () => {
    await expect(
      auth.api.startLinkSession({ body: { userId: "usr_nobody" }, headers: new Headers() }),
    ).rejects.toThrow();
  });
});
