import { randomBytes, randomUUID } from "node:crypto";

import {
  agreementPlatformFor,
  BAA_ASSENT_LABEL,
  CURRENT_BAA_VERSION,
  GOOGLE_CALENDAR_DISCLOSURE,
  renderGoogleCalendarDisclosure,
} from "@healdesk/catalog";
import {
  FAKE_GOOGLE_CLIENT,
  fakeGoogleCalendar,
  resetGoogleTokenCache,
  setGoogleFetch,
  type FakeGoogleCalendar,
} from "@healdesk/connectors";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { connectCalendar, disconnectCalendar } from "@/app/c/[slug]/setup/calendar-actions";
import { ProvidersScreen } from "@/app/c/[slug]/setup/screens/CalendarScreens";
import { CalendarStepView } from "@/app/c/[slug]/setup/screens/CalendarStepView";
import { signAgreement } from "@/lib/agreements";
import type { EmailToSend } from "@/lib/email/send";
import { effectiveBookingMode, setAutoConfirm } from "@/lib/booking/mode";
import {
  getCalendarConnection,
  markCalendarBroken,
  MAX_PROVIDERS,
} from "@/lib/connections/google-calendar";
import { completeGoogleSignIn } from "@/lib/connections/google-oauth";
import { __setKeyWrapperForTests } from "@/lib/crypto/kms";
import { provisionClinic } from "@/lib/provisioning";
import {
  autoConfirmFor,
  autoConfirmView,
  CALENDAR_NOTICES,
  calendarNoticeWords,
  calendarStep,
  readCalendarNotice,
  requestedScreen,
  type AutoConfirmView,
  type CalendarNotice,
  type CalendarStep,
} from "@/lib/setup/calendar";
import { providersStep } from "@/lib/setup/providers";
import { saveSetupScreen, type SaveContext } from "@/lib/setup/save";
import { readProgress } from "@/lib/setup/screens";
import { loadSetupState } from "@/lib/setup/state";
import { buildTracker } from "@/lib/setup/tracker";
import { withTenant } from "@/lib/tenant";
import { contentSecurityPolicy } from "@/proxy";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  inTenant,
  seedGoogleConnection,
  seedLegacyClinic,
  type SeedCalendarTermsInput,
} from "./setup/factories";

/**
 * Setup step 3 on the calendar session's functions (plan Part E, 3.1 and
 * 3.2): Sign in with Google only where startGoogleConnect would send the
 * practice to Google, the button's server action and the callback's way back
 * to the step, every `?calendar=` outcome in words, reconnecting and
 * disconnecting behind the step-up, named providers saved through
 * saveProviders and setProviderServices with booking_detail following them,
 * the tracker's calendar stage, and Auto-confirm's "Right now" line on the
 * calendar session's effectiveBookingMode.
 *
 * Google is the in-memory one, behind the connectors' fetch seam, and the
 * global fetch throws, as in the calendar session's own tests; every
 * calendar function runs for real. Next's request edge is stood in for (the
 * session, cookies and redirects), and so is the passkey step-up, which
 * tests/step-up.test.ts covers: here it is live or it is not.
 */

