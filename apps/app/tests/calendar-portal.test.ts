import { createHash, randomBytes, randomUUID } from "node:crypto";

import { GOOGLE_CALENDAR_DISCLOSURE } from "@healdesk/catalog";
import {
  FAKE_GOOGLE_CLIENT,
  fakeGoogleCalendar,
  resetGoogleTokenCache,
  setGoogleFetch,
  type FakeGoogleCalendar,
} from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The portal's way into the Google Calendar connection and the calendar
 * terms (plan C18): the start route's portal form and the callback, each
 * through the clinic's own sign-in (requirePortal), and the elections and
 * account changes Settings → Calendar makes, which are the owner's.
 *
 * The session is Better Auth's, stood in for here as the Stripe Connect
 * tests stand in for it (tests/stripe-connect.test.ts); everything behind
 * it is real: app_user_clinic_grants, the step-up a device label comes
 * from, the election guard, and the in-memory Google of
 * @healdesk/connectors. Never a live call, and every email is captured.
 * Every clinic, account and person is synthetic.
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
    session: { userId: null as string | null, token: null as string | null },
    cookieJar: [] as { name: string; value: string }[],
    sent: [] as { to: string; kind: string; subject: string; text: string }[],
    calendarStates: [] as { clinicId: string; state: string }[],
    /**
     * The BAA's election form is released (calendar-election/1.0.0, plan C19);
     * this swaps it for an unreleased later version, as calendar-terms.test.ts
     * does, to show what a draft does. The database leaves that version off
     * its list of releases, as it would a real one.
     */
    draft: { election: false },
  };
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    set: (name: string, value: string) => {
      mocks.cookieJar.push({ name, value });
    },
  }),
}));
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
      getSession: async () =>
        mocks.session.userId
          ? { user: { id: mocks.session.userId }, session: { token: mocks.session.token } }
          : null,
    },
  },
}));
vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return {
    ...actual,
    sendEmail: async (email: { to: string; kind: string; subject: string; text: string }) => {
      mocks.sent.push(email);
      return { status: "sent", messageId: `m-${mocks.sent.length}` };
    },
  };
});
vi.mock("@/lib/notices/calendar-state", () => ({
  notifyCalendarState: async (_tx: unknown, clinicId: string, state: string) => {
    mocks.calendarStates.push({ clinicId, state });
  },
}));
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    // Only the BAA's form is ever made a draft here; the DPA's stays as the
    // catalogue has it, released with the DPA on 20 October 2026.
    calendarElectionFor: (version: string) => {
      const form = actual.calendarElectionFor(version);
      return mocks.draft.election && actual.agreementKindOfVersion(version) === "baa"
        ? { ...form, version: "calendar-election/1.1.0-draft", approvedByCounsel: false }
        : form;
    },
  };
});

import { GET as callbackRoute } from "@/app/api/calendar/google/callback/route";
import { POST as startRoute } from "@/app/api/calendar/google/start/route";
import {
  getCalendarTerms,
  previewCalendarElection,
  recordPortalElection,
  type PortalElectionActor,
} from "@/lib/booking/elections";
import { calendarLinkPage, issueCalendarLink } from "@/lib/connections/calendar-links";
import { withCredentials } from "@/lib/connections/store";
import { completeGoogleSignIn, startGoogleConnect } from "@/lib/connections/google-oauth";
import { hashSessionToken } from "@/lib/factors/step-ups";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  inTenant,
  seedCalendarTerms,
  seedClinic,
  seedLegacyDemoClinic,
  seedPortalUser,
  type SeededClinic,
} from "./setup/factories";

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "https://app.healdesk.test";
const DEVICE = "Front desk Mac";
const SIGN_IN = "the clinic's sign-in";
const SLOW = 90_000;

