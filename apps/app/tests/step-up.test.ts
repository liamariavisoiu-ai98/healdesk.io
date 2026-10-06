import { randomBytes, randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { hashSessionToken } from "@/lib/factors/step-ups";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { seedClinic } from "./setup/factories";

/**
 * Step-up (plan Part D2): what a patient page asks of a session. A step-up
 * holds while it has been active in the last 15 minutes and is at most 8
 * hours old, and only while its passkey stands; each check counts as
 * activity. Without one, the page sends the browser to the step-up page with
 * a `next` that can only lead back into this clinic's portal.
 */

const mocks = vi.hoisted(() => {
  class NavigationSignal extends Error {
    constructor(readonly url: string) {
      super("NEXT_REDIRECT");
    }
  }
  return {
    NavigationSignal,
    session: { userId: null as string | null, token: null as string | null },
    headers: new Headers(),
  };
});

vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.NavigationSignal(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () =>
        mocks.session.userId
          ? { user: { id: mocks.session.userId }, session: { token: mocks.session.token } }
          : null,
    },
  },
}));

const { endStepUps, portalNext, requireStepUp, stepUpPath, touchStepUp } =
  await import("@/lib/portal/step-up");
const { proxy } = await import("@/proxy");

const describeDb = hasTestDatabase ? describe : describe.skip;

async function outcome<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; redirect: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof mocks.NavigationSignal) return { ok: false, redirect: error.url };
    throw error;
  }
}

describe("where a step-up may send the browser back to", () => {
  test("only a path on this clinic's own portal; anything else goes to its Home", () => {
    expect(portalNext("glow", "/c/glow/conversations")).toBe("/c/glow/conversations");
    expect(portalNext("glow", "/c/glow")).toBe("/c/glow");
    expect(portalNext("glow", "/c/glow/protect?next=%2Fc%2Fglow")).toBe(
      "/c/glow/protect?next=%2Fc%2Fglow",
    );
    for (const bad of [
      "//evil.test",
      "/\\evil.test",
      "https://evil.test/c/glow",
      "/c/glowing/conversations",
      "/c/other/conversations",
      "/c/glow/../other",
      "/c/glow/%2e%2e/other",
      "/c/glow/conversations#x",
      "/c/glow/\tx",
      "c/glow",
      "",
      null,
      ["/c/glow"],
    ]) {
      expect(portalNext("glow", bad), JSON.stringify(bad)).toBe("/c/glow");
    }
  });

  test("the step-up page's address carries `next` encoded", () => {
    expect(stepUpPath("glow", "/c/glow/bookings")).toBe(
      "/c/glow/step-up?next=%2Fc%2Fglow%2Fbookings",
    );
    expect(stepUpPath("glow", "//evil.test")).toBe("/c/glow/step-up?next=%2Fc%2Fglow");
  });

  test("the proxy tells a page its own path, and a client cannot choose it", () => {
    const response = proxy(
      new NextRequest("http://localhost:3001/c/glow/conversations?q=someone", {
        headers: { "x-healdesk-path": "/c/other/evil" },
      }),
    );
    expect(response.headers.get("x-middleware-request-x-healdesk-path")).toBe(
      "/c/glow/conversations",
    );
  });
});

