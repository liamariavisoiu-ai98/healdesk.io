import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedPortalUser } from "./setup/factories";

/**
 * The portal's door (plan Part D4): `requirePortal(slug)` on every page and
 * server action. With no session it sends the browser to sign in, whatever
 * the slug, so the redirect reveals nothing; signed in without a grant on
 * this clinic, the answer is "not found", the same as a slug that does not
 * exist. Grants come from app_user_clinic_grants, so a revoked membership
 * stops opening the door at once.
 */

const mocks = vi.hoisted(() => {
  class NavigationSignal extends Error {
    constructor(
      readonly kind: "redirect" | "notFound",
      readonly url?: string,
    ) {
      super(kind === "redirect" ? "NEXT_REDIRECT" : "NEXT_NOT_FOUND");
    }
  }
  return {
    NavigationSignal,
    session: { userId: null as string | null },
  };
});

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.NavigationSignal("redirect", url);
  },
  notFound: () => {
    throw new mocks.NavigationSignal("notFound");
  },
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () => (mocks.session.userId ? { user: { id: mocks.session.userId } } : null),
    },
  },
}));

const { requirePortal } = await import("@/lib/portal/access");

const describeDb = hasTestDatabase ? describe : describe.skip;

async function outcome(slug: string) {
  try {
    return { ok: true as const, context: await requirePortal(slug) };
  } catch (error) {
    if (error instanceof mocks.NavigationSignal) return { ok: false as const, kind: error.kind, url: error.url };
    throw error;
  }
}

describeDb("requirePortal", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    mocks.session.userId = null;
  });

  afterAll(async () => {
    await closePools();
  });

  test("with no session, sends the browser to sign in, for a real slug and a made-up one alike", async () => {
    const clinic = await seedClinic("glow");
    expect(await outcome(clinic.slug)).toEqual({
      ok: false,
      kind: "redirect",
      url: `/sign-in?next=${encodeURIComponent(`/c/${clinic.slug}`)}`,
    });
    expect((await outcome("no-such-clinic")).kind).toBe("redirect");
  });

  test("the clinic's own sign-in gets its context", async () => {
    const clinic = await seedClinic("glow");
    const owner = await seedPortalUser(clinic.clinicId, "owner");
    mocks.session.userId = owner.userId;
    expect(await outcome(clinic.slug)).toEqual({
      ok: true,
      context: { userId: owner.userId, clinicId: clinic.clinicId, clinicSlug: clinic.slug },
    });
  });

  test("another clinic's sign-in, an unknown slug and a revoked grant all read as not found", async () => {
    const glow = await seedClinic("glow");
    const other = await seedClinic("other");
    const stranger = await seedPortalUser(other.clinicId, "owner");
    mocks.session.userId = stranger.userId;
    expect(await outcome(glow.slug)).toEqual({ ok: false, kind: "notFound", url: undefined });
    expect(await outcome("no-such-clinic")).toEqual({ ok: false, kind: "notFound", url: undefined });

    const owner = await seedPortalUser(glow.clinicId, "owner");
    mocks.session.userId = owner.userId;
    expect((await outcome(glow.slug)).ok).toBe(true);
    await inTenant(glow.clinicId, (client) =>
      client.query(`update clinic_memberships set revoked_at = now() where user_id = $1`, [owner.userId]),
    );
    expect(await outcome(glow.slug)).toEqual({ ok: false, kind: "notFound", url: undefined });
  });
});
