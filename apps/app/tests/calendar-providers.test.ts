import {
  FAKE_GOOGLE_CLIENT,
  fakeGoogleCalendar,
  resetGoogleTokenCache,
  setGoogleFetch,
  type ConnectorContext,
  type FakeGoogleCalendar,
} from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import type { EmailToSend } from "@/lib/email/send";
import {
  chooseCalendar,
  confirmCalendarTarget,
  listCalendars,
  listProviderCalendars,
  saveProviders,
  setProviderServices,
} from "@/lib/connections/google-calendar";
import { defaultAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedCalendarTerms, seedClinic, seedGoogleConnection } from "./setup/factories";

/**
 * HRC-04 (owner, 6 October 2026): a location under covered terms books only
 * into calendars of its connected account's own Workspace organisation, its
 * own calendar and every named provider's alike, checked when one is chosen
 * and again, against Google, before every write, failing closed. And the
 * named providers themselves: one calendar each, checked as the location's
 * own is, and the services each offers from the clinic's own list.
 */

vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return {
    ...actual,
    sendEmail: async (_email: EmailToSend) => ({ status: "sent", messageId: "m" }),
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const SLOW = 60_000;
const ENV = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

let google: FakeGoogleCalendar;
let sub: string;
let refreshToken: string;
let own: string;
let partner: string;
let personal: string;
const EMAIL = "bookings@radiance.test";

/** A Workspace account with its main calendar, one more of its own, and two shared in. */
function freshGoogle(): void {
  google = fakeGoogleCalendar();
  sub = `2${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  google.addAccount({ sub, email: EMAIL, hd: "radiance.test" });
  own = google.addCalendar(sub, { summary: "Treatment room" });
  partner = google.addCalendar(sub, { summary: "Partner clinic", organization: "partner.example" });
  personal = google.addCalendar(sub, { summary: "Someone's own", organization: null });
  refreshToken = google.grant({ sub }).refreshToken;
  setGoogleFetch(google.fetch);
  resetGoogleTokenCache();
}

async function connected(
  label: string,
  calendarAccount: "workspace_baa" | "workspace_no_baa" = "workspace_baa",
) {
  const clinic = await seedClinic(label);
  await seedCalendarTerms(clinic, { calendarAccount });
  await seedGoogleConnection(clinic.clinicId, { managed: true, refreshToken });
  return clinic;
}

function calendarListQueries(): Record<string, string>[] {
  return google.requests
    .filter((r) => r.endpoint === "calendarList")
    .map((r) => Object.fromEntries(r.url.searchParams));
}

describeDb("HRC-04 and named providers", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    vi.stubGlobal("fetch", () => {
      throw new Error("live call attempted from the provider tests");
    });
    for (const key of ENV) saved[key] = process.env[key];
    process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
  }, 60_000);

  beforeEach(freshGoogle);
  afterEach(() => setGoogleFetch(undefined));

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await closePools();
  });

  test(
    "a covered location is offered only its own organisation's calendars; an uncovered one every calendar its account owns",
    async () => {
      const covered = await connected("hrc-list-covered");
      const listed = await listCalendars(covered.clinicId);
      expect(listed).toMatchObject({ status: "ok", ownOrganizationOnly: true });
      expect(
        listed.status === "ok" ? listed.calendars.map((c) => [c.id, c.primary, c.current]) : null,
      ).toEqual([
        [EMAIL, true, true],
        [own, false, false],
      ]);
      expect(calendarListQueries()[0]).toMatchObject({
        minAccessRole: "owner",
        showOwnOrganizationOnly: "true",
      });

      google.clearRequests();
      const uncovered = await connected("hrc-list-uncovered", "workspace_no_baa");
      const all = await listCalendars(uncovered.clinicId);
      expect(all.status === "ok" ? all.calendars.map((c) => c.id) : null).toEqual([
        EMAIL,
        own,
        partner,
        personal,
      ]);
      expect(calendarListQueries()[0]!.showOwnOrganizationOnly).toBeUndefined();
    },
    SLOW,
  );

  test(
    "a covered location cannot choose a calendar shared in from another domain; choosing its own is verified and audited with no name or id",
    async () => {
      const clinic = await connected("hrc-choose");
      expect(await chooseCalendar(clinic.clinicId, partner)).toEqual({
        status: "refused",
        reason: "outside_organisation",
      });
      expect(await chooseCalendar(clinic.clinicId, personal)).toEqual({
        status: "refused",
        reason: "outside_organisation",
      });

      google.clearRequests();
      expect(await chooseCalendar(clinic.clinicId, own)).toEqual({
        status: "chosen",
        primary: false,
        changed: true,
      });
      // The connect-time check ran against the chosen calendar: free/busy and its owner role.
      const listed = google.requests.find((r) => r.endpoint === "list");
      expect(decodeURIComponent(listed!.url.pathname)).toContain(own);
      const metadata = await inTenant(
        clinic.clinicId,
        async (client) =>
          (
            await client.query<{ metadata: Record<string, unknown> }>(
              `select metadata from provider_connections where clinic_id = $1 and provider = 'google_calendar'`,
              [clinic.clinicId],
            )
          ).rows[0]!.metadata,
      );
      expect(metadata).toMatchObject({
        calendarId: own,
        calendarScope: "own_organization",
        accessRole: "owner",
      });

      const trail = await inTenant(clinic.clinicId, async (client) =>
        JSON.stringify(
          (
            await client.query(`select metadata from audit_log where clinic_id = $1`, [
              clinic.clinicId,
            ])
          ).rows,
        ),
      );
      expect(trail).toContain("calendar_target_changed");
      expect(trail).not.toContain("Treatment room");
      expect(trail).not.toContain(own);

      expect(await chooseCalendar(clinic.clinicId, EMAIL)).toEqual({
        status: "chosen",
        primary: true,
        changed: true,
      });
      expect((await listCalendars(clinic.clinicId)).status === "ok").toBe(true);
    },
    SLOW,
  );

  test(
    "a connection broken on its calendar is whole again once the clinic chooses one that passes the check",
    async () => {
      const clinic = await connected("hrc-recover");
      await inTenant(clinic.clinicId, (client) =>
        client.query(
          `update provider_connections
              set status = 'error', last_error = 'calendar_not_found', broken_at = now(), broken_alerted_at = now()
            where clinic_id = $1 and provider = 'google_calendar'`,
          [clinic.clinicId],
        ),
      );
      expect(await chooseCalendar(clinic.clinicId, own)).toEqual({
        status: "chosen",
        primary: false,
        changed: true,
      });
      const row = await inTenant(
        clinic.clinicId,
        async (client) =>
          (
            await client.query(
              `select status, last_error, broken_at, broken_alerted_at from provider_connections
            where clinic_id = $1 and provider = 'google_calendar'`,
              [clinic.clinicId],
            )
          ).rows[0],
      );
      expect(row).toEqual({
        status: "active",
        last_error: null,
        broken_at: null,
        broken_alerted_at: null,
      });
    },
    SLOW,
  );

  test("the write gate asks Google again before every insert, and refuses whatever it cannot confirm", async () => {
    const context: ConnectorContext = {
      clinicId: "00000000-0000-4000-8000-000000000001",
      connectionId: "00000000-0000-4000-8000-000000000002",
      credentials: { refresh_token: refreshToken },
      metadata: {},
      oauthClient: FAKE_GOOGLE_CLIENT,
    };
    const covered = { context, account: "workspace_baa" as const, writes: true, managed: true };

    google.clearRequests();
    expect(await confirmCalendarTarget({ ...covered, calendarId: "primary" })).toEqual({
      allowed: true,
      ownOrganization: true,
    });
    expect(google.calendarListCalls).toBe(0);

    expect(await confirmCalendarTarget({ ...covered, calendarId: own })).toEqual({
      allowed: true,
      ownOrganization: true,
    });
    expect(calendarListQueries().at(-1)).toMatchObject({ showOwnOrganizationOnly: "true" });

    // Chosen while it was the organisation's; now it is another domain's.
    google.setOrganization(sub, "partner.example", own);
    expect(await confirmCalendarTarget({ ...covered, calendarId: own })).toEqual({
      allowed: false,
      reason: "outside_organisation",
    });

    // Google cannot be asked: no.
    google.failNext({ on: "calendarList", status: 503, reason: "backendError" });
    expect(await confirmCalendarTarget({ ...covered, calendarId: partner })).toEqual({
      allowed: false,
      reason: "unverified",
    });

    // Covered terms need a Workspace account; every kind needs the one its terms name.
    expect(
      await confirmCalendarTarget({ ...covered, managed: false, calendarId: "primary" }),
    ).toEqual({ allowed: false, reason: "unmanaged_account" });
    expect(
      await confirmCalendarTarget({ ...covered, managed: null, calendarId: "primary" }),
    ).toEqual({ allowed: false, reason: "unmanaged_account" });
    expect(
      await confirmCalendarTarget({
        context,
        account: "personal",
        writes: true,
        managed: true,
        calendarId: "primary",
      }),
    ).toEqual({ allowed: false, reason: "account_mismatch" });
    expect(
      await confirmCalendarTarget({ ...covered, writes: false, calendarId: "primary" }),
    ).toEqual({ allowed: false, reason: "terms" });

    // Uncovered terms take any calendar the account owns, and nothing it does not.
    const uncovered = {
      context,
      account: "workspace_no_baa" as const,
      writes: true,
      managed: true,
    };
    expect(await confirmCalendarTarget({ ...uncovered, calendarId: partner })).toEqual({
      allowed: true,
      ownOrganization: false,
    });
    expect(
      await confirmCalendarTarget({
        ...uncovered,
        calendarId: "c_unknown@group.calendar.fake.test",
      }),
    ).toEqual({
      allowed: false,
      reason: "not_owned",
    });
  });

  test(
    "providers: each calendar is checked as the location's own, never shared by two, the main calendar stored as primary; providers left out are deactivated",
    async () => {
      const clinic = await connected("hrc-providers");
      expect(
        await saveProviders(clinic.clinicId, [
          { displayName: "Dr Ada", calendarId: own },
          { displayName: "Dr Bo", calendarId: partner },
        ]),
      ).toEqual({ status: "refused", reason: "outside_organisation", index: 1 });
      expect(
        await saveProviders(clinic.clinicId, [
          { displayName: "Dr Ada", calendarId: own },
          { displayName: "Dr Bo", calendarId: own },
        ]),
      ).toEqual({ status: "refused", reason: "duplicate_calendar", index: 1 });
      expect(await saveProviders(clinic.clinicId, [{ displayName: " ", calendarId: own }])).toEqual(
        {
          status: "refused",
          reason: "invalid_name",
          index: 0,
        },
      );

      const saved = await saveProviders(clinic.clinicId, [
        { displayName: "Dr Ada", calendarId: own },
        { displayName: " Dr Bo ", calendarId: EMAIL },
      ]);
      expect(saved.status).toBe("saved");
      const [ada, bo] = saved.status === "saved" ? saved.providers : [];
      expect(bo).toMatchObject({ displayName: "Dr Bo", calendarId: "primary" });

      // Ada takes the main calendar that Bo held; Bo is left out.
      const moved = await saveProviders(clinic.clinicId, [
        { id: ada!.id, displayName: "Dr Ada Lovelace", calendarId: "primary" },
      ]);
      expect(moved).toEqual({
        status: "saved",
        providers: [{ id: ada!.id, displayName: "Dr Ada Lovelace", calendarId: "primary" }],
      });
      const rows = await inTenant(
        clinic.clinicId,
        async (client) =>
          (
            await client.query<{ id: string; active: boolean; calendar_id: string }>(
              `select id, active, calendar_id from clinic_providers where clinic_id = $1 order by created_at, id`,
              [clinic.clinicId],
            )
          ).rows,
      );
      expect(rows.map((r) => [r.id === ada!.id ? "ada" : "bo", r.active, r.calendar_id])).toEqual(
        expect.arrayContaining([
          ["ada", true, "primary"],
          ["bo", false, "primary"],
        ]),
      );
      const trail = await inTenant(clinic.clinicId, async (client) =>
        JSON.stringify(
          (
            await client.query(
              `select metadata from audit_log where clinic_id = $1 and resource_type = 'clinic_providers'`,
              [clinic.clinicId],
            )
          ).rows,
        ),
      );
      expect(trail).toContain("clinic_providers_saved");
      expect(trail).not.toContain("Ada");

      expect(
        await saveProviders(clinic.clinicId, [
          { id: "00000000-0000-4000-8000-00000000000f", displayName: "Dr Cy", calendarId: own },
        ]),
      ).toEqual({
        status: "refused",
        reason: "unknown_provider",
        index: 0,
      });
    },
    SLOW,
  );

  test(
    "provider services come from the clinic's own list, case-insensitively, and replace the provider's mapping whole",
    async () => {
      const clinic = await connected("hrc-services");
      await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        updateAgentConfig(tx, {
          ...defaultAgentConfig("med-spa", "Radiance"),
          services: [
            { name: "Consultation", priceFromUsd: null, priceToUsd: null, durationMinutes: 30 },
            { name: "Skin Check", priceFromUsd: null, priceToUsd: null, durationMinutes: 45 },
          ],
        }),
      );
      const saved = await saveProviders(clinic.clinicId, [
        { displayName: "Dr Ada", calendarId: own },
      ]);
      const ada = saved.status === "saved" ? saved.providers[0]! : null;

      expect(
        await setProviderServices(clinic.clinicId, ada!.id, ["consultation", "  SKIN check "]),
      ).toEqual({
        status: "saved",
        services: ["consultation", "skin check"],
      });
      expect(await setProviderServices(clinic.clinicId, ada!.id, ["Laser"])).toEqual({
        status: "refused",
        reason: "unknown_service",
      });
      expect(await setProviderServices(clinic.clinicId, ada!.id, ["Consultation"])).toEqual({
        status: "saved",
        services: ["consultation"],
      });
      expect(
        await setProviderServices(clinic.clinicId, "00000000-0000-4000-8000-00000000000f", []),
      ).toEqual({
        status: "refused",
        reason: "unknown_provider",
      });

      const listed = await listProviderCalendars(clinic.clinicId);
      expect(listed).toMatchObject({
        status: "ok",
        ownOrganizationOnly: true,
        providers: [
          {
            id: ada!.id,
            displayName: "Dr Ada",
            calendarId: own,
            services: ["consultation"],
            calendarAvailable: true,
          },
        ],
      });
      expect(listed.status === "ok" ? listed.calendars.map((c) => c.id) : null).toEqual([
        EMAIL,
        own,
      ]);

      // Another domain took Ada's calendar over: she is shown as needing a new one.
      google.setOrganization(sub, "partner.example", own);
      expect(await listProviderCalendars(clinic.clinicId)).toMatchObject({
        status: "ok",
        providers: [{ id: ada!.id, calendarAvailable: false }],
      });
    },
    SLOW,
  );

  test(
    "providers checked against one connection are not written once the location holds another token",
    async () => {
      const clinic = await connected("hrc-providers-race");
      // The location reconnects while Google is being asked about the calendars.
      let reconnected = false;
      setGoogleFetch(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!reconnected && url.includes("/calendarList")) {
          reconnected = true;
          await seedGoogleConnection(clinic.clinicId, { managed: true, refreshToken });
        }
        return google.fetch(input, init);
      });
      expect(
        await saveProviders(clinic.clinicId, [{ displayName: "Dr Ada", calendarId: own }]),
      ).toEqual({ status: "failed", reason: "connection_changed" });
      expect(reconnected).toBe(true);
      const rows = await inTenant(
        clinic.clinicId,
        async (client) =>
          (
            await client.query(`select id from clinic_providers where clinic_id = $1`, [
              clinic.clinicId,
            ])
          ).rows,
      );
      expect(rows).toEqual([]);

      // Asked again on the connection it holds now, the same list is saved.
      setGoogleFetch(google.fetch);
      expect(
        await saveProviders(clinic.clinicId, [{ displayName: "Dr Ada", calendarId: own }]),
      ).toMatchObject({ status: "saved" });
    },
    SLOW,
  );
});