const mocks = vi.hoisted(() => {
  class NavigationSignal extends Error {
    constructor(readonly url: string) {
      super("NEXT_REDIRECT");
    }
  }
  class NotFoundSignal extends Error {
    constructor() {
      super("NEXT_NOT_FOUND");
    }
  }
  return {
    NavigationSignal,
    NotFoundSignal,
    session: { userId: null as string | null, token: null as string | null },
    cookies: [] as { name: string; value: string; options: Record<string, unknown> }[],
    steppedUp: false,
  };
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest" }),
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      mocks.cookies.push({ name, value, options });
    },
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.NavigationSignal(url);
  },
  notFound: () => {
    throw new mocks.NotFoundSignal();
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
vi.mock("@/lib/portal/step-up", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal/step-up")>();
  return {
    ...actual,
    requireStepUp: async (
      ctx: { clinicSlug: string },
      _purpose: string,
      options: { returnTo?: string } = {},
    ) => {
      if (mocks.steppedUp) {
        return { passkeyId: "passkey-test", deviceLabel: "Front desk Mac", at: new Date() };
      }
      throw new mocks.NavigationSignal(actual.stepUpPath(ctx.clinicSlug, options.returnTo ?? null));
    },
  };
});
vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return {
    ...actual,
    sendEmail: async (_email: EmailToSend) => ({ status: "sent", messageId: "m" }),
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const SERVICE = { type: "service", serviceName: "setup-calendar-test" } as const;
const SLOW = 120_000;
const ENV = ["BETTER_AUTH_URL", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

type Clinic = {
  clinicId: string;
  organizationId: string;
  slug: string;
  name: string;
  userId: string;
};

/**
 * A clinic as payment makes one: signed under BAA 1.3.0, the current version,
 * with `terms`'s two answers (Google Calendar in a Workspace under Google's
 * BAA unless they say otherwise), so provisioning records the location's
 * calendar terms from the signature (plan C15). With `terms` null, a clinic
 * on BAA 1.2.2 instead, as one bound before 1.3.0 replaced it: no calendar
 * terms until an election. Provisioning refuses 1.2.2 since then, so that
 * one is seedLegacyClinic's.
 */
async function provisioned(
  label: string,
  terms: SeedCalendarTermsInput | null = {},
): Promise<Clinic> {
  const email = `${label}-${randomUUID().slice(0, 8)}@glowspa.test`;
  if (!terms) {
    const legacy = await seedLegacyClinic(label, {
      name: "Glow Med Spa LLC",
      plan: "web-voice",
      contactName: "Laura Owner",
      contactEmail: email,
    });
    return {
      clinicId: legacy.clinicId,
      organizationId: legacy.organizationId,
      slug: legacy.slug,
      name: "Glow Med Spa LLC",
      userId: legacy.staffUserId,
    };
  }
  const bookingSystem = terms.bookingSystem ?? "google_calendar";
  const platform = agreementPlatformFor(bookingSystem);
  const signed = await signAgreement({
    clinicLegalName: "Glow Med Spa LLC",
    specialty: "med-spa",
    signatoryName: "Laura Owner",
    signatoryEmail: email,
    isCoveredEntity: false,
    attributionMode: "estimated",
    platform,
    bookingSystem,
    calendarAccount: terms.calendarAccount ?? "workspace_baa",
    assentLabel: BAA_ASSENT_LABEL,
    templateVersion: CURRENT_BAA_VERSION,
  });
  const result = await provisionClinic({
    clinicName: "Glow Med Spa LLC",
    specialty: "med-spa",
    platform,
    plan: "web-voice",
    contactName: "Laura Owner",
    contactEmail: email,
    agreementId: signed.agreementId,
    idempotencyKey: `idem-${randomUUID()}`,
  });
  return {
    clinicId: result.clinicId,
    organizationId: result.organizationId,
    slug: result.clinicSlug,
    name: "Glow Med Spa LLC",
    userId: result.ownerUserId!,
  };
}

/** The clinic's sign-in, as the session cookie would carry it. */
function signedInAs(clinic: Clinic): void {
  mocks.session.userId = clinic.userId;
  mocks.session.token = randomBytes(32).toString("base64url");
}

function contextOf(clinic: Clinic): SaveContext {
  return {
    clinicId: clinic.clinicId,
    slug: clinic.slug,
    userId: clinic.userId,
    actorLabel: "the clinic's sign-in",
  };
}

function actorOf(clinic: Clinic) {
  return { type: "user", userId: clinic.userId, label: "the clinic's sign-in" } as const;
}

/** Step 3.1's form, as the browser posts it. */
function connectForm(slug: string, ticked = true): FormData {
  const form = new FormData();
  form.set("slug", slug);
  form.set("disclosureVersion", GOOGLE_CALENDAR_DISCLOSURE.version);
  if (ticked) form.set("disclosure", "accepted");
  return form;
}

function slugForm(slug: string): FormData {
  const form = new FormData();
  form.set("slug", slug);
  return form;
}

/** Where a server action sent the browser. */
async function redirected(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof mocks.NavigationSignal) return error.url;
    throw error;
  }
  throw new Error("The action finished without a redirect.");
}

const NO_ACTIONS = { connect: async () => {}, disconnect: async () => {} };

const SAVED = { bookingSystem: "google_calendar", autoConfirmBookings: true } as const;

/** Auto-confirm before any calendar is connected, as effectiveBookingMode words it. */
const NOT_CONNECTED_LINE = autoConfirmView(SAVED, {
  mode: "requests",
  reason: { code: "calendar_not_connected", sentence: "Your Google Calendar isn't connected." },
  reasons: [{ code: "calendar_not_connected", sentence: "Your Google Calendar isn't connected." }],
});

/** Step 3.1 as the page renders it, as text: entities decoded, so sentences compare as written. */
function stepText(
  step: CalendarStep,
  notice: CalendarNotice | null = null,
  autoConfirm: AutoConfirmView = NOT_CONNECTED_LINE,
  steppedUp = false,
): string {
  return decode(
    renderToStaticMarkup(
      createElement(CalendarStepView, {
        slug: "glow",
        backHref: null,
        skipCost: "bookings arrive as requests your team confirms.",
        step,
        notice,
        bookingSystem: SAVED.bookingSystem,
        autoConfirm,
        timeZone: "America/New_York",
        steppedUp,
        actions: NO_ACTIONS,
      }),
    ),
  );
}

function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function oauthStates(clinicId: string) {
  return (
    await getMigratorPool().query<{
      initiated_via: string;
      user_id: string | null;
      return_to: string;
      disclosure_version: string;
    }>(
      `select initiated_via, user_id, return_to, disclosure_version
         from google_oauth_states where target_clinic_id = $1 order by expires_at`,
      [clinicId],
    )
  ).rows;
}

async function bookingDetailOf(clinic: Clinic): Promise<string | null> {
  return inTenant(
    clinic.clinicId,
    async (client) =>
      (
        await client.query<{ booking_detail: string }>(
          `select booking_detail from clinic_settings where clinic_id = $1`,
          [clinic.clinicId],
        )
      ).rows[0]?.booking_detail ?? null,
  );
}

