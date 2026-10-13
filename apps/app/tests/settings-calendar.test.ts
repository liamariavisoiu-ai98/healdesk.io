import { randomBytes } from "node:crypto";

import { GOOGLE_CALENDAR_DISCLOSURE } from "@healdesk/catalog";
import {
  FAKE_GOOGLE_CLIENT,
  fakeGoogleCalendar,
  resetGoogleTokenCache,
  setGoogleFetch,
  type FakeGoogleCalendar,
} from "@healdesk/connectors";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { effectiveBookingMode } from "@/lib/booking/mode";
import { getCalendarConnection, listProviderCalendars } from "@/lib/connections/google-calendar";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedGoogleConnection } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";
import { brokenLinks } from "./setup/portal-links";

/**
 * Settings → Calendar (plan Part F2), through the card's server actions and
 * the page as a browser receives it, against provisioned clinics and the
 * in-memory Google of @healdesk/connectors (never a live call): no Google
 * button while a sign-in cannot start, and why; Google's notice above an
 * unticked box before one can; a connected calendar with Change, Reconnect
 * and Disconnect, the changes behind a passkey step-up; Auto-confirm behind
 * one, with the mode it leaves; and the booking detail, with named providers
 * each on their own calendar. The sign-in is stood in, as in the other
 * Settings tests; everything behind it is real.
 */

const mocks = vi.hoisted(() => ({
  portal: { userId: "", clinicId: "", clinicSlug: "" },
  steppedUp: false,
  touched: 0,
  cookieJar: [] as { name: string; value: string }[],
}));

