import { randomBytes } from "node:crypto";

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

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
 * Settings → Sign-in's address change (plan Part D4, D5), through its server
 * actions with the sign-in stood in, and the confirmation page as a browser
 * receives it: asking needs a passkey step-up, stopping does not, the card
 * shows a change under way, and the link's page confirms only on its POST.
 */

const portal = { userId: "", clinicId: "", clinicSlug: "" };
let steppedUp = false;
const touched = vi.fn();

vi.mock("@/lib/portal/access", () => ({
  requirePortal: async () => portal,
  portalGrants: async () => [],
  currentSessionToken: async () => null,
}));
vi.mock("@/lib/portal/actor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal/actor")>();
  return {
    SIGN_IN_ACTOR_LABEL: actual.SIGN_IN_ACTOR_LABEL,
    portalActor: async () =>
      steppedUp
        ? { label: "Front desk Mac", steppedUp: true }
        : { label: actual.SIGN_IN_ACTOR_LABEL, steppedUp: false },
  };
});
vi.mock("@/lib/portal/step-up", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal/step-up")>();
  return {
    ...actual,
    sessionBinding: async () => ({ userId: portal.userId, sessionTokenHash: randomBytes(32) }),
    stepUpPath: (slug: string, next: string) =>
      `/c/${slug}/step-up?next=${encodeURIComponent(next)}`,
    touchStepUp: async () => {
      touched();
      return null;
    },
  };
});
vi.mock("@/app/c/[slug]/request-meta", () => ({ requestMeta: async () => ({}) }));
// The development transport only logs (and reports "skipped"); these tests
// stand in a transport that accepts, so the action's toast is the sent one.
vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return {
    ...actual,
    sendEmail: (
      email: Parameters<typeof actual.sendEmail>[0],
      options: Parameters<typeof actual.sendEmail>[1] = {},
    ) =>
      actual.sendEmail(email, {
        ...options,
        transport: options.transport ?? {
          name: "fake",
          send: async () => ({ status: "sent", messageId: "msg_fake" }),
        },
      }),
  };
});
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, useRouter: () => ({ refresh: () => undefined }) };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "https://app.healdesk.test";
let clinic: PortalClinic;

async function changes() {
  return inTenant(
    clinic.clinicId,
    async (c) =>
      (
        await c.query<{ status: string; new_email: string; requested_by: string }>(
          `select status, new_email, requested_by from sign_in_address_changes order by created_at`,
        )
      ).rows,
  );
}

async function settingsHtml(): Promise<string> {
  const { default: SettingsPage } = await import("@/app/c/[slug]/settings/page");
  return renderToStaticMarkup(
    await SettingsPage({
      params: Promise.resolve({ slug: portal.clinicSlug }),
      searchParams: Promise.resolve({}),
    }),
  );
}

const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["BETTER_AUTH_URL"]) SAVED[key] = process.env[key];
  process.env.BETTER_AUTH_URL = ORIGIN;
  steppedUp = false;
  touched.mockClear();
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
    else (process.env as Record<string, string>)[key] = value;
  }
});

describeDb("Settings → Sign-in: the clinic's address", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    clinic = await provisionPortalClinic("address");
    Object.assign(portal, {
      userId: clinic.userId,
      clinicId: clinic.clinicId,
      clinicSlug: clinic.clinicSlug,
    });
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("asking without a step-up records nothing and points to the step-up", async () => {
    const { requestAddressChangeAction } = await import("@/app/c/[slug]/settings/address-actions");
    const result = await requestAddressChangeAction(portal.clinicSlug, "front@radiance.test");
    expect(result).toMatchObject({
      ok: false,
      stepUpHref: `/c/${portal.clinicSlug}/step-up?next=${encodeURIComponent(`/c/${portal.clinicSlug}/settings`)}`,
    });
    expect(await changes()).toEqual([]);
    expect(touched).not.toHaveBeenCalled();
    const html = await settingsHtml();
    expect(html).toContain("Change address");
    expect(html).not.toContain("Stop this change");
  });

  test("asking with a step-up sends the link, names the device, and the card shows the change under way", async () => {
    steppedUp = true;
    const { requestAddressChangeAction } = await import("@/app/c/[slug]/settings/address-actions");
    const result = await requestAddressChangeAction(portal.clinicSlug, "Front@Radiance.test");
    expect(result).toEqual({
      ok: true,
      toast: "We've emailed a link to front@radiance.test. Nothing changes until it's used.",
    });
    expect(touched).toHaveBeenCalledTimes(1);
    expect(await changes()).toEqual([
      {
        status: "awaiting_confirmation",
        new_email: "front@radiance.test",
        requested_by: "Front desk Mac",
      },
    ]);
    const html = await settingsHtml();
    expect(html).toContain('Changing to <span class="font-semibold">front@radiance.test</span>');
    expect(html).toContain("nothing changes until it&#x27;s used");
    expect(html).toContain("Stop this change");
  });

  test("stopping needs no step-up", async () => {
    steppedUp = false;
    const { stopAddressChangeAction } = await import("@/app/c/[slug]/settings/address-actions");
    expect(await stopAddressChangeAction(portal.clinicSlug)).toEqual({
      ok: true,
      toast: "Change stopped. The clinic's address stays as it is.",
    });
    expect((await changes()).map((c) => c.status)).toEqual(["stopped"]);
    const { rows } = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from security_events where event = 'sign_in_address_change_stopped'`,
    );
    expect(rows[0]!.n).toBe(1);
    expect(await settingsHtml()).toContain("Change address");
  });

  test("the link's page: a GET confirms nothing, and the POST confirms once", async () => {
    const { requestAddressChange } = await import("@/lib/sign-in/address-change");
    const sent: string[] = [];
    await requestAddressChange(
      {
        clinicId: clinic.clinicId,
        userId: clinic.userId,
        newEmail: "desk@radiance.test",
        requestedBy: "Front desk Mac",
        actor: { type: "user", userId: clinic.userId, label: "Front desk Mac" },
      },
      {
        transport: {
          name: "fake",
          send: async (_target, message) => {
            sent.push(message.text);
            return { status: "sent", messageId: "msg_1" };
          },
        },
      },
    );
    const token = /\/address-change\/([A-Za-z0-9_-]{43})/.exec(sent[0]!)![1]!;
    const { default: Page } = await import("@/app/address-change/[token]/page");
    const before = renderToStaticMarkup(await Page({ params: Promise.resolve({ token }) }));
    expect(before).toContain("Confirm this address");
    expect(before).toContain("d•••@radiance.test");
    expect((await changes()).at(-1)!.status).toBe("awaiting_confirmation");

    const { confirmAddressChange } = await import("@/lib/sign-in/address-change");
    expect(await confirmAddressChange(token)).toMatchObject({ ok: true });
    const after = renderToStaticMarkup(await Page({ params: Promise.resolve({ token }) }));
    expect(after).toContain("This address is confirmed.");
    expect(after).toContain("The change takes effect at");

    const unknown = renderToStaticMarkup(
      await Page({ params: Promise.resolve({ token: "z".repeat(43) }) }),
    );
    expect(unknown).toContain("This link isn&#x27;t valid.");
  });
});