const ENV = ["BETTER_AUTH_URL", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

let google: FakeGoogleCalendar;

/** Fresh Google accounts for each test: one account is live on one location across the database. */
type Account = { sub: string; email: string; hd?: string };
let WORKSPACE: Account;
let COLLEAGUE: Account;
let ELSEWHERE: Account;
let PERSONAL: Account;
function freshAccounts(): void {
  const n = () => `2${randomBytes(8).readBigUInt64BE().toString().padStart(20, "0")}`;
  WORKSPACE = { sub: n(), email: "bookings@glow.test", hd: "glow.test" };
  COLLEAGUE = { sub: n(), email: "desk@glow.test", hd: "glow.test" };
  ELSEWHERE = { sub: n(), email: "bookings@glow-group.test", hd: "glow-group.test" };
  PERSONAL = { sub: n(), email: "glow.bookings@gmail.test" };
}

function accountRef(sub: string): string {
  return createHash("sha256").update(`google:${sub}`).digest("hex");
}

/**
 * Sign the browser in to the portal as `userId`; with `device`, a passkey
 * step-up is live on the session too, and its device's name is who the
 * audit names.
 */
async function signInAs(userId: string | null, device?: string): Promise<void> {
  mocks.session.userId = userId;
  mocks.session.token = userId ? randomBytes(24).toString("base64url") : null;
  if (!userId || !device) return;
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
     values ($1, 'passkey', $2, $3, '\\x01', 0, true) returning id`,
    [userId, device, randomBytes(16).toString("base64url")],
  );
  await getMigratorPool().query(
    `insert into step_ups (session_token_hash, user_id, factor_id, device_label, created_at, last_activity_at)
     values ($1, $2, $3, $4, now(), now())`,
    [hashSessionToken(mocks.session.token!), userId, rows[0]!.id, device],
  );
}

/**
 * The portal's form, posted to the start route with these request headers
 * (by default a page that sends its Origin); Next's redirect and 404 come
 * back as signals.
 */
async function postStart(
  fields: Record<string, string>,
  headers: Record<string, string> = { origin: ORIGIN },
) {
  try {
    return {
      response: await startRoute(
        new Request(`${ORIGIN}/api/calendar/google/start`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields).toString(),
        }),
      ),
    };
  } catch (error) {
    if (error instanceof mocks.NavigationSignal) {
      return { signal: { kind: error.kind, url: error.url } };
    }
    throw error;
  }
}

function portalForm(clinic: Pick<SeededClinic, "slug">, from = "settings") {
  return {
    clinic: clinic.slug,
    from,
    disclosure: "accepted",
    disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
  };
}

/** The browser-binding cookie's value, from the start route's Set-Cookie. */
function bindingOf(response: Response): string {
  const value = /^hd_gcal=([^;]*);/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  expect(value).toBeDefined();
  return value!;
}

/** Google's answer, sent back to the callback route by the browser holding `cookie`. */
function callback(answer: Record<string, string>, cookie: string) {
  return callbackRoute(
    new Request(`${ORIGIN}/api/calendar/google/callback?${new URLSearchParams(answer)}`, {
      headers: { cookie: `hd_gcal=${cookie}` },
    }),
  );
}

/**
 * A browser at the callback signed in to the portal as `userId`; with
 * `steppedUp`, a passkey step-up is live on its session and the device's
 * name labels the user.
 */
function signedInAs(userId: string, steppedUp = false) {
  return {
    portalSession: async () => ({ userId, label: steppedUp ? DEVICE : SIGN_IN, steppedUp }),
  };
}

/** The whole portal round trip, as the funnel's server action starts it, completed in `userId`'s session. */
async function portalConnect(
  clinic: Pick<SeededClinic, "clinicId" | "slug">,
  userId: string,
  sub: string,
  { steppedUp = false }: { steppedUp?: boolean } = {},
) {
  mocks.cookieJar.length = 0;
  const { authUrl } = await startGoogleConnect({
    clinicId: clinic.clinicId,
    returnTo: `/c/${clinic.slug}/settings`,
    disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
    userId,
  });
  const answer = google.authorize(authUrl, { sub }) as { code: string; state: string };
  return completeGoogleSignIn(
    { ...answer, error: null, cookie: mocks.cookieJar[0]!.value },
    signedInAs(userId, steppedUp),
  );
}

/**
 * Settings → Calendar's acceptance, as the card makes it: the preview for
 * these answers first, whose fingerprint the acceptance carries back (none
 * when the preview had no document to show).
 */
async function elect(
  clinicId: string,
  submission: Record<string, unknown> & { bookingSystem: unknown; calendarAccount: unknown },
  actor: PortalElectionActor,
) {
  const preview = await previewCalendarElection(clinicId, submission);
  return recordPortalElection(
    clinicId,
    {
      accepted: false,
      ...submission,
      ...(preview.status === "ready"
        ? { documentVersion: preview.documentVersion, documentHash: preview.documentHash }
        : { documentVersion: undefined, documentHash: undefined }),
    } as Parameters<typeof recordPortalElection>[1],
    { actor },
  );
}

function owner(clinic: Pick<SeededClinic, "staffUserId">, label = DEVICE): PortalElectionActor {
  return { type: "user", userId: clinic.staffUserId, label };
}

async function states(clinicId: string) {
  return (
    await getMigratorPool().query<{ initiated_via: string; user_id: string; return_to: string }>(
      `select initiated_via, user_id, return_to from google_oauth_states
        where target_clinic_id = $1 order by created_at`,
      [clinicId],
    )
  ).rows;
}

async function connectionRow(clinicId: string) {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      status: string;
      account_ref: string | null;
      metadata: Record<string, unknown> | null;
      last_error: string | null;
    }>(
      `select id, status, account_ref, metadata, last_error from provider_connections
        where clinic_id = $1 and provider = 'google_calendar'`,
      [clinicId],
    );
    return rows[0] ?? null;
  });
}

async function refreshTokenOf(clinicId: string): Promise<string> {
  const row = (await connectionRow(clinicId))!;
  return withTenant({ clinicId, actor: { type: "service", serviceName: "test" } }, (tx) =>
    withCredentials(tx.db, { clinicId, connectionId: row.id }, async (bag) => bag.refresh_token!),
  );
}

async function auditRows(clinicId: string, resourceType: string) {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{
      actor_type: string;
      actor_user_id: string | null;
      actor_label: string;
      metadata: Record<string, unknown> | null;
    }>(
      `select actor_type, actor_user_id, actor_label, metadata from audit_log
        where clinic_id = $1 and resource_type = $2 order by occurred_at, id`,
      [clinicId, resourceType],
    );
    return rows;
  });
}

async function elections(clinicId: string) {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{
      source: string;
      terms_kind: string;
      calendar_account: string;
      booking_system: string;
      owner_confirmed: boolean;
      elected_by_user_id: string | null;
      elected_by_label: string;
      link_id: string | null;
      rendered_text: string | null;
    }>(
      `select source, terms_kind, calendar_account, booking_system, owner_confirmed,
              elected_by_user_id, elected_by_label, link_id, rendered_text
         from calendar_elections where clinic_id = $1 order by sequence`,
      [clinicId],
    );
    return rows;
  });
}

function tokenRequests(): number {
  return google.requests.filter((r) => r.endpoint === "token").length;
}

function revokedTokens(): string[] {
  return google.requests
    .filter((r) => r.endpoint === "revoke")
    .map((r) => r.form?.get("token") ?? "");
}

/** A bound agreement of `version`, as the migrator, standing in for provisioning's definer. */
async function bindAgreement(organizationId: string, version: string): Promise<void> {
  await getMigratorPool().query(
    `insert into baa_acceptances
       (id, organization_id, document_version, document_hash, rendered_text, variables,
        assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
     values ($1, $2, $3, $4, 'AGREEMENT (synthetic test)', $5::jsonb,
             'I agree', 'Alex Chen', 'alex@glow.test', now(), now())`,
    [
      randomUUID(),
      organizationId,
      version,
      randomBytes(32).toString("hex"),
      JSON.stringify({ clinicLegalName: "Glow Synthetic LLC", appliedClauses: ["term"] }),
    ],
  );
}

describeDb("the portal's way into the calendar", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    vi.stubGlobal("fetch", () => {
      throw new Error("live call attempted from the portal calendar tests");
    });
    for (const key of ENV) saved[key] = process.env[key];
    process.env.BETTER_AUTH_URL = ORIGIN;
    process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
  }, 60_000);

  beforeEach(async () => {
    mocks.sent.length = 0;
    mocks.calendarStates.length = 0;
    mocks.cookieJar.length = 0;
    mocks.draft.election = false;
    await signInAs(null);
    freshAccounts();
    google = fakeGoogleCalendar();
    for (const account of [WORKSPACE, COLLEAGUE, ELSEWHERE, PERSONAL]) google.addAccount(account);
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

  test(
    "the start route's portal form: the clinic's own sign-in only, signing in first without one, and the state names who started it",
    async () => {
      const clinic = await seedClinic("cp-start");
      const stranger = await seedClinic("cp-start-other");
      await seedCalendarTerms(clinic);

      // From another origin, or a form that is neither door's: refused before anything.
      // A null Origin (what a no-referrer page's form sends) passes only on
      // the browser's own Sec-Fetch-Site: same-origin.
      for (const headers of [
        { origin: "https://evil.example" },
        { origin: "null", "sec-fetch-site": "cross-site" },
        { origin: "null", "sec-fetch-site": "same-site" },
        { origin: "null" },
        { "sec-fetch-site": "none" },
        {},
      ] as Record<string, string>[]) {
        expect((await postStart(portalForm(clinic), headers)).response?.status).toBe(403);
      }
      for (const fields of [
        { ...portalForm(clinic), from: "billing" },
        { ...portalForm(clinic), clinic: "Not/A/Slug" },
        { ...portalForm(clinic), token: "A".repeat(43) },
      ]) {
        expect((await postStart(fields)).response?.status).toBe(404);
      }

      // No session: off to sign in with a 303, the same for any slug, and
      // back to the page the button was on.
      for (const slug of [clinic.slug, "no-such-clinic"]) {
        const signedOut = (await postStart({ ...portalForm(clinic), clinic: slug })).response!;
        expect(signedOut.status).toBe(303);
        expect(signedOut.headers.get("location")).toBe(
          `${ORIGIN}/sign-in?next=${encodeURIComponent(`/c/${slug}/settings`)}`,
        );
      }

      // Another clinic's sign-in: requirePortal's 404, as for a clinic that does not exist.
      await signInAs(stranger.staffUserId);
      expect(await postStart(portalForm(clinic))).toEqual({ signal: { kind: "notFound" } });
      expect(await states(clinic.clinicId)).toEqual([]);

      // The clinic's own sign-in, with a passkey live on this device: off to
      // Google, the browser bound by the cookie, the state naming the user.
      await signInAs(clinic.staffUserId, DEVICE);
      const started = (await postStart(portalForm(clinic))).response!;
      expect(started.status).toBe(303);
      expect(new URL(started.headers.get("location")!).origin).toBe("https://accounts.google.com");
      expect(started.headers.get("set-cookie")).toMatch(
        /^hd_gcal=[A-Za-z0-9_-]{43}\.; Path=\/api\/calendar\/google; Max-Age=900; HttpOnly; SameSite=Lax/,
      );
      expect((await postStart(portalForm(clinic, "setup"))).response!.status).toBe(303);
      // As Chrome and Firefox post it from the portal's no-referrer pages.
      const nullOrigin = (
        await postStart(portalForm(clinic), { origin: "null", "sec-fetch-site": "same-origin" })
      ).response!;
      expect(nullOrigin.status).toBe(303);
      expect(new URL(nullOrigin.headers.get("location")!).origin).toBe(
        "https://accounts.google.com",
      );
      expect(await states(clinic.clinicId)).toEqual([
        { initiated_via: "portal", user_id: clinic.staffUserId, return_to: "portal" },
        { initiated_via: "portal", user_id: clinic.staffUserId, return_to: "wizard" },
        { initiated_via: "portal", user_id: clinic.staffUserId, return_to: "portal" },
      ]);
      const accepted = await auditRows(clinic.clinicId, "calendar_disclosure_acceptance");
      expect(accepted).toHaveLength(3);
      for (const row of accepted) {
        expect(row).toMatchObject({
          actor_type: "user",
          actor_user_id: clinic.staffUserId,
          actor_label: DEVICE,
          metadata: { event: "calendar_disclosure_accepted", via: "portal" },
        });
      }
    },
    SLOW,
  );

  test(
    "the start route sends the portal back to its page with the reason when nobody may be sent to Google",
    async () => {
      const clinic = await seedClinic("cp-refusals");
      await seedCalendarTerms(clinic);
      const manual = await seedClinic("cp-refusals-manual");
      await seedCalendarTerms(manual, { bookingSystem: "mindbody" });
      const demo = await seedLegacyDemoClinic("cp-refusals-elect");
      const back = (c: Pick<SeededClinic, "slug">, outcome: string) =>
        `${ORIGIN}/c/${c.slug}/settings?calendar=${outcome}`;
      // Each refusal is a 303 back to the page, binding no browser.
      const location = async (c: Pick<SeededClinic, "slug">, fields = {}) => {
        const response = (await postStart({ ...portalForm(c), ...fields })).response!;
        expect(response.status).toBe(303);
        expect(response.headers.get("set-cookie")).toBeNull();
        return response.headers.get("location");
      };

      await signInAs(clinic.staffUserId);
      // The notice unticked, or ticked on another version.
      expect(await location(clinic, { disclosure: "" })).toBe(back(clinic, "disclosure"));
      expect(await location(clinic, { disclosureVersion: "google-calendar-disclosure/0" })).toBe(
        back(clinic, "disclosure"),
      );
      // healdesk's client is not configured: nobody is sent anywhere.
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      try {
        expect(await location(clinic)).toBe(back(clinic, "unavailable"));
      } finally {
        process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
      }
      // Manual booking: the terms let healdesk use no calendar.
      await signInAs(manual.staffUserId);
      expect(await location(manual)).toBe(back(manual, "terms"));
      // Terms not recorded yet: the owner elects first.
      await signInAs(demo.staffUserId);
      expect(await location(demo)).toBe(back(demo, "election_needed"));

      for (const c of [clinic, manual, demo]) expect(await states(c.clinicId)).toEqual([]);
    },
    SLOW,
  );

  test(
    "the callback goes on only in the session of the portal user who started it: any other, or none, spends the state, asks Google nothing and is recorded",
    async () => {
      const clinic = await seedClinic("cp-callback");
      const stranger = await seedClinic("cp-callback-other");
      const manager = await seedPortalUser(clinic.clinicId, "admin");
      await seedCalendarTerms(clinic);
      const start = async (sub = WORKSPACE.sub) => {
        await signInAs(clinic.staffUserId, DEVICE);
        const started = (await postStart(portalForm(clinic))).response!;
        const answer = google.authorize(started.headers.get("location")!, { sub }) as {
          code: string;
          state: string;
        };
        return { answer, cookie: bindingOf(started) };
      };
      const refusedTo = `${ORIGIN}/c/${clinic.slug}/settings?calendar=failed`;

      // Another member of the same clinic in the same browser, another
      // clinic's sign-in, then nobody's: each refused, back to the page, whose
      // own requirePortal decides what that browser may see.
      const first = await start();
      await signInAs(manager.userId);
      const colleague = await callback(first.answer, first.cookie);
      expect(colleague.status).toBe(303);
      expect(colleague.headers.get("location")).toBe(refusedTo);
      expect(colleague.headers.get("set-cookie")).toMatch(
        /^hd_gcal=; Path=\/api\/calendar\/google; Max-Age=0/,
      );
      const second = await start();
      await signInAs(stranger.staffUserId);
      expect((await callback(second.answer, second.cookie)).headers.get("location")).toBe(
        refusedTo,
      );
      const third = await start();
      await signInAs(null);
      expect((await callback(third.answer, third.cookie)).headers.get("location")).toBe(refusedTo);
      expect(tokenRequests()).toBe(0);
      expect(await connectionRow(clinic.clinicId)).toBeNull();

      // Recorded as the callback's own service, never as the session's user,
      // with a security event naming the user the state was minted for.
      const refusals = (await auditRows(clinic.clinicId, "google_oauth_state")).filter(
        (row) => row.metadata?.event === "calendar_connect_refused",
      );
      expect(refusals).toHaveLength(3);
      for (const row of refusals) {
        expect(row).toMatchObject({
          actor_type: "service",
          actor_user_id: null,
          metadata: { outcome: "failed", via: "portal", reason: "not_its_session" },
        });
      }
      const unbound = await getMigratorPool().query<{ user_id: string }>(
        `select user_id from security_events
          where event = 'calendar_connect_refused' and metadata ->> 'clinicId' = $1`,
        [clinic.clinicId],
      );
      expect(unbound.rows).toEqual(Array(3).fill({ user_id: clinic.staffUserId }));

      // Each state is spent: the right session cannot take it up afterwards.
      await signInAs(clinic.staffUserId, DEVICE);
      expect((await callback(first.answer, first.cookie)).headers.get("location")).toBe(
        `${ORIGIN}/calendar/done?outcome=expired`,
      );
      expect(tokenRequests()).toBe(0);

      // In the user's own session: connected, back on the page it started from.
      const own = await start();
      const connected = await callback(own.answer, own.cookie);
      expect(connected.headers.get("location")).toBe(
        `${ORIGIN}/c/${clinic.slug}/settings?calendar=connected`,
      );
      expect(await connectionRow(clinic.clinicId)).toMatchObject({
        status: "active",
        account_ref: accountRef(WORKSPACE.sub),
        metadata: expect.objectContaining({ connectedVia: "portal" }),
      });

      // The audit and the security event name the user, by the device that stepped up.
      const connectedRows = (await auditRows(clinic.clinicId, "provider_connection")).filter(
        (row) => row.metadata?.event === "calendar_connected",
      );
      expect(connectedRows).toEqual([
        expect.objectContaining({
          actor_type: "user",
          actor_user_id: clinic.staffUserId,
          actor_label: DEVICE,
        }),
      ]);
      const event = await getMigratorPool().query<{ actor_label: string; user_id: string }>(
        `select actor_label, user_id from security_events
          where event = 'calendar_connected' and metadata ->> 'clinicId' = $1`,
        [clinic.clinicId],
      );
      expect(event.rows).toEqual([{ actor_label: DEVICE, user_id: clinic.staffUserId }]);
      // A connect from Settings while nothing was connected tells nobody.
      expect(mocks.calendarStates).toEqual([]);

      // Another account replaces it only with a passkey step-up live on the
      // session that comes back: the owner's own sign-in without one changes
      // nothing, the same sign-in stepped up does.
      const unstepped = await start(COLLEAGUE.sub);
      await signInAs(clinic.staffUserId);
      expect((await callback(unstepped.answer, unstepped.cookie)).headers.get("location")).toBe(
        `${ORIGIN}/c/${clinic.slug}/settings?calendar=different_account`,
      );
      expect((await connectionRow(clinic.clinicId))!.account_ref).toBe(accountRef(WORKSPACE.sub));
      const stepped = await start(COLLEAGUE.sub);
      expect((await callback(stepped.answer, stepped.cookie)).headers.get("location")).toBe(
        `${ORIGIN}/c/${clinic.slug}/settings?calendar=connected`,
      );
      expect((await connectionRow(clinic.clinicId))!.account_ref).toBe(accountRef(COLLEAGUE.sub));
    },
    SLOW,
  );

  test(
    "a portal user whose membership ends while Google is asked completes nothing, and the unused grant is revoked",
    async () => {
      const clinic = await seedClinic("cp-left");
      await seedCalendarTerms(clinic);
      mocks.cookieJar.length = 0;
      const { authUrl } = await startGoogleConnect({
        clinicId: clinic.clinicId,
        returnTo: `/c/${clinic.slug}/settings`,
        disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
        userId: clinic.staffUserId,
      });
      const answer = google.authorize(authUrl, { sub: WORKSPACE.sub }) as {
        code: string;
        state: string;
      };
      // The session checks out at the callback, and the membership is
      // revoked a moment later, before anything is kept.
      const result = await completeGoogleSignIn(
        { ...answer, error: null, cookie: mocks.cookieJar[0]!.value },
        {
          portalSession: async ({ userId }) => {
            await inTenant(clinic.clinicId, (client) =>
              client.query(
                `update clinic_memberships set revoked_at = now() where clinic_id = $1 and user_id = $2`,
                [clinic.clinicId, userId],
              ),
            );
            return { userId, label: DEVICE, steppedUp: true };
          },
        },
      );
      expect(result).toEqual({
        outcome: "failed",
        redirectPath: `/c/${clinic.slug}/settings?calendar=failed`,
      });
      expect(await connectionRow(clinic.clinicId)).toBeNull();
      expect(revokedTokens()).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a change of Google account in the portal is the owner's, stepped up: another member's account, or the owner's without a step-up, changes nothing; the owner's replaces it and the old grant is revoked",
    async () => {
      const clinic = await seedClinic("cp-change");
      await seedCalendarTerms(clinic);
      const manager = await seedPortalUser(clinic.clinicId, "admin");
      expect((await portalConnect(clinic, clinic.staffUserId, WORKSPACE.sub)).outcome).toBe(
        "connected",
      );
      const oldToken = await refreshTokenOf(clinic.clinicId);

      // A member who is not the owner may reconnect, but not change the
      // account, stepped up or not; nor may the owner without a step-up
      // ("step-up to change", portal plan F2).
      for (const [userId, steppedUp] of [
        [manager.userId, true],
        [clinic.staffUserId, false],
      ] as const) {
        expect(await portalConnect(clinic, userId, COLLEAGUE.sub, { steppedUp })).toEqual({
          outcome: "different_account",
          redirectPath: `/c/${clinic.slug}/settings?calendar=different_account`,
        });
      }
      expect((await connectionRow(clinic.clinicId))!.account_ref).toBe(accountRef(WORKSPACE.sub));
      expect(revokedTokens()).toHaveLength(2);
      expect(google.grantOf(oldToken)?.revoked).toBe(false);

      // The owner, stepped up, in the same Workspace domain: a plain change.
      expect(
        (await portalConnect(clinic, clinic.staffUserId, COLLEAGUE.sub, { steppedUp: true }))
          .outcome,
      ).toBe("connected");
      expect((await connectionRow(clinic.clinicId))!.account_ref).toBe(accountRef(COLLEAGUE.sub));
      expect(google.grantOf(oldToken)?.revoked).toBe(true);
    },
    SLOW,
  );

  test(
    "an account of another kind needs the owner's election first; recorded in the portal, it takes the old connection away and the new account connects",
    async () => {
      // A demo clinic: the only kind that may record an election before the
      // election document is released (plan A10).
      const demo = await seedLegacyDemoClinic("cp-kind");
      expect(await getCalendarTerms(demo.clinicId)).toEqual({
        terms: { kind: "needs_election", reason: "legacy_agreement" },
        election: { status: "ready" },
      });

      // The owner's first election widens (from none to covered); their own
      // acceptance is the owner's confirmation.
      const covered = await elect(
        demo.clinicId,
        {
          bookingSystem: "google_calendar",
          calendarAccount: "workspace_baa",
          name: "Alex Chen",
          title: "Owner",
          accepted: true,
        },
        owner(demo),
      );
      expect(covered).toMatchObject({
        status: "recorded",
        kind: "covered",
        widened: true,
        disconnected: false,
      });
      expect(await getCalendarTerms(demo.clinicId)).toMatchObject({
        terms: {
          kind: "covered",
          bookingSystem: "google_calendar",
          calendarAccount: "workspace_baa",
          source: "portal",
        },
        election: { status: "ready" },
      });
      expect((await portalConnect(demo, demo.staffUserId, WORKSPACE.sub)).outcome).toBe(
        "connected",
      );
      const workspaceToken = await refreshTokenOf(demo.clinicId);

      // A personal account, by the owner stepped up: refused until the owner elects for it.
      expect(
        await portalConnect(demo, demo.staffUserId, PERSONAL.sub, { steppedUp: true }),
      ).toEqual({
        outcome: "election_needed",
        redirectPath: `/c/${demo.slug}/settings?calendar=election_needed`,
      });
      expect((await connectionRow(demo.clinicId))!.account_ref).toBe(accountRef(WORKSPACE.sub));
      expect(revokedTokens()).toHaveLength(1);

      // What the card shows before the owner accepts: nothing recorded.
      const personal = { bookingSystem: "google_calendar", calendarAccount: "personal" } as const;
      const preview = await previewCalendarElection(demo.clinicId, personal);
      expect(preview).toMatchObject({
        status: "ready",
        kind: "uncovered",
        previousKind: "covered",
        widens: true,
        disconnects: true,
        documentVersion: "calendar-election/1.0.0",
      });
      const text = preview.status === "ready" ? preview.text : "";
      expect(text).toContain("to the healdesk Business Associate Agreement");
      expect(text).toContain("The practice owner, on confirming");
      expect(await elections(demo.clinicId)).toHaveLength(1);

      // Only the document the card showed is signed: none, another choice's,
      // or one the location's name has changed under since, records nothing.
      mocks.sent.length = 0;
      const acceptance = { ...personal, name: "Alex Chen", title: "Owner", accepted: true };
      const fingerprint = (shown: Awaited<ReturnType<typeof previewCalendarElection>>) =>
        shown.status === "ready"
          ? { documentVersion: shown.documentVersion, documentHash: shown.documentHash }
          : { documentVersion: undefined, documentHash: undefined };
      const otherChoice = await previewCalendarElection(demo.clinicId, {
        bookingSystem: "google_calendar",
        calendarAccount: "workspace_no_baa",
      });
      expect(otherChoice.status).toBe("ready");
      for (const shown of [
        fingerprint({ status: "invalid", field: "", message: "" }),
        fingerprint(otherChoice),
      ]) {
        expect(
          await recordPortalElection(
            demo.clinicId,
            { ...acceptance, ...shown },
            { actor: owner(demo) },
          ),
        ).toEqual({ status: "changed" });
      }
      await getMigratorPool().query(`update clinics set name = $1 where id = $2`, [
        "Glow Synthetic Downtown",
        demo.clinicId,
      ]);
      expect(
        await recordPortalElection(
          demo.clinicId,
          { ...acceptance, ...fingerprint(preview) },
          { actor: owner(demo) },
        ),
      ).toEqual({ status: "changed" });
      expect(await elections(demo.clinicId)).toHaveLength(1);
      expect(mocks.sent).toEqual([]);

      // Previewed again, as the card does on `changed`, and accepted.
      const changed = await elect(demo.clinicId, acceptance, owner(demo));
      expect(changed).toMatchObject({
        status: "recorded",
        kind: "uncovered",
        widened: true,
        disconnected: true,
      });
      // The Workspace connection is not the new terms': erased, and its grant revoked.
      expect(await connectionRow(demo.clinicId)).toMatchObject({
        status: "revoked",
        last_error: "election_changed",
      });
      expect(google.grantOf(workspaceToken)?.revoked).toBe(true);

      const rows = await elections(demo.clinicId);
      expect(rows.map(({ rendered_text: _, ...row }) => row)).toEqual(
        ["workspace_baa", "personal"].map((account, i) => ({
          source: "portal",
          terms_kind: i === 0 ? "covered" : "uncovered",
          calendar_account: account,
          booking_system: "google_calendar",
          owner_confirmed: true,
          elected_by_user_id: demo.staffUserId,
          elected_by_label: "Alex Chen, Owner",
          link_id: null,
        })),
      );
      expect(rows[1]!.rendered_text).toMatch(/ACCEPTED FOR PRACTICE BY\n\s*Alex Chen, Owner\n/);
      const recorded = await auditRows(demo.clinicId, "calendar_election");
      expect(recorded.at(-1)).toMatchObject({
        actor_type: "user",
        actor_user_id: demo.staffUserId,
        actor_label: DEVICE,
        metadata: expect.objectContaining({ source: "portal", ownerConfirmed: true }),
      });
      // The practice's copy, to its one address.
      expect(mocks.sent.map((email) => [email.kind, email.to])).toEqual([
        ["calendar_election_recorded", demo.staffEmail.toLowerCase()],
      ]);

      // And the personal account now connects.
      expect((await portalConnect(demo, demo.staffUserId, PERSONAL.sub)).outcome).toBe("connected");
      expect(await connectionRow(demo.clinicId)).toMatchObject({
        status: "active",
        account_ref: accountRef(PERSONAL.sub),
        metadata: expect.objectContaining({ managed: false }),
      });
    },
    SLOW,
  );

  test(
    "an account in another Workspace domain needs the owner's election too; the same terms again keep the connection until the new account replaces it",
    async () => {
      const demo = await seedLegacyDemoClinic("cp-domain");
      const covered = {
        bookingSystem: "google_calendar",
        calendarAccount: "workspace_baa",
        name: "Alex Chen",
        title: "Owner",
        accepted: true,
      };
      expect(await elect(demo.clinicId, covered, owner(demo))).toMatchObject({
        status: "recorded",
        kind: "covered",
      });
      expect((await portalConnect(demo, demo.staffUserId, WORKSPACE.sub)).outcome).toBe(
        "connected",
      );
      const oldToken = await refreshTokenOf(demo.clinicId);

      expect(
        (await portalConnect(demo, demo.staffUserId, ELSEWHERE.sub, { steppedUp: true })).outcome,
      ).toBe("election_needed");

      // The same kind of account again: it neither widens nor disconnects.
      expect(
        await previewCalendarElection(demo.clinicId, {
          bookingSystem: "google_calendar",
          calendarAccount: "workspace_baa",
        }),
      ).toMatchObject({ status: "ready", kind: "covered", widens: false, disconnects: false });
      expect(await elect(demo.clinicId, covered, owner(demo))).toMatchObject({
        status: "recorded",
        kind: "covered",
        widened: false,
        disconnected: false,
      });
      expect(await connectionRow(demo.clinicId)).toMatchObject({
        status: "active",
        account_ref: accountRef(WORKSPACE.sub),
      });

      // The owner's election since the connection was made lets the other domain in.
      expect(
        (await portalConnect(demo, demo.staffUserId, ELSEWHERE.sub, { steppedUp: true })).outcome,
      ).toBe("connected");
      expect(await connectionRow(demo.clinicId)).toMatchObject({
        status: "active",
        account_ref: accountRef(ELSEWHERE.sub),
        metadata: expect.objectContaining({ hostedDomain: ELSEWHERE.hd }),
      });
      expect(google.grantOf(oldToken)?.revoked).toBe(true);
    },
    SLOW,
  );

  test(
    "elections in the portal are the owner's: another member's is owner_only and a stranger's not_member, an unticked or unsigned one is refused, and a draft waits for its release",
    async () => {
      const demo = await seedLegacyDemoClinic("cp-owner-only");
      const manager = await seedPortalUser(demo.clinicId, "admin");
      const stranger = await seedClinic("cp-owner-only-other");
      // Seeding signs the demo clinic's agreement, and its copy has gone
      // through sendEmail since 19 October 2026: only what follows counts.
      mocks.sent.length = 0;
      const narrowing = {
        bookingSystem: "mindbody",
        calendarAccount: "workspace_no_baa",
        name: "Sam Lee",
        title: "Front desk",
        accepted: true,
      };
      const electAs = (
        clinicId: string,
        submission: Partial<typeof narrowing>,
        actor: PortalElectionActor,
      ) => elect(clinicId, { ...narrowing, ...submission }, actor);

      expect(
        await electAs(demo.clinicId, {}, { type: "user", userId: manager.userId, label: SIGN_IN }),
      ).toEqual({ status: "owner_only" });
      expect(await electAs(demo.clinicId, {}, owner(stranger))).toEqual({ status: "not_member" });
      expect(await electAs(demo.clinicId, { accepted: false }, owner(demo))).toMatchObject({
        status: "invalid",
        field: "accepted",
      });
      expect(await electAs(demo.clinicId, { name: " " }, owner(demo))).toMatchObject({
        status: "invalid",
        field: "name",
      });
      expect(await electAs(demo.clinicId, { bookingSystem: "zenoti" }, owner(demo))).toMatchObject({
        status: "invalid",
        field: "bookingSystem",
      });
      expect(
        await previewCalendarElection(demo.clinicId, {
          bookingSystem: "mindbody",
          calendarAccount: "shared_inbox",
        }),
      ).toMatchObject({ status: "invalid", field: "calendarAccount" });
      expect(await elections(demo.clinicId)).toEqual([]);
      expect(mocks.sent).toEqual([]);

      // The owner's narrowing election is recorded, and confirmed as theirs.
      expect(await electAs(demo.clinicId, {}, owner(demo))).toMatchObject({
        status: "recorded",
        kind: "not_used",
        widened: false,
        disconnected: false,
      });
      expect(await elections(demo.clinicId)).toMatchObject([
        { source: "portal", terms_kind: "not_used", owner_confirmed: true },
      ]);

      // Not a demo clinic: a draft form waits for its release.
      const legacy = await seedClinic("cp-owner-only-legacy");
      await bindAgreement(legacy.organizationId, "1.2.1");
      mocks.draft.election = true;
      expect(await getCalendarTerms(legacy.clinicId)).toEqual({
        terms: { kind: "needs_election", reason: "legacy_agreement" },
        election: { status: "unavailable", reason: "draft_terms" },
      });
      expect(await electAs(legacy.clinicId, {}, owner(legacy))).toEqual({
        status: "unavailable",
        reason: "draft_terms",
      });
      expect(
        await previewCalendarElection(legacy.clinicId, {
          bookingSystem: "mindbody",
          calendarAccount: "workspace_no_baa",
        }),
      ).toEqual({ status: "unavailable", reason: "draft_terms" });

      // No agreement in effect at all.
      const bare = await seedClinic("cp-owner-only-bare");
      expect(await getCalendarTerms(bare.clinicId)).toEqual({
        terms: { kind: "none" },
        election: { status: "unavailable", reason: "no_agreement" },
      });
      expect(await electAs(bare.clinicId, {}, owner(bare))).toEqual({
        status: "unavailable",
        reason: "no_agreement",
      });
      expect(await elections(legacy.clinicId)).toEqual([]);
      expect(await elections(bare.clinicId)).toEqual([]);

      // Released, as calendar-election/1.0.0 is (plan C19), the same location's
      // owner records it.
      mocks.draft.election = false;
      expect(await getCalendarTerms(legacy.clinicId)).toMatchObject({
        terms: { kind: "needs_election", reason: "legacy_agreement" },
        election: { status: "ready" },
      });
      expect(await electAs(legacy.clinicId, {}, owner(legacy))).toMatchObject({
        status: "recorded",
        kind: "not_used",
      });
    },
    SLOW,
  );

  test(
    "a practice under a DPA records its election on the DPA's own form, released with the DPA, and is never handed the BAA's",
    async () => {
      // The BAA's form is released (plan C19); the DPA's with the DPA, on 20
      // October 2026 (drizzle/0104).
      const baa = await seedClinic("cp-dpa-baa");
      await bindAgreement(baa.organizationId, "1.2.1");
      const dpa = await seedClinic("cp-dpa");
      await bindAgreement(dpa.organizationId, "dpa/1.0.0");
      const choice = {
        bookingSystem: "google_calendar",
        calendarAccount: "workspace_no_baa",
      } as const;

      // Under the BAA, the BAA's released form is offered: in the portal, and
      // through a calendar link whose page shows the election form.
      const offered = await previewCalendarElection(baa.clinicId, choice);
      expect(offered).toMatchObject({
        status: "ready",
        documentVersion: "calendar-election/1.0.0",
      });
      expect(
        await issueCalendarLink(baa.clinicId, { reason: "ops", rule: "useful" }),
      ).toMatchObject({ status: "issued" });
      const token = /\/calendar\/([A-Za-z0-9_-]{43})/.exec(mocks.sent.at(-1)?.text ?? "")?.[1];
      expect(token).toBeDefined();
      expect((await calendarLinkPage(token!)).state).toBe("election");

      // Under the DPA, its own form decides, and it is released: offered in
      // the portal in the DPA's words, never the BAA's...
      expect(await getCalendarTerms(dpa.clinicId)).toMatchObject({
        election: { status: "ready" },
      });
      const dpaPreview = await previewCalendarElection(dpa.clinicId, choice);
      expect(dpaPreview).toMatchObject({
        status: "ready",
        documentVersion: "calendar-election-dpa/1.0.0",
      });
      if (dpaPreview.status !== "ready") throw new Error("no preview");
      expect(dpaPreview.text).toContain("to the healdesk Data Protection Agreement");
      expect(dpaPreview.text).not.toMatch(/Business Associate Agreement/);
      // ...offered and mailed through a calendar link whose page shows the form...
      expect(
        await issueCalendarLink(dpa.clinicId, { reason: "ops", rule: "useful" }),
      ).toMatchObject({ status: "issued" });
      const dpaToken = /\/calendar\/([A-Za-z0-9_-]{43})/.exec(mocks.sent.at(-1)?.text ?? "")?.[1];
      expect(dpaToken).toBeDefined();
      expect((await calendarLinkPage(dpaToken!)).state).toBe("election");
      // ...and recorded by the owner, on that form.
      expect(
        await elect(
          dpa.clinicId,
          { ...choice, name: "Alex Chen", title: "Owner", accepted: true },
          owner(dpa),
        ),
      ).toMatchObject({ status: "recorded", kind: "uncovered" });
      const recorded = await elections(dpa.clinicId);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.rendered_text).toContain("to the healdesk Data Protection Agreement");
      expect(recorded[0]!.rendered_text).not.toMatch(/Business Associate Agreement/);
      const { rows } = await inTenant(dpa.clinicId, (client) =>
        client.query<{ document_version: string; document_released: boolean }>(
          `select document_version, document_released from calendar_elections where clinic_id = $1`,
          [dpa.clinicId],
        ),
      );
      expect(rows).toEqual([
        { document_version: "calendar-election-dpa/1.0.0", document_released: true },
      ]);
    },
    SLOW,
  );
});