async function providerRows(clinic: Clinic) {
  return inTenant(
    clinic.clinicId,
    async (client) =>
      (
        await client.query<{ display_name: string; calendar_id: string; services: string[] }>(
          `select p.display_name, p.calendar_id,
                  coalesce(array_agg(s.service_key order by s.service_key)
                           filter (where s.service_key is not null), '{}') as services
             from clinic_providers p
             left join clinic_provider_services s on s.provider_id = p.id
            where p.clinic_id = $1 and p.active
            group by p.id, p.display_name, p.calendar_id, p.created_at
            order by p.created_at, p.display_name`,
          [clinic.clinicId],
        )
      ).rows,
  );
}

let google: FakeGoogleCalendar;
type Account = { sub: string; email: string; hd?: string };
let WORKSPACE: Account;
let COLLEAGUE: Account;

describeDb("setup step 3 on the calendar functions", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    vi.stubGlobal("fetch", () => {
      throw new Error("live call attempted from the setup calendar tests");
    });
    for (const key of ENV) saved[key] = process.env[key];
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
  }, SLOW);

  beforeEach(() => {
    mocks.cookies.length = 0;
    mocks.steppedUp = false;
    mocks.session.userId = null;
    mocks.session.token = null;
    // Fresh accounts each time: one Google account is live on one location
    // across the whole database.
    const sub = () => `3${Date.now()}${Math.floor(Math.random() * 1e9)}`;
    WORKSPACE = { sub: sub(), email: "bookings@glow.test", hd: "glow.test" };
    COLLEAGUE = { sub: sub(), email: "desk@glow.test", hd: "glow.test" };
    google = fakeGoogleCalendar();
    google.addAccount(WORKSPACE);
    google.addAccount(COLLEAGUE);
    setGoogleFetch(google.fetch);
    resetGoogleTokenCache();
  });

  afterEach(() => {
    setGoogleFetch(undefined);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await closePools();
  });

  /** Sign in with Google from the step, through Google, and back: the callback's answer. */
  /**
   * Sign in with Google from the step, through Google, and back: the
   * callback's answer. The browser that comes back is the clinic's own
   * session; `steppedUp` stands in for a passkey step-up live on it, as the
   * calendar session's own tests do (tests/calendar-portal.test.ts).
   */
  async function connectThroughStep(
    clinic: Clinic,
    account: Account,
    { steppedUp = false }: { steppedUp?: boolean } = {},
  ) {
    signedInAs(clinic);
    const authUrl = await redirected(() => connectCalendar(connectForm(clinic.slug)));
    const cookie = mocks.cookies.at(-1)!;
    const answer = google.authorize(authUrl, { sub: account.sub }) as {
      code: string;
      state: string;
    };
    return completeGoogleSignIn(
      { ...answer, error: null, cookie: cookie.value },
      steppedUp
        ? {
            portalSession: async ({ userId }) => ({
              userId,
              label: "Front desk Mac",
              steppedUp: true,
            }),
          }
        : {},
    );
  }

  test(
    "the button is there only when connecting can work: Google set up, a token that can be sealed, and terms that let healdesk write",
    async () => {
      const clinic = await provisioned("wc-gate");
      const actor = actorOf(clinic);
      const step = await calendarStep({ id: clinic.clinicId, name: clinic.name }, { actor });
      expect(step).toMatchObject({
        kind: "google",
        account: "workspace_baa",
        connection: { status: "not_connected" },
      });
      const page = stepText(step);
      expect(page).toContain("Sign in with Google");
      expect(page).toContain('name="disclosure"');
      expect(page).not.toContain("Bookings arrive as requests your team confirms.");

      const refusedWith = async () => {
        const answer = await calendarStep({ id: clinic.clinicId, name: clinic.name }, { actor });
        const text = stepText(answer);
        expect(text).toContain("Bookings arrive as requests your team confirms.");
        expect(text).not.toContain("Sign in with Google");
        expect(text).not.toContain('name="disclosure"');
        return answer;
      };

      // healdesk's OAuth client is not set.
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      try {
        expect(await refusedWith()).toEqual({ kind: "requests_only", reason: "unavailable" });
      } finally {
        process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
      }

      // A deployment that cannot seal what Google would grant (KMS chosen, no key).
      process.env.HEALDESK_KMS_PROVIDER = "aws-kms";
      __setKeyWrapperForTests(undefined);
      try {
        expect(await refusedWith()).toEqual({ kind: "requests_only", reason: "unavailable" });
      } finally {
        process.env.HEALDESK_KMS_PROVIDER = "local";
        __setKeyWrapperForTests(undefined);
      }

      // Terms that still need an election (a signature before 1.3.0), and
      // terms under which the calendar is not used.
      for (const terms of [null, { bookingSystem: "mindbody" as const }]) {
        const other = await provisioned("wc-gate-terms", terms);
        expect(
          await calendarStep({ id: other.clinicId, name: other.name }, { actor: actorOf(other) }),
        ).toEqual({ kind: "requests_only", reason: "terms" });
      }
    },
    SLOW,
  );

  test(
    "Sign in with Google starts the portal's sign-in returning to /c/<slug>/setup, and Google's answer comes back there as ?calendar=connected",
    async () => {
      const clinic = await provisioned("wc-connect");
      signedInAs(clinic);
      const authUrl = await redirected(() => connectCalendar(connectForm(clinic.slug)));
      expect(new URL(authUrl).origin).toBe("https://accounts.google.com");
      // The browser binding, set by startGoogleConnect on the action's response.
      expect(mocks.cookies).toEqual([
        expect.objectContaining({
          name: "hd_gcal",
          options: expect.objectContaining({ httpOnly: true, path: "/api/calendar/google" }),
        }),
      ]);
      // Started from the portal, by this sign-in, to come back to the wizard,
      // under the notice the box was ticked on.
      expect(await oauthStates(clinic.clinicId)).toEqual([
        {
          initiated_via: "portal",
          user_id: clinic.userId,
          return_to: "wizard",
          disclosure_version: GOOGLE_CALENDAR_DISCLOSURE.version,
        },
      ]);

      const answer = google.authorize(authUrl, { sub: WORKSPACE.sub }) as {
        code: string;
        state: string;
      };
      const back = await completeGoogleSignIn({
        ...answer,
        error: null,
        cookie: mocks.cookies[0]!.value,
      });
      expect(back).toEqual({
        outcome: "connected",
        redirectPath: `/c/${clinic.slug}/setup?calendar=connected`,
      });

      // That address opens the calendar step and says so.
      const state = await loadSetupState({
        clinicId: clinic.clinicId,
        userId: clinic.userId,
        actor: SERVICE,
      });
      const notice = readCalendarNotice(
        new URL(back.redirectPath, "https://x").searchParams.get("calendar"),
      );
      expect(requestedScreen(state!.screens, undefined, notice)).toBe("calendar");
      const step = await calendarStep(
        { id: clinic.clinicId, name: clinic.name },
        { actor: actorOf(clinic) },
      );
      expect(step).toMatchObject({
        kind: "google",
        connection: { status: "active", account: { email: WORKSPACE.email, kind: "workspace" } },
      });
      const page = stepText(step, notice);
      expect(page).toContain("Your Google Calendar is connected.");
      expect(page).toContain(
        `Connected as <span class="text-ink font-semibold">${WORKSPACE.email}</span>`,
      );
      expect(page).toContain("Reconnect, or use another Google account");
      expect(page).toContain(">Disconnect</button>");

      // And the tracker counts it, without blocking on it.
      expect(
        buildTracker(state!, await getCalendarConnection(clinic.clinicId)).stages.find(
          (stage) => stage.id === "calendar",
        ),
      ).toEqual({
        id: "calendar",
        label: "Calendar connected",
        state: "done",
        detail: `Connected as ${WORKSPACE.email}.`,
        blocks: false,
      });
    },
    SLOW,
  );

  test(
    "an unticked notice, or a deployment that cannot reach Google, sends nobody there and says why on the step",
    async () => {
      const clinic = await provisioned("wc-refuse");
      signedInAs(clinic);
      expect(await redirected(() => connectCalendar(connectForm(clinic.slug, false)))).toBe(
        `/c/${clinic.slug}/setup?s=calendar&calendar=disclosure`,
      );
      delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      try {
        expect(await redirected(() => connectCalendar(connectForm(clinic.slug)))).toBe(
          `/c/${clinic.slug}/setup?s=calendar&calendar=unavailable`,
        );
      } finally {
        process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
      }
      expect(await oauthStates(clinic.clinicId)).toEqual([]);
      expect(mocks.cookies).toEqual([]);

      // Another clinic's slug is not this sign-in's: not found, before anything.
      const stranger = await provisioned("wc-refuse-other");
      await expect(connectCalendar(connectForm(stranger.slug))).rejects.toBeInstanceOf(
        mocks.NotFoundSignal,
      );
      expect(await oauthStates(stranger.clinicId)).toEqual([]);
    },
    SLOW,
  );

  test(
    "once connected: the same account reconnects with no step-up, another account only with one live when Google sends the browser back, and Disconnect waits for it, erases the token, revokes the grant and names the device",
    async () => {
      const clinic = await provisioned("wc-change");
      expect((await connectThroughStep(clinic, WORKSPACE)).outcome).toBe("connected");
      const stepUp = `/c/${clinic.slug}/step-up?next=${encodeURIComponent(`/c/${clinic.slug}/setup?s=calendar`)}`;

      // The same account again, as after a broken connection: straight to
      // Google and back, with no step-up anywhere.
      expect(await connectThroughStep(clinic, WORKSPACE)).toEqual({
        outcome: "connected",
        redirectPath: `/c/${clinic.slug}/setup?calendar=connected`,
      });

      // Another account, with no step-up live on the session that comes
      // back: the callback keeps the connected one, and the step says how to
      // move the bookings.
      expect(await connectThroughStep(clinic, COLLEAGUE)).toEqual({
        outcome: "different_account",
        redirectPath: `/c/${clinic.slug}/setup?calendar=different_account`,
      });
      expect(await getCalendarConnection(clinic.clinicId)).toMatchObject({
        status: "active",
        account: { email: WORKSPACE.email },
      });
      expect(calendarNoticeWords("different_account", "workspace_baa").text).toContain(
        "confirm it's you with Face ID or your screen lock first",
      );

      // With one live, another account of the same organisation takes over,
      // as the owner's change.
      expect(await connectThroughStep(clinic, COLLEAGUE, { steppedUp: true })).toEqual({
        outcome: "connected",
        redirectPath: `/c/${clinic.slug}/setup?calendar=connected`,
      });
      expect(await getCalendarConnection(clinic.clinicId)).toMatchObject({
        status: "active",
        account: { email: COLLEAGUE.email },
      });

      mocks.steppedUp = false;
      expect(await redirected(() => disconnectCalendar(slugForm(clinic.slug)))).toBe(stepUp);
      expect((await getCalendarConnection(clinic.clinicId)).status).toBe("active");

      mocks.steppedUp = true;
      const revokesBefore = google.revokeCalls;
      expect(await redirected(() => disconnectCalendar(slugForm(clinic.slug)))).toBe(
        `/c/${clinic.slug}/setup?s=calendar&calendar=disconnected`,
      );
      expect(await getCalendarConnection(clinic.clinicId)).toEqual({
        status: "not_connected",
        accessRemovedAt: null,
      });
      expect(google.revokeCalls).toBe(revokesBefore + 1);
      // The device whose passkey stepped up is who disconnected it.
      const events = await getMigratorPool().query<{ actor_label: string }>(
        `select actor_label from security_events
          where event = 'calendar_disconnected' and metadata->>'clinicId' = $1`,
        [clinic.clinicId],
      );
      expect(events.rows).toEqual([{ actor_label: "Front desk Mac" }]);

      // With nothing connected, connecting again is a first connection.
      mocks.steppedUp = false;
      expect(
        new URL(await redirected(() => connectCalendar(connectForm(clinic.slug)))).origin,
      ).toBe("https://accounts.google.com");
    },
    SLOW,
  );

  test(
    "named providers: offered only once the connected account's calendars are listed, saved through the calendar functions, with booking_detail following what was saved",
    async () => {
      const clinic = await provisioned("wc-providers");
      const ctx = contextOf(clinic);
      const actor = actorOf(clinic);
      expect(
        await saveSetupScreen(ctx, "services", {
          services: [
            { name: "Signature facial", priceKind: "exact", price: 199, durationMinutes: 60 },
            { name: "Chemical peel", priceKind: "from", price: 150, durationMinutes: 45 },
          ],
        }),
      ).toMatchObject({ ok: true });
      const services = ["Signature facial", "Chemical peel"];
      const inputs = { id: clinic.clinicId, name: clinic.name, services, siteProfile: null };

      // Nothing connected: the shared calendar only, and a named list is refused.
      expect(await providersStep(inputs, { actor })).toEqual({
        kind: "generic_only",
        reason: "no_calendar",
      });
      expect(
        await saveSetupScreen(ctx, "providers", {
          bookingDetail: "named_provider",
          providers: [{ displayName: "Dana Reyes", calendarId: "primary", services: [] }],
        }),
      ).toEqual({
        ok: false,
        field: "providers",
        message: "Connect your Google Calendar first, in the step before this one.",
      });
      expect(await bookingDetailOf(clinic)).toBe("generic");

      // Connected, with one calendar of its own besides the main one.
      const room = google.addCalendar(WORKSPACE.sub, { summary: "Treatment room" });
      await seedGoogleConnection(clinic.clinicId, {
        managed: true,
        refreshToken: google.grant({ sub: WORKSPACE.sub }).refreshToken,
      });
      expect(await providersStep(inputs, { actor })).toEqual({
        kind: "named",
        calendars: [
          { id: "primary", name: WORKSPACE.email, primary: true },
          { id: room, name: "Treatment room", primary: false },
        ],
        providers: [],
      });

      // One calendar given to two providers is refused, naming the second,
      // and nothing is saved.
      expect(
        await saveSetupScreen(ctx, "providers", {
          bookingDetail: "named_provider",
          providers: [
            { displayName: "Dana Reyes", calendarId: room, services: ["Signature facial"] },
            { displayName: "Dr Bo", calendarId: room, services: [] },
          ],
        }),
      ).toEqual({
        ok: false,
        field: "providers[1]",
        message:
          "Dr Bo's calendar is already another provider's. Each provider needs a calendar of their own.",
      });
      // A service the clinic does not offer is refused before anything is saved.
      expect(
        await saveSetupScreen(ctx, "providers", {
          bookingDetail: "named_provider",
          providers: [{ displayName: "Dana Reyes", calendarId: room, services: ["Laser"] }],
        }),
      ).toMatchObject({ ok: false, field: "providers[0].services" });
      expect(await providerRows(clinic)).toEqual([]);
      expect(await bookingDetailOf(clinic)).toBe("generic");

      expect(
        await saveSetupScreen(ctx, "providers", {
          bookingDetail: "named_provider",
          providers: [
            {
              displayName: "Dana Reyes",
              calendarId: room,
              services: ["Signature facial", "chemical PEEL"],
            },
            { displayName: "Dr Bo", calendarId: "primary", services: [] },
          ],
        }),
      ).toEqual({ ok: true, next: `/c/${clinic.slug}/setup?s=channels` });
      expect(await bookingDetailOf(clinic)).toBe("named_provider");
      expect(await providerRows(clinic)).toEqual([
        {
          display_name: "Dana Reyes",
          calendar_id: room,
          services: ["chemical peel", "signature facial"],
        },
        { display_name: "Dr Bo", calendar_id: "primary", services: [] },
      ]);
      const progress = await withTenant({ clinicId: clinic.clinicId, actor: SERVICE }, (tx) =>
        readProgress(tx.db, clinic.clinicId),
      );
      expect(progress.get("providers")?.outcome).toBe("done");

      // Read back for the form, services by the clinic's own names. Two
      // providers saved together share a creation time, so their order is
      // the calendar functions' to choose.
      const readBack = await providersStep(inputs, { actor });
      expect(readBack.kind).toBe("named");
      expect(
        readBack.kind === "named"
          ? [...readBack.providers].sort((a, b) => a.displayName.localeCompare(b.displayName))
          : null,
      ).toMatchObject([
        {
          displayName: "Dana Reyes",
          calendarId: room,
          services: ["Chemical peel", "Signature facial"],
        },
        { displayName: "Dr Bo", calendarId: "primary", services: [] },
      ]);

      // Google cannot list the calendars just now: nothing to choose from,
      // and the screen, which then asks nothing, keeps what is saved.
      google.failNext({ on: "calendarList", status: 503, reason: "backendError" });
      expect(await providersStep(inputs, { actor })).toEqual({
        kind: "generic_only",
        reason: "failed",
      });
      expect(await saveSetupScreen(ctx, "providers", {})).toMatchObject({ ok: true });
      expect(await bookingDetailOf(clinic)).toBe("named_provider");

      // Any available time: generic, and the providers are kept for later.
      expect(await saveSetupScreen(ctx, "providers", { bookingDetail: "generic" })).toMatchObject({
        ok: true,
      });
      expect(await bookingDetailOf(clinic)).toBe("generic");
      expect(await providerRows(clinic)).toHaveLength(2);
    },
    SLOW,
  );

  test(
    "before any provider is saved, the people the website named are offered as rows, each with a calendar still to choose",
    async () => {
      const clinic = await provisioned("wc-providers-read");
      await seedGoogleConnection(clinic.clinicId, {
        managed: true,
        refreshToken: google.grant({ sub: WORKSPACE.sub }).refreshToken,
      });
      const step = await providersStep(
        {
          id: clinic.clinicId,
          name: clinic.name,
          services: [],
          siteProfile: {
            providers: [{ name: "Dana Reyes", title: "Nurse injector" }],
          } as never,
        },
        { actor: actorOf(clinic) },
      );
      expect(step).toMatchObject({
        kind: "named",
        providers: [{ id: null, displayName: "Dana Reyes", calendarId: null, services: [] }],
      });
    },
    SLOW,
  );

  test(
    "Auto-confirm's Right now line is the location's booking mode as the page renders: not connected, connected, broken, switched off, and terms still to record",
    async () => {
      const clinic = await provisioned("wc-rightnow");
      const actor = actorOf(clinic);
      const line = async () => {
        const state = await loadSetupState({
          clinicId: clinic.clinicId,
          userId: clinic.userId,
          actor: SERVICE,
        });
        return autoConfirmFor(clinic.clinicId, state!.settings, { actor });
      };
      const requests = "Right now: your team confirms each booking AYA takes.";

      const before = await line();
      expect(before.on).toBe(true);
      expect(before.rightNow).toBe(`${requests} Your Google Calendar isn't connected.`);
      // The page shows it under the switch.
      const step = await calendarStep({ id: clinic.clinicId, name: clinic.name }, { actor });
      expect(stepText(step, null, before)).toContain(before.rightNow);

      // Connected: the calendar is no longer what stands in the way, and the
      // line names whatever is next, as effectiveBookingMode orders it.
      const { connectionId, credentialVersion } = await seedGoogleConnection(clinic.clinicId, {
        managed: true,
        refreshToken: google.grant({ sub: WORKSPACE.sub }).refreshToken,
      });
      const connected = await line();
      const mode = await effectiveBookingMode(clinic.clinicId, { actor });
      expect(mode.mode).toBe("requests");
      expect(mode.reasons.map((reason) => reason.code)).not.toContain("calendar_not_connected");
      expect(connected.rightNow).toBe(`${requests} ${mode.reason!.sentence}`);
      expect(connected.rightNow).not.toContain("Google Calendar");

      // Google refuses the calendar: the same read says so at once.
      await markCalendarBroken(clinic.clinicId, {
        code: "calendar_not_found",
        connectionId,
        credentialVersion,
      });
      expect((await line()).rightNow).toBe(
        `${requests} Your Google Calendar connection stopped working and needs reconnecting.`,
      );

      // The clinic's own switch, set through the calendar session's setAutoConfirm.
      await setAutoConfirm(clinic.clinicId, false, actor);
      expect((await line()).on).toBe(false);

      // Terms not recorded yet (a signature before 1.3.0): no button, and the line says why.
      const legacy = await provisioned("wc-rightnow-legacy", null);
      const legacyState = await loadSetupState({
        clinicId: legacy.clinicId,
        userId: legacy.userId,
        actor: SERVICE,
      });
      expect(
        (await autoConfirmFor(legacy.clinicId, legacyState!.settings, { actor: actorOf(legacy) }))
          .rightNow,
      ).toBe(`${requests} This location's calendar terms aren't in place yet.`);
    },
    SLOW,
  );
});