vi.mock("@/lib/portal/access", () => ({
  requirePortal: async () => mocks.portal,
  portalGrants: async () => [
    { clinicId: mocks.portal.clinicId, slug: mocks.portal.clinicSlug, name: "Calendar Med Spa" },
  ],
  currentSessionToken: async () => null,
  currentUserId: async () => mocks.portal.userId,
}));
vi.mock("@/lib/portal/actor", () => ({
  SIGN_IN_ACTOR_LABEL: "the clinic's sign-in",
  portalActor: async () =>
    mocks.steppedUp
      ? { label: "Front desk Mac", steppedUp: true }
      : { label: "the clinic's sign-in", steppedUp: false },
}));
vi.mock("@/lib/portal/step-up", () => ({
  sessionBinding: async () => ({
    userId: mocks.portal.userId,
    sessionTokenHash: randomBytes(32),
  }),
  stepUpPath: (slug: string, next: string) => `/c/${slug}/step-up?next=${encodeURIComponent(next)}`,
  touchStepUp: async () => {
    mocks.touched += 1;
    return null;
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string) => {
      mocks.cookieJar.push({ name, value });
    },
  }),
}));
vi.mock("@/app/c/[slug]/request-meta", () => ({ requestMeta: async () => ({}) }));

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "https://app.healdesk.test";
const ACTOR = { type: "service", serviceName: "settings-calendar-test" } as const;
const ENV = ["BETTER_AUTH_URL", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

let google: FakeGoogleCalendar;
/** Under terms that write to no calendar (a one-way booking system): a sign-in cannot start. */
let unelected: PortalClinic;
/** Under covered terms (Google Calendar, a Workspace account under a BAA). */
let covered: PortalClinic;

function use(clinic: PortalClinic) {
  Object.assign(mocks.portal, {
    userId: clinic.userId,
    clinicId: clinic.clinicId,
    clinicSlug: clinic.clinicSlug,
  });
}

async function actions() {
  return import("@/app/c/[slug]/settings/calendar-actions");
}

/** The Calendar card as the page renders it. */
async function card(search: Record<string, string> = {}): Promise<string> {
  const { default: SettingsPage } = await import("@/app/c/[slug]/settings/page");
  const html = renderToStaticMarkup(
    await SettingsPage({
      params: Promise.resolve({ slug: mocks.portal.clinicSlug }),
      searchParams: Promise.resolve(search),
    }),
  );
  expect(brokenLinks(html, mocks.portal.clinicSlug)).toEqual([]);
  const start = html.indexOf('id="calendar"');
  return html.slice(start, html.indexOf('id="payments"', start));
}

/** Text as React writes it into markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getMigratorPool().query<T>(text, values)).rows;
}

async function settingsRow(clinicId: string) {
  return (
    await inTenant(
      clinicId,
      async (c) =>
        (
          await c.query<{ auto_confirm_bookings: boolean; booking_detail: string }>(
            `select auto_confirm_bookings, booking_detail from clinic_settings where clinic_id = $1`,
            [clinicId],
          )
        ).rows,
    )
  )[0]!;
}

/** A Workspace account at the clinic's own domain, connected as the connect flow leaves one. */
async function connect(clinic: PortalClinic): Promise<{ sub: string }> {
  const sub = `2${randomBytes(8).readBigUInt64BE().toString().padStart(20, "0")}`;
  google.addAccount({ sub, email: "bookings@radiance.test", hd: "radiance.test" });
  const { refreshToken } = google.grant({ sub });
  await seedGoogleConnection(clinic.clinicId, { refreshToken, managed: true });
  return { sub };
}

describeDb("Settings → Calendar", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    vi.stubGlobal("fetch", () => {
      throw new Error("live call attempted from the Settings calendar tests");
    });
    for (const key of ENV) saved[key] = process.env[key];
    process.env.BETTER_AUTH_URL = ORIGIN;
    // Each signed BAA 1.3.0 with its calendar answers, and provisioning
    // recorded the location's first terms from them (plan C15).
    unelected = await provisionPortalClinic("calnone", {
      plan: "voice-webchat-1000-1000",
      bookingSystem: "mindbody",
      calendarAccount: "workspace_no_baa",
    });
    covered = await provisionPortalClinic("calcovered", {
      plan: "voice-webchat-1000-1000",
      bookingSystem: "google_calendar",
      calendarAccount: "workspace_baa",
    });
    // Warm the page and the actions once, outside any test's clock.
    await import("@/app/c/[slug]/settings/page");
    await actions();
  }, 300_000);

  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
    mocks.steppedUp = false;
    mocks.touched = 0;
    mocks.cookieJar.length = 0;
    google = fakeGoogleCalendar();
    setGoogleFetch(google.fetch);
    resetGoogleTokenCache();
    use(covered);
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

  test("while no sign-in can start, the card says why and offers no Google button; Auto-confirm still says what happens now", async () => {
    // Google isn't set up on this deployment.
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    let html = await card();
    expect(html).toContain("Connecting a calendar isn&#x27;t available yet.");
    expect(html).not.toContain("Sign in with Google");
    expect(html).not.toContain(GOOGLE_CALENDAR_DISCLOSURE.tickLabel.slice(0, 30));
    expect(html).toMatch(/role="switch"[^>]*>/);
    expect(html).toContain("Right now: bookings arrive as requests your team confirms.");
    const { connectCalendarAction } = await actions();
    expect(
      await connectCalendarAction(covered.clinicSlug, {
        disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
      }),
    ).toEqual({ ok: false, message: "Connecting a calendar isn't available yet." });

    // Google is set up, but the location has no calendar terms to write under.
    process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
    use(unelected);
    const mode = await effectiveBookingMode(unelected.clinicId, { actor: ACTOR });
    const blocker = mode.reasons.find((r) =>
      ["no_agreement", "needs_election", "manual_booking_system"].includes(r.code),
    );
    expect(blocker).toBeDefined();
    html = await card();
    expect(html).not.toContain("Sign in with Google");
    expect(html).toContain(escapeHtml(blocker!.sentence));
  });

  test("not connected: Google's notice sits above an unticked box; unticked is refused; ticked, Google's consent screen comes back to Settings", async () => {
    const html = await card();
    expect(html).toContain(GOOGLE_CALENDAR_DISCLOSURE.heading);
    // The notice names the practice, never the template's placeholder.
    expect(html).not.toContain("{");
    expect(html).not.toContain("clinicName");
    const [named] = await sql<{ name: string }>(`select name from clinics where id = $1`, [
      covered.clinicId,
    ]);
    expect(html).toContain(escapeHtml(named!.name));
    expect(html).toMatch(/<input[^>]*type="checkbox"(?![^>]*checked)[^>]*>/);
    expect(html).toContain("Sign in with Google");
    expect(html.indexOf(GOOGLE_CALENDAR_DISCLOSURE.heading)).toBeLessThan(
      html.indexOf("Sign in with Google"),
    );

    const { connectCalendarAction } = await actions();
    expect(await connectCalendarAction(covered.clinicSlug, { disclosureVersion: null })).toEqual({
      ok: false,
      message: "Please tick the box under the notice before signing in with Google.",
    });
    expect(mocks.cookieJar).toEqual([]);

    const started = await connectCalendarAction(covered.clinicSlug, {
      disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
    });
    expect(started).toMatchObject({ ok: true, href: expect.any(String) });
    const consent = new URL((started as { href: string }).href);
    expect(consent.origin).toBe("https://accounts.google.com");
    expect(consent.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/calendar/google/callback`);
    expect(mocks.cookieJar.map((c) => c.name)).toEqual(["hd_gcal"]);
    const states = await sql<{ initiated_via: string; return_to: string; user_id: string }>(
      `select initiated_via, return_to, user_id from google_oauth_states where target_clinic_id = $1`,
      [covered.clinicId],
    );
    expect(states).toEqual([
      { initiated_via: "portal", return_to: "portal", user_id: covered.userId },
    ]);
    // A first connect needs no step-up; changing the account does.
    expect(mocks.touched).toBe(0);
    expect(
      await connectCalendarAction(covered.clinicSlug, {
        disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
        change: true,
      }),
    ).toMatchObject({ ok: false, stepUpHref: expect.stringContaining("/step-up?next=") });
    expect(
      await sql(`select 1 from google_oauth_states where target_clinic_id = $1`, [
        covered.clinicId,
      ]),
    ).toHaveLength(1);
  });

  test("a sign-in's outcome is said on the card in the clinic's words, and anything else says nothing", async () => {
    expect(await card({ calendar: "declined" })).toContain(
      "You didn&#x27;t allow access in Google, so nothing was connected.",
    );
    expect(await card({ calendar: "<script>" })).not.toContain("script");
  });

  test("connected: the account and its calendar with Change, Reconnect and Disconnect; Disconnect needs a step-up, then requests are what is left", async () => {
    await connect(covered);
    const html = await card();
    expect(html).toContain(
      "a Google Workspace account (radiance.test), booking into its main calendar.",
    );
    for (const label of [">Change<", ">Reconnect<", ">Disconnect<"]) expect(html).toContain(label);
    expect(html).not.toContain("Sign in with Google<");

    const { disconnectCalendarAction } = await actions();
    expect(await disconnectCalendarAction(covered.clinicSlug)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^Disconnecting your calendar needs Face ID/),
      stepUpHref: expect.any(String),
    });
    expect(await getCalendarConnection(covered.clinicId)).toMatchObject({ status: "active" });

    mocks.steppedUp = true;
    expect(await disconnectCalendarAction(covered.clinicSlug)).toEqual({
      ok: true,
      toast:
        "Your Google Calendar is disconnected. Bookings arrive as requests your team confirms until you connect one again.",
    });
    expect(mocks.touched).toBe(1);
    expect(await getCalendarConnection(covered.clinicId)).toMatchObject({
      status: "not_connected",
    });
    const mode = await effectiveBookingMode(covered.clinicId, { actor: ACTOR });
    expect(mode.reasons.map((r) => r.code)).toContain("calendar_not_connected");
    expect(await card()).toContain("Sign in with Google");
  });

  test("Change: another calendar on the account, chosen behind a step-up", async () => {
    const { sub } = await connect(covered);
    const frontDesk = google.addCalendar(sub, { summary: "Front desk" });
    const { listCalendarsAction, chooseCalendarAction } = await actions();
    const listed = await listCalendarsAction(covered.clinicSlug);
    expect(listed).toEqual({
      ok: true,
      calendars: [
        { id: "primary", name: "bookings@radiance.test (main)", current: true },
        { id: frontDesk, name: "Front desk", current: false },
      ],
    });
    expect(await chooseCalendarAction(covered.clinicSlug, frontDesk)).toMatchObject({
      ok: false,
      stepUpHref: expect.any(String),
    });
    mocks.steppedUp = true;
    expect(await chooseCalendarAction(covered.clinicSlug, frontDesk)).toEqual({
      ok: true,
      toast: "Saved. AYA books into that calendar from now on.",
    });
    expect(await getCalendarConnection(covered.clinicId)).toMatchObject({
      calendar: { id: frontDesk, primary: false },
    });
    expect(await card()).toContain("booking into another calendar on this account.");
    await (await actions()).disconnectCalendarAction(covered.clinicSlug);
  });

  test("Auto-confirm needs a step-up; switched, it is stored and the mode it leaves is said", async () => {
    const { setAutoConfirmAction } = await actions();
    const before = await settingsRow(covered.clinicId);
    expect(
      await setAutoConfirmAction(covered.clinicSlug, !before.auto_confirm_bookings),
    ).toMatchObject({ ok: false, stepUpHref: expect.any(String) });
    expect(await settingsRow(covered.clinicId)).toEqual(before);

    mocks.steppedUp = true;
    const off = await setAutoConfirmAction(covered.clinicSlug, false);
    expect(off).toMatchObject({
      ok: true,
      toast: expect.stringMatching(/^Auto-confirm off: every booking AYA takes is a request/),
      rightNow: expect.stringMatching(/^Right now: /),
    });
    expect((await settingsRow(covered.clinicId)).auto_confirm_bookings).toBe(false);
    const codes = async () =>
      (await effectiveBookingMode(covered.clinicId, { actor: ACTOR })).reasons.map((r) => r.code);
    expect(await codes()).toContain("auto_confirm_off");
    expect(await card()).toMatch(/role="switch" aria-checked="false"/);

    expect(await setAutoConfirmAction(covered.clinicSlug, true)).toMatchObject({ ok: true });
    expect(await codes()).not.toContain("auto_confirm_off");
    expect(mocks.touched).toBe(2);
  });

  test("booking detail: named providers, each on their own calendar with what they offer; one shared calendar again keeps them", async () => {
    // Before a calendar is connected, named providers are not offered.
    expect(await card()).not.toContain("Set up named providers");

    await inTenant(covered.clinicId, async (c) => {
      await c.query(
        `update agent_configs set services = '[
           {"name":"Consultation","priceKind":"exact","priceFromUsd":150,"priceToUsd":150,"durationMinutes":30},
           {"name":"Peel","priceKind":"exact","priceFromUsd":120,"priceToUsd":120,"durationMinutes":45}
         ]'::jsonb where clinic_id = $1`,
        [covered.clinicId],
      );
    });
    const { sub } = await connect(covered);
    const second = google.addCalendar(sub, { summary: "Maria" });
    expect(await card()).toContain("Set up named providers");

    const { loadProvidersAction, saveProvidersAction, sharedCalendarAction } = await actions();
    expect(await loadProvidersAction(covered.clinicSlug)).toMatchObject({
      ok: true,
      providers: [],
      calendars: [{ id: "primary" }, { id: second, name: "Maria" }],
      services: ["Consultation", "Peel"],
    });

    expect(
      await saveProvidersAction(covered.clinicSlug, [
        { displayName: "Dr Chen", calendarId: "primary", services: [] },
        { displayName: "Maria", calendarId: "primary", services: [] },
      ]),
    ).toEqual({ ok: false, message: "Provider 2: each provider needs a calendar of their own." });

    expect(
      await saveProvidersAction(covered.clinicSlug, [
        { displayName: "Dr Chen", calendarId: "primary", services: ["Consultation"] },
        { displayName: "Maria", calendarId: second, services: ["Peel", "Consultation"] },
      ]),
    ).toMatchObject({ ok: true, toast: expect.stringMatching(/^2 named providers saved\./) });
    expect((await settingsRow(covered.clinicId)).booking_detail).toBe("named_provider");
    const providers = await listProviderCalendars(covered.clinicId);
    // Saved in one transaction, so they share a created_at: order by name.
    expect(
      providers.providers
        .map((p) => ({
          name: p.displayName,
          calendar: p.calendarId,
          services: p.services,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: "Dr Chen", calendar: "primary", services: ["consultation"] },
      { name: "Maria", calendar: second, services: ["consultation", "peel"] },
    ]);
    expect(await card()).toContain("Booking detail: named providers");

    expect(await sharedCalendarAction(covered.clinicSlug)).toMatchObject({ ok: true });
    expect((await settingsRow(covered.clinicId)).booking_detail).toBe("generic");
    expect((await listProviderCalendars(covered.clinicId)).providers).toHaveLength(2);
  });
});