describeDb("requireStepUp", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    mocks.headers = new Headers();
    mocks.session.userId = null;
    mocks.session.token = null;
  });

  afterAll(async () => {
    await closePools();
  });

  /** A clinic, its sign-in signed in on a session, and that sign-in's passkey. */
  async function signedIn() {
    const clinic = await seedClinic("stepup");
    const token = randomBytes(24).toString("base64url");
    mocks.session.userId = clinic.staffUserId;
    mocks.session.token = token;
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
       values ($1, 'passkey', 'Front desk Mac', $2, '\\x01', 0, true) returning id`,
      [clinic.staffUserId, randomBytes(16).toString("base64url")],
    );
    const ctx = { userId: clinic.staffUserId, clinicId: clinic.clinicId, clinicSlug: clinic.slug };
    return { clinic, ctx, token, factorId: rows[0]!.id };
  }

  async function stepUp(
    token: string,
    userId: string,
    factorId: string,
    ages: { createdMinutesAgo: number; activeMinutesAgo: number },
  ): Promise<string> {
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into step_ups (session_token_hash, user_id, factor_id, device_label, created_at, last_activity_at)
       values ($1, $2, $3, 'Front desk Mac', now() - $4 * interval '1 minute', now() - $5 * interval '1 minute') returning id`,
      [hashSessionToken(token), userId, factorId, ages.createdMinutesAgo, ages.activeMinutesAgo],
    );
    return rows[0]!.id;
  }

  test("with no step-up, the page sends the browser to step up and back to where it was", async () => {
    const { ctx, clinic } = await signedIn();
    mocks.headers = new Headers({ "x-healdesk-path": `/c/${clinic.slug}/conversations` });
    expect(await outcome(() => requireStepUp(ctx, "patient_pages"))).toEqual({
      ok: false,
      redirect: `/c/${clinic.slug}/step-up?next=${encodeURIComponent(`/c/${clinic.slug}/conversations`)}`,
    });
    // A page may say where to come back to; it still has to be this clinic's.
    expect(
      await outcome(() =>
        requireStepUp(ctx, "sensitive_change", { returnTo: `/c/${clinic.slug}/settings` }),
      ),
    ).toEqual({
      ok: false,
      redirect: `/c/${clinic.slug}/step-up?next=${encodeURIComponent(`/c/${clinic.slug}/settings`)}`,
    });
    expect(
      await outcome(() => requireStepUp(ctx, "patient_pages", { returnTo: "//evil.test" })),
    ).toEqual({
      ok: false,
      redirect: `/c/${clinic.slug}/step-up?next=${encodeURIComponent(`/c/${clinic.slug}`)}`,
    });
  });

  test("a live step-up names its passkey and device, and each check counts as activity", async () => {
    const { ctx, token, factorId } = await signedIn();
    const id = await stepUp(token, ctx.userId, factorId, {
      createdMinutesAgo: 60,
      activeMinutesAgo: 14,
    });
    const result = await outcome(() => requireStepUp(ctx, "patient_pages"));
    expect(result).toMatchObject({
      ok: true,
      value: { passkeyId: factorId, deviceLabel: "Front desk Mac" },
    });
    const { rows } = await getMigratorPool().query<{ idle_seconds: string }>(
      `select extract(epoch from (now() - last_activity_at)) as idle_seconds from step_ups where id = $1`,
      [id],
    );
    expect(Number(rows[0]!.idle_seconds)).toBeLessThan(5);
    // The same rule for a sensitive change, and for "Keep open".
    expect((await outcome(() => requireStepUp(ctx, "sensitive_change"))).ok).toBe(true);
    expect(await touchStepUp(ctx)).toMatchObject({ passkeyId: factorId });
  });

  test("fifteen minutes idle ends it", async () => {
    const { ctx, token, factorId } = await signedIn();
    await stepUp(token, ctx.userId, factorId, { createdMinutesAgo: 30, activeMinutesAgo: 16 });
    expect((await outcome(() => requireStepUp(ctx, "patient_pages"))).ok).toBe(false);
    expect(await touchStepUp(ctx)).toBeNull();
  });

  test("eight hours ends it, however busy", async () => {
    const { ctx, token, factorId } = await signedIn();
    await stepUp(token, ctx.userId, factorId, {
      createdMinutesAgo: 8 * 60 + 2,
      activeMinutesAgo: 3,
    });
    expect((await outcome(() => requireStepUp(ctx, "patient_pages"))).ok).toBe(false);
  });

  test("another session's step-up, or one whose passkey was removed, does not count", async () => {
    const { ctx, factorId } = await signedIn();
    await stepUp(randomBytes(24).toString("base64url"), ctx.userId, factorId, {
      createdMinutesAgo: 1,
      activeMinutesAgo: 1,
    });
    expect((await outcome(() => requireStepUp(ctx, "patient_pages"))).ok).toBe(false);

    await stepUp(mocks.session.token!, ctx.userId, factorId, {
      createdMinutesAgo: 1,
      activeMinutesAgo: 1,
    });
    expect((await outcome(() => requireStepUp(ctx, "patient_pages"))).ok).toBe(true);
    await getMigratorPool().query(`update user_factors set revoked_at = now() where id = $1`, [
      factorId,
    ]);
    expect((await outcome(() => requireStepUp(ctx, "patient_pages"))).ok).toBe(false);
  });

  test("a session with no token, or another sign-in's, is never stepped up", async () => {
    const { ctx, token, factorId } = await signedIn();
    await stepUp(token, ctx.userId, factorId, { createdMinutesAgo: 1, activeMinutesAgo: 1 });
    mocks.session.token = null;
    expect((await outcome(() => requireStepUp(ctx, "patient_pages"))).ok).toBe(false);
    mocks.session.token = token;
    expect(
      (
        await outcome(() =>
          requireStepUp({ ...ctx, userId: `usr_${randomUUID()}` }, "patient_pages"),
        )
      ).ok,
    ).toBe(false);
  });

  test("endStepUps ends a session's, a passkey's or a whole sign-in's", async () => {
    const { ctx, token, factorId } = await signedIn();
    const other = randomBytes(24).toString("base64url");
    await stepUp(token, ctx.userId, factorId, { createdMinutesAgo: 1, activeMinutesAgo: 1 });
    await stepUp(other, ctx.userId, factorId, { createdMinutesAgo: 1, activeMinutesAgo: 1 });

    expect(await endStepUps({ sessionToken: token })).toBe(1);
    expect((await outcome(() => requireStepUp(ctx, "patient_pages"))).ok).toBe(false);
    expect(await endStepUps({ sessionToken: token })).toBe(0);
    expect(await endStepUps({ factorId })).toBe(1);

    await stepUp(token, ctx.userId, factorId, { createdMinutesAgo: 1, activeMinutesAgo: 1 });
    expect(await endStepUps({ userId: ctx.userId })).toBe(1);
    const { rows } = await getMigratorPool().query(
      `select 1 from step_ups where revoked_at is null`,
    );
    expect(rows).toHaveLength(0);
  });
});