describe("step 3 in words", () => {
  const disclosure = renderGoogleCalendarDisclosure({ clinicName: "Glow" });
  const connectedView = (status: "active" | "error") => ({
    status,
    account: { email: "bookings@glow.test", kind: "workspace" as const, domain: "glow.test" },
    calendar: { id: "primary", primary: true },
    connectedAt: "2026-10-08T14:00:00.000Z",
    lastVerifiedAt: null,
    brokenAt: status === "error" ? new Date("2026-10-09T10:00:00.000Z") : null,
    lastError: status === "error" ? "calendar_not_found" : null,
    disclosureCurrent: true,
  });
  const notConnected = (
    account: "workspace_baa" | "personal" = "workspace_baa",
  ): Extract<CalendarStep, { kind: "google" }> => ({
    kind: "google",
    connection: { status: "not_connected", accessRemovedAt: null },
    account,
    disclosure,
  });

  test("every ?calendar= outcome is said in plain words on the step, and nothing else is", () => {
    const connected: CalendarStep = { ...notConnected(), connection: connectedView("active") };
    const requestsOnly: CalendarStep = { kind: "requests_only", reason: "unavailable" };
    for (const notice of CALENDAR_NOTICES) {
      expect(readCalendarNotice(notice)).toBe(notice);
      const words = calendarNoticeWords(notice, "workspace_baa");
      expect(words.text.length, notice).toBeGreaterThan(20);
      const step = notice === "connected" ? connected : notConnected();
      expect(stepText(step, notice), notice).toContain(words.text);
      // A refusal from before Google, on a step with no button, says it too.
      if (notice !== "connected") {
        expect(stepText(requestsOnly, notice), notice).toContain(
          calendarNoticeWords(notice, null).text,
        );
      }
    }
    for (const crafted of ["<b>hi</b>", "Connected", "", ["connected"], null]) {
      expect(readCalendarNotice(crafted)).toBeNull();
    }
    // A stale or crafted address says nothing the calendar contradicts.
    expect(stepText(notConnected(), "connected")).not.toContain(
      calendarNoticeWords("connected", null).text,
    );
    expect(stepText(connected, "disconnected")).not.toContain(
      calendarNoticeWords("disconnected", null).text,
    );
    expect(stepText(notConnected(), null)).not.toMatch(/<p role="status"/);
  });

  test("a mismatch says what Google reported about the account: a personal Gmail where the agreement names Workspace, or the other way round", () => {
    expect(calendarNoticeWords("mismatch", "workspace_baa").text).toContain(
      "You signed in with a personal Google account (@gmail.com)",
    );
    expect(calendarNoticeWords("mismatch", "workspace_no_baa").text).toContain(
      "personal Google account (@gmail.com)",
    );
    expect(calendarNoticeWords("mismatch", "personal").text).toContain(
      "You signed in with a Google Workspace account",
    );
    expect(calendarNoticeWords("connected", null).tone).toBe("done");
    expect(calendarNoticeWords("declined", null).tone).toBe("problem");
  });

  test("Google's return opens the calendar step; a screen named in the address wins", () => {
    const screens = ["basics", "hours", "calendar", "providers", "channels"] as const;
    expect(requestedScreen(screens, undefined, "connected")).toBe("calendar");
    expect(requestedScreen(screens, "hours", "connected")).toBe("hours");
    expect(requestedScreen(screens, "insurance", null)).toBeNull();
    expect(requestedScreen(screens, undefined, null)).toBeNull();
    expect(requestedScreen(["basics"], undefined, "connected")).toBeNull();
  });

  test("before the button: Google's warning and its two taps, the account check that blocks nothing, then the notice directly above its unticked box", () => {
    const page = stepText(notConnected());
    const picture = page.indexOf("Google hasn’t verified this app");
    const advanced = page.indexOf("Advanced");
    const unsafe = page.indexOf("Go to healdesk (unsafe)");
    expect(picture).toBeGreaterThan(0);
    expect(advanced).toBeGreaterThan(picture);
    expect(unsafe).toBeGreaterThan(advanced);
    expect(page).toContain(
      "Google Workspace, and our administrator has accepted Google's business associate agreement",
    );
    expect(page).toContain("ask them before you connect");
    expect(page).toContain("a personal account won't connect under your agreement");
    expect(page).toContain("Manage third-party app access");

    // The notice, then the box (unticked), then the button, nothing between.
    const heading = page.indexOf(disclosure.heading);
    const limitedUse = page.indexOf(disclosure.limitedUse.linkText);
    const tick = page.indexOf('name="disclosure"');
    const button = page.indexOf("Sign in with Google");
    expect(heading).toBeGreaterThan(unsafe);
    expect(limitedUse).toBeGreaterThan(heading);
    expect(tick).toBeGreaterThan(limitedUse);
    expect(button).toBeGreaterThan(tick);
    expect(page.slice(page.indexOf("</section>", limitedUse), tick)).not.toMatch(/<p|<div/);
    expect(page).not.toMatch(/name="disclosure"[^>]*checked/);
    expect(page.slice(tick, button)).toContain(disclosure.tickLabel);

    // A personal account's terms say so, without the Workspace lines.
    const personal = stepText(notConnected("personal"));
    expect(personal).toContain("A personal Google account (@gmail.com)");
    expect(personal).not.toContain("Manage third-party app access");
  });

  test("the reconnect needs nothing for the same account, and links the step-up before another account until one is live", () => {
    const connected: CalendarStep = { ...notConnected(), connection: connectedView("active") };
    const page = stepText(connected);
    expect(page).toContain("Sign in with the same Google account to reconnect it.");
    expect(page).toContain(
      `<a href="/c/glow/step-up?next=${encodeURIComponent("/c/glow/setup?s=calendar")}" class="font-semibold underline">confirm it’s you</a>`,
    );
    const live = stepText(connected, null, NOT_CONNECTED_LINE, true);
    expect(live).toContain(
      "You’ve confirmed it’s you, so you can also sign in with another account",
    );
    expect(live).not.toContain("/c/glow/step-up");
  });

  test("a broken connection opens the reconnect at once", () => {
    const broken: CalendarStep = { ...notConnected(), connection: connectedView("error") };
    const page = stepText(broken);
    expect(page).toContain("Your calendar connection stopped working");
    expect(page).toContain("on October 8, 2026");
    expect(page).not.toContain("Reconnect, or use another Google account");
    expect(page).toContain("Sign in with Google");
  });

  test("Auto-confirm shows the switch as saved and the mode's line, and says what saving another booking system does to it", () => {
    const page = stepText(notConnected());
    expect(page).toMatch(/Auto-confirm bookings<\/span><span[^>]*>On<\/span>/);
    expect(page).toContain(
      "Right now: your team confirms each booking AYA takes. Your Google Calendar isn't connected.",
    );
    // The picker holds the saved answer, so saving changes nothing.
    expect(page).not.toContain("turns Auto-confirm");
    expect(NOT_CONNECTED_LINE.onceSaved).toMatchObject({
      google_calendar: true,
      calendly: true,
      mindbody: false,
    });

    const off = stepText(notConnected(), null, { ...NOT_CONNECTED_LINE, on: false });
    expect(off).toMatch(/Auto-confirm bookings<\/span><span[^>]*>Off<\/span>/);
  });

  test("3.2 offers named providers only with calendars to give them", () => {
    // React writes an input's attributes in its own order, so each is looked for on its own.
    const DISABLED_NAMED = /<input(?=[^>]*disabled="")(?=[^>]*value="named_provider")[^>]*>/;
    const common = { slug: "glow", backHref: null, skipCost: "AYA books any available time." };
    const generic = decode(
      renderToStaticMarkup(
        createElement(ProvidersScreen, {
          ...common,
          bookingDetail: "generic",
          named: null,
          unavailable: "no_calendar",
          providersRead: 1,
          services: ["Signature facial"],
          maxProviders: MAX_PROVIDERS,
        }),
      ),
    );
    expect(generic).toContain(
      "Booking against each one’s own calendar comes after your calendar is connected.",
    );
    expect(generic).toMatch(DISABLED_NAMED);
    expect(generic).not.toContain("Their calendar");

    const named = decode(
      renderToStaticMarkup(
        createElement(ProvidersScreen, {
          ...common,
          bookingDetail: "named_provider",
          named: {
            calendars: [
              { id: "primary", name: "bookings@glow.test", primary: true },
              { id: "room@group.calendar.test", name: "Treatment room", primary: false },
            ],
            providers: [
              {
                id: "00000000-0000-4000-8000-000000000001",
                displayName: "Dana Reyes",
                calendarId: "room@group.calendar.test",
                services: ["Signature facial"],
              },
            ],
          },
          unavailable: null,
          providersRead: 0,
          services: ["Signature facial", "Chemical peel"],
          maxProviders: MAX_PROVIDERS,
        }),
      ),
    );
    expect(named).not.toMatch(DISABLED_NAMED);
    expect(named).toContain("Their calendar");
    expect(named).toContain("bookings@glow.test (main calendar)");
    expect(named).toMatch(
      /<option(?=[^>]*selected="")(?=[^>]*value="room@group\.calendar\.test")[^>]*>Treatment room/,
    );
    expect(named).toMatch(
      /<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>Signature facial/,
    );
    expect(named).toMatch(/<input(?![^>]*checked="")(?=[^>]*type="checkbox")[^>]*>Chemical peel/);

    // Saved providers while Google cannot list the calendars: kept, and said so.
    const keeping = decode(
      renderToStaticMarkup(
        createElement(ProvidersScreen, {
          ...common,
          bookingDetail: "named_provider",
          named: null,
          unavailable: "failed",
          providersRead: 0,
          services: [],
          maxProviders: MAX_PROVIDERS,
        }),
      ),
    );
    expect(keeping).toContain("Your named providers are saved.");
    expect(keeping).toMatch(
      /<input(?=[^>]*disabled="")(?=[^>]*checked="")(?=[^>]*value="named_provider")[^>]*>/,
    );
  });

  test("the page renders per request, under the nonce policy, and its form may hand the browser to Google", async () => {
    const page = await import("@/app/c/[slug]/setup/page");
    expect(page.dynamic).toBe("force-dynamic");
    const policy = contentSecurityPolicy("bm9uY2U=", true);
    expect(policy).toContain("form-action 'self' https://accounts.google.com");
    expect(policy).toContain("script-src 'self' 'nonce-bm9uY2U=' 'strict-dynamic'");
  });
});
