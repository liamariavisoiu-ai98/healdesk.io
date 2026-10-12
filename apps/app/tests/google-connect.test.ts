import { createHash, randomUUID } from "node:crypto";

import { GOOGLE_CALENDAR_DISCLOSURE } from "@healdesk/catalog";
import {
  FAKE_GOOGLE_CLIENT,
  fakeGoogleCalendar,
  GOOGLE_SCOPES,
  resetGoogleTokenCache,
  setGoogleFetch,
  type FakeGoogleCalendar,
} from "@healdesk/connectors";
import { sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { CalendarLinkView, type CalendarPageQuery } from "@/app/calendar/[token]/CalendarView";
import { POST as startRoute } from "@/app/api/calendar/google/start/route";
import type { EmailToSend } from "@/lib/email/send";
import { recordCalendarElection } from "@/lib/booking/elections";
import {
  calendarLinkPage,
  connectedOn,
  issueCalendarLink,
  offerCalendarLink,
  reissueCalendarLink,
  requestAccountChangeLink,
  submitCalendarElection,
  type CalendarPageModel,
} from "@/lib/connections/calendar-links";
import {
  chooseCalendar,
  disconnectGoogleCalendar,
  getCalendarConnection,
  saveProviders,
  sweepCalendarTerms,
} from "@/lib/connections/google-calendar";
import {
  beginGoogleSignIn,
  completeGoogleSignIn,
  GoogleConnectError,
  startGoogleConnect,
} from "@/lib/connections/google-oauth";
import { issueConnectionLink, resolveConnectionLink } from "@/lib/connections/links";
import { withCredentials } from "@/lib/connections/store";
import { __setKeyWrapperForTests, type KeyWrapper } from "@/lib/crypto/kms";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedCalendarTerms, seedClinic, seedDemoClinic } from "./setup/factories";

/**
 * Connecting a location's Google Calendar (plan §4, as the addendum changed
 * it), against the in-memory Google: the calendar links and who they reach,
 * the sign-in's state, binding and checks, what is kept and what is
 * revoked, elections through a link, and the page's rules. Never a live
 * call: the global fetch throws, and every email is captured.
 */

const sent = vi.hoisted(() => [] as EmailToSend[]);
vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return {
    ...actual,
    sendEmail: async (email: EmailToSend) => {
      sent.push(email);
      return { status: "sent", messageId: `m-${sent.length}` };
    },
  };
});

/** What the funnel's O13 seam was asked to tell each clinic, in order. */
const calendarStates = vi.hoisted(
  () => [] as { clinicId: string; state: string; dedupeKey: string }[],
);
vi.mock("@/lib/notices/calendar-state", () => ({
  notifyCalendarState: async (
    _tx: unknown,
    clinicId: string,
    state: string,
    opts: { dedupeKey: string },
  ) => {
    calendarStates.push({ clinicId, state, dedupeKey: opts.dedupeKey });
  },
}));

/** The cookies a server action set: startGoogleConnect's browser binding. */
const cookieJar = vi.hoisted(
  () => [] as { name: string; value: string; options: Record<string, unknown> }[],
);
vi.mock("next/headers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/headers")>();
  return {
    ...actual,
    cookies: async () => ({
      set: (name: string, value: string, options: Record<string, unknown>) => {
        cookieJar.push({ name, value, options });
      },
    }),
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "https://app.healdesk.test";
const ACTOR = { type: "service", serviceName: "test" } as const;
/**
 * The Google accounts, fresh for each test: one account is live on one
 * location across the whole database, so a sub one test connected would be
 * `account_in_use` in the next.
 */
type Account = { sub: string; email: string; hd?: string };
let WORKSPACE: Account;
let COLLEAGUE: Account;
let ELSEWHERE: Account;
let PERSONAL: Account;
function freshAccounts(): void {
  const n = () =>
    `1${Math.floor(Math.random() * 1e15)
      .toString()
      .padStart(15, "0")}${Date.now() % 1000}`;
  WORKSPACE = { sub: n(), email: "bookings@radiance.test", hd: "radiance.test" };
  COLLEAGUE = { sub: n(), email: "desk@radiance.test", hd: "radiance.test" };
  ELSEWHERE = { sub: n(), email: "owner@other.test", hd: "other.test" };
  PERSONAL = { sub: n(), email: "radiance.bookings@gmail.test" };
}
const SLOW = 90_000;

const ENV = [
  "BETTER_AUTH_URL",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "HEALDESK_KMS_PROVIDER",
] as const;
const saved: Record<string, string | undefined> = {};

let google: FakeGoogleCalendar;

function accountRef(sub: string): string {
  return createHash("sha256").update(`google:${sub}`).digest("hex");
}

function tokensMailed(): string[] {
  return sent.flatMap((email) =>
    [...email.text.matchAll(/\/calendar\/([A-Za-z0-9_-]{43})/g)].map((m) => m[1]!),
  );
}

/** A recipients link, minted as ops mints one, and its token from the email. */
async function recipientsLink(clinicId: string): Promise<string> {
  const before = sent.length;
  const issued = await issueCalendarLink(clinicId, { reason: "ops", rule: "useful" });
  expect(issued.status).toBe("issued");
  const token = tokensMailed().slice(-1)[0]!;
  expect(sent.length).toBe(before + 1);
  return token;
}

/** The whole round trip from a link: start, consent at Google, callback. */
async function signIn(
  token: string,
  consent: {
    sub: string;
    scopes?: readonly string[];
    decline?: boolean;
    withholdRefreshToken?: boolean;
  },
  options: { cookie?: (value: string) => string } = {},
) {
  const link = await resolveConnectionLink(token, {}, "calendar");
  expect(link).not.toBeNull();
  const { authUrl, cookieValue } = await beginGoogleSignIn({
    clinicId: link!.clinicId,
    via: { kind: "calendar_link", linkId: link!.linkId, token },
    disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
    actor: ACTOR,
  });
  const answer = google.authorize(authUrl, consent);
  const input = {
    state: answer.state,
    code: "code" in answer ? answer.code : null,
    error: "error" in answer ? answer.error : null,
    cookie: options.cookie ? options.cookie(cookieValue) : cookieValue,
  };
  return { authUrl, cookieValue, input, result: await completeGoogleSignIn(input) };
}

/** The round trip from the portal, as its server action starts one: from setup or from Settings. */
async function portalSignIn(
  clinic: { clinicId: string; staffUserId: string },
  returnTo: "portal" | "wizard",
  consent: { sub: string },
) {
  const { authUrl, cookieValue } = await beginGoogleSignIn({
    clinicId: clinic.clinicId,
    via: { kind: "portal", userId: clinic.staffUserId, returnTo },
    disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
    actor: { type: "user", userId: clinic.staffUserId, label: "clinic portal" },
  });
  const answer = google.authorize(authUrl, consent) as { code: string; state: string };
  return completeGoogleSignIn({ ...answer, error: null, cookie: cookieValue });
}

const PAGE_ACTIONS = {
  submitElection: async () => {},
  requestChangeLink: async () => {},
  chooseCalendar: async () => {},
  reissue: async () => {},
};

async function auditTrail(clinicId: string): Promise<string> {
  return inTenant(clinicId, async (client) =>
    JSON.stringify(
      (await client.query(`select metadata from audit_log where clinic_id = $1`, [clinicId])).rows,
    ),
  );
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

function bagOf(clinicId: string, connectionId: string) {
  return withTenant({ clinicId, actor: ACTOR }, (tx) =>
    withCredentials(tx.db, { clinicId, connectionId }, async (bag) => bag),
  );
}

function revokedTokens(): string[] {
  return google.requests
    .filter((r) => r.endpoint === "revoke")
    .map((r) => r.form?.get("token") ?? "");
}

describeDb("connecting a Google Calendar", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    vi.stubGlobal("fetch", () => {
      throw new Error("live call attempted from the connect tests");
    });
    for (const key of ENV) saved[key] = process.env[key];
    process.env.BETTER_AUTH_URL = ORIGIN;
    process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
  }, 60_000);

  beforeEach(() => {
    sent.length = 0;
    calendarStates.length = 0;
    cookieJar.length = 0;
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
    "a link's sign-in asks for the five scopes, keeps only the sealed token and three facts, spends the link and goes on under a new one",
    async () => {
      const clinic = await seedClinic("gc-connect");
      await seedCalendarTerms(clinic);
      const token = await recipientsLink(clinic.clinicId);
      expect(sent[0]!.to).toBe(clinic.staffEmail.toLowerCase());
      expect(sent[0]!.kind).toBe("calendar_link");

      const { authUrl, input, result } = await signIn(token, { sub: WORKSPACE.sub });
      const asked = new URL(authUrl).searchParams;
      expect(asked.get("scope")).toBe(GOOGLE_SCOPES.join(" "));
      expect(asked.get("redirect_uri")).toBe(`${ORIGIN}/api/calendar/google/callback`);
      expect(asked.get("code_challenge_method")).toBe("S256");
      expect(asked.get("hd")).toBeNull();
      expect(asked.get("login_hint")).toBeNull();

      expect(result.outcome).toBe("connected");
      const next = /^\/calendar\/([A-Za-z0-9_-]{43})\?outcome=connected$/.exec(
        result.redirectPath,
      )?.[1];
      expect(next).toBeDefined();
      expect(next).not.toBe(token);

      const row = (await connectionRow(clinic.clinicId))!;
      expect(row).toMatchObject({
        status: "active",
        account_ref: accountRef(WORKSPACE.sub),
        last_error: null,
      });
      expect(row.metadata).toMatchObject({
        calendarId: "primary",
        accountEmail: WORKSPACE.email,
        managed: true,
        hostedDomain: WORKSPACE.hd,
        calendarScope: "own_organization",
        disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
        connectedVia: "calendar_link",
      });
      expect(JSON.stringify(row.metadata)).not.toContain(WORKSPACE.sub);
      const bag = await bagOf(clinic.clinicId, row.id);
      expect(Object.keys(bag)).toEqual(["refresh_token"]);
      expect(google.grantOf(bag.refresh_token!)?.revoked).toBe(false);

      // The link that was used is dead; the page goes on under the new one.
      expect(await resolveConnectionLink(token, {}, "calendar")).toBeNull();
      expect((await resolveConnectionLink(next!, {}, "calendar"))?.clinicId).toBe(clinic.clinicId);

      // The state is single use, and the audit trail names no account.
      expect((await completeGoogleSignIn(input)).outcome).toBe("expired");
      const audit = await inTenant(
        clinic.clinicId,
        async (client) =>
          (
            await client.query<{ metadata: unknown }>(
              `select metadata from audit_log where clinic_id = $1`,
              [clinic.clinicId],
            )
          ).rows,
      );
      const trail = JSON.stringify(audit);
      expect(trail).toContain("calendar_connected");
      expect(trail).toContain("calendar_disclosure_accepted");
      expect(trail).not.toContain(WORKSPACE.email);
      expect(trail).not.toContain(WORKSPACE.sub);

      // Reconnecting the same account, on the page's continuation link,
      // replaces the token and revokes nothing: Google's revoke would end the
      // new grant with the old.
      const again = await signIn(next!, { sub: WORKSPACE.sub });
      expect(again.result.outcome).toBe("connected");
      const replaced = (await bagOf(clinic.clinicId, row.id)).refresh_token!;
      expect(replaced).not.toBe(bag.refresh_token);
      expect(google.grantOf(replaced)?.revoked).toBe(false);
      expect(revokedTokens()).toEqual([]);

      // The portal's view of it.
      expect(await getCalendarConnection(clinic.clinicId)).toMatchObject({
        status: "active",
        account: { email: WORKSPACE.email, kind: "workspace", domain: WORKSPACE.hd },
        calendar: { id: "primary", primary: true },
        disclosureCurrent: true,
      });
    },
    SLOW,
  );

  test(
    "another browser, and a declined, an incomplete or an offline-less grant, keep nothing; what Google granted is revoked",
    async () => {
      const clinic = await seedClinic("gc-refusals");
      await seedCalendarTerms(clinic);
      const token = await recipientsLink(clinic.clinicId);

      // The state is bound to the browser that started it.
      const stolen = await signIn(
        token,
        { sub: WORKSPACE.sub },
        {
          cookie: (value) => `${"A".repeat(43)}${value.slice(43)}`,
        },
      );
      expect(stolen.result).toEqual({
        outcome: "expired",
        redirectPath: "/calendar/done?outcome=expired",
      });

      expect((await signIn(token, { sub: WORKSPACE.sub, decline: true })).result).toEqual({
        outcome: "declined",
        redirectPath: `/calendar/${token}?outcome=declined`,
      });
      expect(revokedTokens()).toEqual([]);

      const noOwned = GOOGLE_SCOPES.filter((s) => !s.endsWith("calendar.events.owned"));
      expect((await signIn(token, { sub: WORKSPACE.sub, scopes: noOwned })).result.outcome).toBe(
        "scopes",
      );
      expect(revokedTokens()).toHaveLength(1);

      expect(
        (await signIn(token, { sub: WORKSPACE.sub, withholdRefreshToken: true })).result.outcome,
      ).toBe("no_refresh");
      expect(revokedTokens()).toHaveLength(2);

      expect(await connectionRow(clinic.clinicId)).toBeNull();
      // None of them spent the link.
      expect(await resolveConnectionLink(token, {}, "calendar")).not.toBeNull();
    },
    SLOW,
  );

  test(
    "covered terms on a personal account are a mismatch: nothing is kept, the grant is revoked and the link still works (HRC-04)",
    async () => {
      const clinic = await seedClinic("gc-mismatch");
      await seedCalendarTerms(clinic, { calendarAccount: "workspace_baa" });
      const token = await recipientsLink(clinic.clinicId);
      const { result } = await signIn(token, { sub: PERSONAL.sub });
      expect(result).toEqual({
        outcome: "mismatch",
        redirectPath: `/calendar/${token}?outcome=mismatch`,
      });
      expect(await connectionRow(clinic.clinicId)).toBeNull();
      expect(revokedTokens()).toHaveLength(1);
      expect(await resolveConnectionLink(token, {}, "calendar")).not.toBeNull();
    },
    SLOW,
  );

  test(
    "a failure after the exchange (the seal throws) keeps nothing and revokes the unused grant",
    async () => {
      const clinic = await seedClinic("gc-seal");
      await seedCalendarTerms(clinic);
      const token = await recipientsLink(clinic.clinicId);
      const link = (await resolveConnectionLink(token, {}, "calendar"))!;
      const { authUrl, cookieValue } = await beginGoogleSignIn({
        clinicId: clinic.clinicId,
        via: { kind: "calendar_link", linkId: link.linkId, token },
        disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
        actor: ACTOR,
      });
      const answer = google.authorize(authUrl, { sub: WORKSPACE.sub }) as {
        code: string;
        state: string;
      };
      const broken: KeyWrapper = {
        keyVersion: "broken",
        generateDek: async () => {
          throw new Error("KMS refused");
        },
        unwrapDek: async () => {
          throw new Error("KMS refused");
        },
        wrapExisting: async () => {
          throw new Error("KMS refused");
        },
      };
      __setKeyWrapperForTests(broken);
      try {
        const result = await completeGoogleSignIn({ ...answer, error: null, cookie: cookieValue });
        expect(result.outcome).toBe("failed");
      } finally {
        __setKeyWrapperForTests(undefined);
      }
      expect(await connectionRow(clinic.clinicId)).toBeNull();
      expect(revokedTokens()).toHaveLength(1);
      expect(await resolveConnectionLink(token, {}, "calendar")).not.toBeNull();
    },
    SLOW,
  );

  test(
    "nobody is sent to Google from a deployment that cannot seal: the start route answers 503 and mints no state",
    async () => {
      const clinic = await seedClinic("gc-503");
      await seedCalendarTerms(clinic);
      const token = await recipientsLink(clinic.clinicId);
      const states = async () =>
        (
          await getMigratorPool().query(
            `select count(*)::int as n from google_oauth_states where target_clinic_id = $1`,
            [clinic.clinicId],
          )
        ).rows[0]!.n;

      const post = () =>
        startRoute(
          new Request(`${ORIGIN}/api/calendar/google/start`, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token,
              disclosure: "accepted",
              disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
            }).toString(),
          }),
        );

      // Production with no working KMS: the wrapper does not build.
      __setKeyWrapperForTests(undefined);
      process.env.HEALDESK_KMS_PROVIDER = "aws-kms";
      try {
        const refused = await post();
        expect(refused.status).toBe(503);
        expect(refused.headers.get("location")).toBeNull();
        expect(refused.headers.get("set-cookie")).toBeNull();
      } finally {
        process.env.HEALDESK_KMS_PROVIDER = "local";
        __setKeyWrapperForTests(undefined);
      }
      expect(await states()).toBe(0);

      // Working again, the same form goes to Google with the binding cookie.
      const started = await post();
      expect(started.status).toBe(303);
      expect(new URL(started.headers.get("location")!).origin).toBe("https://accounts.google.com");
      expect(started.headers.get("set-cookie")).toMatch(
        /^hd_gcal=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}; Path=\/api\/calendar\/google; Max-Age=900; HttpOnly; SameSite=Lax/,
      );
      expect(await states()).toBe(1);

      // Unticked, or from another origin: refused before any state.
      const unticked = await startRoute(
        new Request(`${ORIGIN}/api/calendar/google/start`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }).toString(),
        }),
      );
      expect(unticked.headers.get("location")).toBe(
        `${ORIGIN}/calendar/${token}?outcome=disclosure`,
      );
      const foreign = await startRoute(
        new Request(`${ORIGIN}/api/calendar/google/start`, {
          method: "POST",
          headers: {
            origin: "https://evil.example",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ token, disclosure: "accepted" }).toString(),
        }),
      );
      expect(foreign.status).toBe(403);
      expect(await states()).toBe(1);
    },
    SLOW,
  );

  test(
    "a different account through a recipients link changes nothing and is revoked; only the owner is mailed the change link, through which the account is replaced and the old grant revoked",
    async () => {
      const clinic = await seedClinic("gc-change");
      await seedCalendarTerms(clinic);
      const first = await signIn(await recipientsLink(clinic.clinicId), { sub: WORKSPACE.sub });
      expect(first.result.outcome).toBe("connected");
      const row = (await connectionRow(clinic.clinicId))!;
      const oldToken = (await bagOf(clinic.clinicId, row.id)).refresh_token!;
      // Two named providers: one on another calendar of this account, one on its main calendar.
      const room = google.addCalendar(WORKSPACE.sub, { summary: "Treatment room" });
      expect(
        await saveProviders(clinic.clinicId, [
          { displayName: "Dr Ada", calendarId: room },
          { displayName: "Dr Bo", calendarId: "primary" },
        ]),
      ).toMatchObject({ status: "saved" });

      const token = await recipientsLink(clinic.clinicId);
      const other = await signIn(token, { sub: COLLEAGUE.sub });
      expect(other.result.outcome).toBe("different_account");
      expect((await connectionRow(clinic.clinicId))!.account_ref).toBe(accountRef(WORKSPACE.sub));
      expect(revokedTokens()).toHaveLength(1);
      expect(google.grantOf(oldToken)?.revoked).toBe(false);

      // "Use a different Google account": mailed to the owner alone.
      sent.length = 0;
      expect(await requestAccountChangeLink(token)).toBe("sent");
      expect(sent.map((email) => email.to)).toEqual([clinic.staffEmail.toLowerCase()]);
      expect(sent[0]!.subject).toBe("Change the Google account healdesk books into");
      const change = tokensMailed()[0]!;
      const changeLink = (await resolveConnectionLink(change, {}, "calendar"))!;
      expect(changeLink).toMatchObject({
        audience: "owner",
        allowsAccountChange: true,
        sentTo: [clinic.staffEmail.toLowerCase()],
      });

      const replaced = await signIn(change, { sub: COLLEAGUE.sub });
      expect(replaced.result.outcome).toBe("connected");
      expect((await connectionRow(clinic.clinicId))!.account_ref).toBe(accountRef(COLLEAGUE.sub));
      expect(google.grantOf(oldToken)?.revoked).toBe(true);

      // The provider on the old account's other calendar is off until the
      // clinic chooses again; the main calendar is the new account's own.
      const providers = await inTenant(
        clinic.clinicId,
        async (client) =>
          (
            await client.query<{ display_name: string; active: boolean }>(
              `select display_name, active from clinic_providers where clinic_id = $1 order by display_name`,
              [clinic.clinicId],
            )
          ).rows,
      );
      expect(providers).toEqual([
        { display_name: "Dr Ada", active: false },
        { display_name: "Dr Bo", active: true },
      ]);
    },
    SLOW,
  );

  test(
    "through a change link, an account in another Workspace domain needs an election first",
    async () => {
      const clinic = await seedClinic("gc-domain");
      await seedCalendarTerms(clinic);
      expect(
        (await signIn(await recipientsLink(clinic.clinicId), { sub: WORKSPACE.sub })).result
          .outcome,
      ).toBe("connected");
      const token = await recipientsLink(clinic.clinicId);
      sent.length = 0;
      await requestAccountChangeLink(token);
      const change = tokensMailed()[0]!;
      const { result } = await signIn(change, { sub: ELSEWHERE.sub });
      expect(result).toEqual({
        outcome: "election_needed",
        redirectPath: `/calendar/${change}?outcome=election_needed`,
      });
      expect((await connectionRow(clinic.clinicId))!.account_ref).toBe(accountRef(WORKSPACE.sub));
    },
    SLOW,
  );

  test(
    "the owner's election on the change link's page lets an account in another Workspace domain replace the connection",
    async () => {
      // A demo clinic, the only kind that may record an election before the
      // document is released, under covered terms the owner recorded.
      const demo = await seedDemoClinic("gc-domain-elect");
      const covered = await withTenant({ clinicId: demo.clinicId, actor: ACTOR }, (tx) =>
        recordCalendarElection(tx, {
          choice: { bookingSystem: "google_calendar", calendarAccount: "workspace_baa" },
          signatory: { name: "Alex Chen", title: "Owner" },
          via: { source: "portal", userId: demo.staffUserId },
        }),
      );
      expect(covered.status).toBe("recorded");
      expect(
        (await signIn(await recipientsLink(demo.clinicId), { sub: WORKSPACE.sub })).result.outcome,
      ).toBe("connected");
      const row = (await connectionRow(demo.clinicId))!;
      const oldToken = (await bagOf(demo.clinicId, row.id)).refresh_token!;

      expect(await requestAccountChangeLink(await recipientsLink(demo.clinicId))).toBe("sent");
      const change = tokensMailed().slice(-1)[0]!;
      expect((await signIn(change, { sub: ELSEWHERE.sub })).result).toEqual({
        outcome: "election_needed",
        redirectPath: `/calendar/${change}?outcome=election_needed`,
      });

      // The page the browser comes back to shows the owner the election form.
      const model = await calendarLinkPage(change);
      expect(model).toMatchObject({ state: "connect", accountChange: true });
      const page = renderToStaticMarkup(
        CalendarLinkView({
          model,
          query: { outcome: "election_needed", notice: null, problem: null, elect: false },
          actions: PAGE_ACTIONS,
        }),
      );
      expect(page).toContain('name="bookingSystem"');
      expect(page).toContain('name="calendarAccount"');

      // Recorded on the owner's link, so the owner's; nothing changes until
      // the account signs in again, on the link the page goes on under.
      const elected = await submitCalendarElection(change, {
        bookingSystem: "google_calendar",
        calendarAccount: "workspace_baa",
        name: "Alex Chen",
        title: "Owner",
        accepted: true,
      });
      const next = /^\/calendar\/([A-Za-z0-9_-]{43})\?done=election_recorded$/.exec(
        elected.status === "recorded" ? elected.next : "",
      )?.[1];
      expect(next).toBeDefined();
      expect((await connectionRow(demo.clinicId))!.account_ref).toBe(accountRef(WORKSPACE.sub));

      expect((await signIn(next!, { sub: ELSEWHERE.sub })).result.outcome).toBe("connected");
      const replaced = (await connectionRow(demo.clinicId))!;
      expect(replaced).toMatchObject({ status: "active", account_ref: accountRef(ELSEWHERE.sub) });
      expect(replaced.metadata).toMatchObject({ hostedDomain: ELSEWHERE.hd });
      expect(google.grantOf(oldToken)?.revoked).toBe(true);
    },
    SLOW,
  );

  test(
    "a reconnect after setup tells the clinic once; a first connect and a reconnect from the setup wizard tell nobody",
    async () => {
      const clinic = await seedClinic("gc-reconnect-notice");
      await seedCalendarTerms(clinic);
      expect(
        (await signIn(await recipientsLink(clinic.clinicId), { sub: WORKSPACE.sub })).result
          .outcome,
      ).toBe("connected");
      expect(calendarStates).toEqual([]);

      expect((await portalSignIn(clinic, "wizard", { sub: WORKSPACE.sub })).outcome).toBe(
        "connected",
      );
      expect(calendarStates).toEqual([]);

      // From Settings, then from a link: each a reconnect after setup.
      expect(await portalSignIn(clinic, "portal", { sub: WORKSPACE.sub })).toEqual({
        outcome: "connected",
        redirectPath: `/c/${clinic.slug}/settings?calendar=connected`,
      });
      expect(
        (await signIn(await recipientsLink(clinic.clinicId), { sub: WORKSPACE.sub })).result
          .outcome,
      ).toBe("connected");
      expect(calendarStates.map(({ clinicId, state }) => [clinicId, state])).toEqual([
        [clinic.clinicId, "reconnected"],
        [clinic.clinicId, "reconnected"],
      ]);
      expect(calendarStates[0]!.dedupeKey).toMatch(/^calendar-reconnected:/);
      expect(calendarStates[1]!.dedupeKey).not.toBe(calendarStates[0]!.dedupeKey);
    },
    SLOW,
  );

  test(
    "the portal's start binds the browser with an HttpOnly cookie on the callback's path, and refuses before Google when the grant could not be kept or the terms need an election",
    async () => {
      const clinic = await seedClinic("gc-portal-start");
      await seedCalendarTerms(clinic);
      const base = {
        clinicId: clinic.clinicId,
        returnTo: `/c/${clinic.slug}/setup`,
        disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
        userId: clinic.staffUserId,
      };
      const { authUrl } = await startGoogleConnect(base);
      expect(new URL(authUrl).origin).toBe("https://accounts.google.com");
      expect(cookieJar).toHaveLength(1);
      expect(cookieJar[0]).toMatchObject({
        name: "hd_gcal",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/api/calendar/google",
          maxAge: 900,
          secure: false,
        },
      });
      expect(cookieJar[0]!.value).toMatch(/^[A-Za-z0-9_-]{43}\.$/);

      // That cookie completes the round trip, back to setup, telling nobody.
      const answer = google.authorize(authUrl, { sub: WORKSPACE.sub }) as {
        code: string;
        state: string;
      };
      expect(
        await completeGoogleSignIn({ ...answer, error: null, cookie: cookieJar[0]!.value }),
      ).toEqual({
        outcome: "connected",
        redirectPath: `/c/${clinic.slug}/setup?calendar=connected`,
      });
      expect(calendarStates).toEqual([]);

      const refusal = async (input: Parameters<typeof startGoogleConnect>[0]) => {
        try {
          await startGoogleConnect(input);
          return "started";
        } catch (error) {
          return error instanceof GoogleConnectError ? error.code : String(error);
        }
      };
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      try {
        expect(await refusal(base)).toBe("unavailable");
      } finally {
        process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
      }
      expect(await refusal({ ...base, disclosureVersion: "google-calendar-disclosure/0" })).toBe(
        "disclosure",
      );
      const demo = await seedDemoClinic("gc-portal-start-elect");
      expect(
        await refusal({
          clinicId: demo.clinicId,
          returnTo: `/c/${demo.slug}/settings`,
          disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
          userId: demo.staffUserId,
        }),
      ).toBe("needs_election");
      expect(cookieJar).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a reconnect keeps its chosen calendar, moves to the main calendar only when Google refuses that one, and never because Google could not answer",
    async () => {
      const clinic = await seedClinic("gc-kept-calendar");
      await seedCalendarTerms(clinic);
      expect(
        (await signIn(await recipientsLink(clinic.clinicId), { sub: WORKSPACE.sub })).result
          .outcome,
      ).toBe("connected");
      const room = google.addCalendar(WORKSPACE.sub, { summary: "Treatment room" });
      expect(await chooseCalendar(clinic.clinicId, room)).toMatchObject({ status: "chosen" });

      expect(
        (await signIn(await recipientsLink(clinic.clinicId), { sub: WORKSPACE.sub })).result
          .outcome,
      ).toBe("connected");
      expect((await connectionRow(clinic.clinicId))!.metadata).toMatchObject({ calendarId: room });

      // Google's calendar list fails: nothing is stored, and nothing moves.
      const before = (await connectionRow(clinic.clinicId))!;
      const token = await recipientsLink(clinic.clinicId);
      google.failNext({ on: "calendarList", status: 503, reason: "backendError" });
      expect((await signIn(token, { sub: WORKSPACE.sub })).result).toEqual({
        outcome: "probe",
        redirectPath: `/calendar/${token}?outcome=probe`,
      });
      expect(await connectionRow(clinic.clinicId)).toEqual(before);
      expect(revokedTokens()).toEqual([]);

      // Another domain took that calendar over: the main calendar, audited.
      google.setOrganization(WORKSPACE.sub, "partner.example", room);
      expect((await signIn(token, { sub: WORKSPACE.sub })).result.outcome).toBe("connected");
      expect((await connectionRow(clinic.clinicId))!.metadata).toMatchObject({
        calendarId: "primary",
      });
      const trail = await auditTrail(clinic.clinicId);
      expect(trail).toContain('"via":"sign_in"');
      expect(trail).not.toContain(room);
    },
    SLOW,
  );

  test(
    "an account live on another location is refused as in use, and is not revoked",
    async () => {
      const a = await seedClinic("gc-inuse-a");
      const b = await seedClinic("gc-inuse-b");
      await seedCalendarTerms(a);
      await seedCalendarTerms(b);
      expect(
        (await signIn(await recipientsLink(a.clinicId), { sub: WORKSPACE.sub })).result.outcome,
      ).toBe("connected");
      const { result } = await signIn(await recipientsLink(b.clinicId), { sub: WORKSPACE.sub });
      expect(result.outcome).toBe("account_in_use");
      expect(await connectionRow(b.clinicId)).toBeNull();
      expect(revokedTokens()).toEqual([]);
      const aRow = (await connectionRow(a.clinicId))!;
      expect(google.grantOf((await bagOf(a.clinicId, aRow.id)).refresh_token!)?.revoked).toBe(
        false,
      );
    },
    SLOW,
  );

  test(
    "disconnecting erases the token and revokes the grant; the terms sweep disconnects what a terminated agreement no longer covers",
    async () => {
      const clinic = await seedClinic("gc-disconnect");
      await seedCalendarTerms(clinic);
      expect(
        (await signIn(await recipientsLink(clinic.clinicId), { sub: WORKSPACE.sub })).result
          .outcome,
      ).toBe("connected");
      const row = (await connectionRow(clinic.clinicId))!;
      const token = (await bagOf(clinic.clinicId, row.id)).refresh_token!;
      // It had broken on its calendar first (status `error`, the token kept).
      await inTenant(clinic.clinicId, (client) =>
        client.query(
          `update provider_connections
              set status = 'error', last_error = 'calendar_not_found', broken_at = now(), broken_alerted_at = now()
            where clinic_id = $1 and provider = 'google_calendar'`,
          [clinic.clinicId],
        ),
      );

      expect(await disconnectGoogleCalendar(clinic.clinicId, { reason: "clinic" })).toMatchObject({
        status: "disconnected",
        revokedAtGoogle: "revoked",
      });
      expect(await connectionRow(clinic.clinicId)).toMatchObject({
        status: "revoked",
        last_error: "clinic",
      });
      expect(await bagOf(clinic.clinicId, row.id)).toEqual({});
      expect(google.grantOf(token)?.revoked).toBe(true);
      // Disconnected on purpose: nobody is told Google took the access away.
      expect(await getCalendarConnection(clinic.clinicId)).toEqual({
        status: "not_connected",
        accessRemovedAt: null,
      });
      expect(await calendarLinkPage(await recipientsLink(clinic.clinicId))).toMatchObject({
        state: "connect",
        accessRemoved: false,
      });
      expect(await disconnectGoogleCalendar(clinic.clinicId, { reason: "clinic" })).toEqual({
        status: "not_connected",
      });

      // Connected again, then the agreement ends: the sweep takes it away.
      const again = await signIn(await recipientsLink(clinic.clinicId), { sub: COLLEAGUE.sub });
      expect(again.result.outcome).toBe("connected");
      await getMigratorPool().query(
        `update baa_acceptances set terminated_at = now() where organization_id = $1`,
        [clinic.organizationId],
      );
      expect(await sweepCalendarTerms([clinic.clinicId])).toEqual({
        checked: 1,
        disconnected: 1,
        failed: 0,
        failedClinicIds: [],
      });
      expect(await connectionRow(clinic.clinicId)).toMatchObject({
        status: "revoked",
        last_error: "terms_ended",
      });
      expect(await sweepCalendarTerms([clinic.clinicId])).toEqual({
        checked: 1,
        disconnected: 0,
        failed: 0,
        failedClinicIds: [],
      });
    },
    SLOW,
  );

  test(
    "the automatic calendar link goes when the terms allow writing, and not for a legacy agreement before its election is released, or for manual booking",
    async () => {
      const live = await seedClinic("gc-offer-live");
      await seedCalendarTerms(live);
      expect(await offerCalendarLink(live.clinicId, "provisioning")).toEqual({ status: "sent" });
      expect(sent.map((email) => email.to)).toEqual([live.staffEmail.toLowerCase()]);
      const link = (await resolveConnectionLink(tokensMailed()[0]!, {}, "calendar"))!;
      expect(link).toMatchObject({
        audience: "recipients",
        allowsAccountChange: false,
        pendingElection: null,
      });

      const legacy = await seedClinic("gc-offer-legacy");
      await getMigratorPool().query(
        `insert into baa_acceptances
           (id, organization_id, document_version, document_hash, rendered_text, variables,
            assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
         values ($1, $2, '1.2.1', $3, 'BUSINESS ASSOCIATE AGREEMENT (synthetic test)', '{"appliedClauses":["google-calendar"]}'::jsonb,
                 'I agree', 'Alex Chen', 'alex@radiance.test', now(), now())`,
        [randomUUID(), legacy.organizationId, "b".repeat(64)],
      );
      expect(await offerCalendarLink(legacy.clinicId, "provisioning")).toEqual({
        status: "skipped",
        reason: "nothing_to_do",
      });

      const manual = await seedClinic("gc-offer-manual");
      await seedCalendarTerms(manual, { bookingSystem: "mindbody" });
      expect(await offerCalendarLink(manual.clinicId, "provisioning")).toEqual({
        status: "skipped",
        reason: "nothing_to_do",
      });

      // Without healdesk's OAuth client, nothing is minted at all.
      const unset = await seedClinic("gc-offer-unset");
      await seedCalendarTerms(unset);
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      try {
        expect(await offerCalendarLink(unset.clinicId, "provisioning")).toEqual({
          status: "skipped",
          reason: "unavailable",
        });
      } finally {
        process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
      }
      expect(sent).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a spent link can ask for a new one, which goes only to the practice; an unknown token is answered the same and mails nothing",
    async () => {
      const clinic = await seedClinic("gc-reissue");
      await seedCalendarTerms(clinic);
      const token = await recipientsLink(clinic.clinicId);
      expect((await signIn(token, { sub: WORKSPACE.sub })).result.outcome).toBe("connected");
      expect((await calendarLinkPage(token)).state).toBe("expired");

      sent.length = 0;
      await reissueCalendarLink(token);
      expect(sent.map((email) => email.to)).toEqual([clinic.staffEmail.toLowerCase()]);
      const fresh = (await resolveConnectionLink(tokensMailed()[0]!, {}, "calendar"))!;
      expect(fresh.audience).toBe("recipients");

      sent.length = 0;
      await reissueCalendarLink("Q".repeat(43));
      await reissueCalendarLink("not a token");
      const setup = await issueConnectionLink(
        clinic.clinicId,
        { purpose: "setup" },
        { actor: ACTOR },
      );
      await reissueCalendarLink(setup.token);
      expect(sent).toEqual([]);
    },
    SLOW,
  );

  test(
    "elections through a link: a narrowing one is recorded and spends its link for a new one; a widening one records nothing until the owner confirms",
    async () => {
      const demo = await seedDemoClinic("gc-elect");
      const token = await recipientsLink(demo.clinicId);
      expect((await calendarLinkPage(token)).state).toBe("election");

      // Narrowing: to manual booking.
      sent.length = 0;
      const narrowed = await submitCalendarElection(token, {
        bookingSystem: "mindbody",
        calendarAccount: "workspace_no_baa",
        name: "Alex Chen",
        title: "Owner",
        accepted: true,
      });
      expect(narrowed.status).toBe("recorded");
      const next = /^\/calendar\/([A-Za-z0-9_-]{43})\?done=election_recorded$/.exec(
        narrowed.status === "recorded" ? narrowed.next : "",
      )?.[1];
      expect(next).toBeDefined();
      expect(await resolveConnectionLink(token, {}, "calendar")).toBeNull();
      expect(sent.map((email) => email.kind)).toEqual(["calendar_election_recorded"]);

      // Widening, on the continuation link: nothing recorded, the owner asked.
      sent.length = 0;
      const elections = async () =>
        inTenant(
          demo.clinicId,
          async (client) =>
            (
              await client.query<{ terms_kind: string; owner_confirmed: boolean }>(
                `select terms_kind, owner_confirmed from calendar_elections where clinic_id = $1 order by sequence`,
                [demo.clinicId],
              )
            ).rows,
        );
      const widening = {
        bookingSystem: "google_calendar",
        calendarAccount: "workspace_baa",
        name: "Sam Lee",
        title: "Front desk",
        accepted: true,
      };
      expect(await submitCalendarElection(next!, widening)).toEqual({ status: "owner_asked" });
      expect(await elections()).toEqual([{ terms_kind: "not_used", owner_confirmed: false }]);
      expect(sent.map((email) => [email.kind, email.to, email.subject])).toEqual([
        [
          "calendar_link",
          demo.staffEmail.toLowerCase(),
          "Please confirm a change to your calendar terms",
        ],
      ]);
      const confirm = tokensMailed()[0]!;
      const page = await calendarLinkPage(confirm);
      expect(page.state).toBe("confirm");
      expect(page.state === "confirm" ? page.document : null).toContain("CALENDAR ELECTION");

      const confirmed = await submitCalendarElection(confirm, {
        ...widening,
        name: "Alex Chen",
        title: "Owner",
      });
      expect(confirmed.status).toBe("recorded");
      expect(await elections()).toEqual([
        { terms_kind: "not_used", owner_confirmed: false },
        { terms_kind: "covered", owner_confirmed: true },
      ]);
      expect(await resolveConnectionLink(confirm, {}, "calendar")).toBeNull();
    },
    SLOW,
  );

  test(
    "the portal's start: only its own setup or settings page to return to, only for a member, and the callback goes back there",
    async () => {
      const clinic = await seedClinic("gc-portal");
      const stranger = await seedClinic("gc-portal-other");
      await seedCalendarTerms(clinic);
      const refused = async (input: Parameters<typeof startGoogleConnect>[0]) => {
        try {
          await startGoogleConnect(input);
        } catch (error) {
          return error instanceof GoogleConnectError ? error.code : String(error);
        }
        return "started";
      };
      const base = {
        clinicId: clinic.clinicId,
        disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
        userId: clinic.staffUserId,
      };
      expect(await refused({ ...base, returnTo: "https://evil.example/c/x/setup" })).toBe(
        "return_to",
      );
      expect(await refused({ ...base, returnTo: `/c/${clinic.slug}/billing` })).toBe("return_to");
      expect(await refused({ ...base, returnTo: `/c/${stranger.slug}/settings` })).toBe(
        "return_to",
      );
      expect(
        await refused({
          ...base,
          returnTo: `/c/${clinic.slug}/settings`,
          userId: stranger.staffUserId,
        }),
      ).toBe("not_member");

      const { authUrl, cookieValue } = await beginGoogleSignIn({
        clinicId: clinic.clinicId,
        via: { kind: "portal", userId: clinic.staffUserId, returnTo: "portal" },
        disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
        actor: { type: "user", userId: clinic.staffUserId, label: "clinic portal" },
      });
      expect(cookieValue).toMatch(/^[A-Za-z0-9_-]{43}\.$/);
      const answer = google.authorize(authUrl, { sub: WORKSPACE.sub }) as {
        code: string;
        state: string;
      };
      const result = await completeGoogleSignIn({ ...answer, error: null, cookie: cookieValue });
      expect(result).toEqual({
        outcome: "connected",
        redirectPath: `/c/${clinic.slug}/settings?calendar=connected`,
      });
      expect((await connectionRow(clinic.clinicId))!.metadata).toMatchObject({
        connectedVia: "portal",
      });
    },
    SLOW,
  );

  test(
    "a location whose terms need an election, or are manual, is not sent to Google",
    async () => {
      const demo = await seedDemoClinic("gc-noterms");
      const token = await recipientsLink(demo.clinicId);
      const link = (await resolveConnectionLink(token, {}, "calendar"))!;
      await expect(
        beginGoogleSignIn({
          clinicId: demo.clinicId,
          via: { kind: "calendar_link", linkId: link.linkId, token },
          disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
          actor: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "needs_election" });
      await expect(
        beginGoogleSignIn({
          clinicId: demo.clinicId,
          via: { kind: "calendar_link", linkId: link.linkId, token },
          disclosureVersion: "google-calendar-disclosure/0",
          actor: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "disclosure" });
      const states = await getMigratorPool().query(
        `select count(*)::int as n from google_oauth_states where target_clinic_id = $1`,
        [demo.clinicId],
      );
      expect(states.rows[0]!.n).toBe(0);

      // A location that is leaving connects nothing again, even from a live link.
      const leaving = await seedClinic("gc-leaving");
      await seedCalendarTerms(leaving);
      const live = await recipientsLink(leaving.clinicId);
      const liveLink = (await resolveConnectionLink(live, {}, "calendar"))!;
      await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) =>
        tx.db.execute(sql`select app_start_offboarding(${leaving.clinicId}::uuid)`),
      );
      await expect(
        beginGoogleSignIn({
          clinicId: leaving.clinicId,
          via: { kind: "calendar_link", linkId: liveLink.linkId, token: live },
          disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
          actor: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "terms" });
      expect(
        await issueCalendarLink(leaving.clinicId, { reason: "ops", rule: "useful" }),
      ).toMatchObject({
        status: "refused",
        reason: "offboarding",
      });
    },
    SLOW,
  );
});

describe("the calendar page's rules", () => {
  const actions = {
    submitElection: async () => {},
    requestChangeLink: async () => {},
    chooseCalendar: async () => {},
    reissue: async () => {},
  };
  const none: CalendarPageQuery = { outcome: null, notice: null, problem: null, elect: false };
  const disclosure = {
    ...GOOGLE_CALENDAR_DISCLOSURE,
    paragraphs: GOOGLE_CALENDAR_DISCLOSURE.paragraphs.map((p) =>
      p.replace("{clinicName}", "Radiance"),
    ),
  };
  const form = {
    bookingSystems: [
      { id: "google_calendar" as const, label: "Google Calendar only" },
      { id: "mindbody" as const, label: "Mindbody" },
    ],
    accounts: [
      { id: "workspace_baa" as const, title: "Workspace with Google's BAA", description: "d" },
      { id: "personal" as const, title: "A personal Google account", description: "d" },
    ],
  };
  const connect = (
    workspace: boolean,
    overrides: Partial<Extract<CalendarPageModel, { state: "connect" }>> = {},
  ): CalendarPageModel => ({
    state: "connect",
    clinicName: "Radiance",
    token: "T".repeat(43),
    disclosure,
    workspace,
    accessRemoved: false,
    accountChange: false,
    form,
    ...overrides,
  });
  const html = (model: CalendarPageModel, query: CalendarPageQuery = none) =>
    renderToStaticMarkup(CalendarLinkView({ model, query, actions }));

  test("Workspace terms show the Trusted-app guidance before the notice; personal terms do not", () => {
    const workspace = html(connect(true));
    expect(workspace).toContain("Manage third-party app access");
    expect(workspace.indexOf("Manage third-party app access")).toBeLessThan(
      workspace.indexOf(disclosure.heading),
    );
    expect(html(connect(false))).not.toContain("Manage third-party app access");
  });

  test("the notice sits directly above its unticked box and the button", () => {
    const page = html(connect(true));
    const tick = page.indexOf('name="disclosure"');
    const limitedUse = page.indexOf("use and transfer to any other app");
    expect(limitedUse).toBeGreaterThan(0);
    expect(tick).toBeGreaterThan(limitedUse);
    expect(page).not.toMatch(/name="disclosure"[^>]*checked/);
    expect(page.slice(tick, page.indexOf("</form>", tick))).toContain("Sign in with Google");
  });

  test("the mismatch page states the fact, offers the right account first and pre-selects nothing", () => {
    const page = html(connect(true), { ...none, outcome: "mismatch" });
    expect(page).toContain("You signed in with a personal Google account");
    expect(page).toContain("Sign in with the Workspace account");
    expect(page).toContain("Use this account instead");
    const elect = html(connect(true), { ...none, outcome: "mismatch", elect: true });
    expect(elect).toContain('name="bookingSystem"');
    expect(elect).toContain('name="calendarAccount"');
    expect(elect).not.toMatch(/checked/);
  });

  test("an expired link offers a new one and names no clinic", () => {
    const page = html({ state: "expired", token: "T".repeat(43) });
    expect(page).toContain("Email a new link to the practice");
    expect(page).not.toContain("Radiance");
  });

  test("on the owner's change link, an account that needs an election gets the election form, pre-selecting nothing", () => {
    const needed = { ...none, outcome: "election_needed" as const };
    const page = html(connect(true, { accountChange: true }), needed);
    expect(page).toContain("practice owner records a calendar election");
    expect(page).toContain('name="bookingSystem"');
    expect(page).toContain('name="calendarAccount"');
    expect(page).not.toMatch(/checked/);
    expect(page).toContain("Sign in with a different account instead");

    // Before the election document can be recorded, the page says so and still offers a sign-in.
    const later = html(connect(true, { accountChange: true, form: null }), needed);
    expect(later).not.toContain('name="bookingSystem"');
    expect(later).toContain("available yet");
    expect(later).toContain("Sign in with Google");
  });

  test("the day a calendar was connected is the clinic's own", () => {
    // 6 pm in Los Angeles on 8 October is already 9 October in UTC.
    expect(connectedOn("2026-10-09T01:00:00.000Z", "America/Los_Angeles")).toBe("October 8, 2026");
    expect(connectedOn("2026-10-09T01:00:00.000Z", "Asia/Dubai")).toBe("October 9, 2026");
    expect(connectedOn("not a date", "America/Los_Angeles")).toBeNull();
    expect(connectedOn("2026-10-09T01:00:00.000Z", "Not/AZone")).toBeNull();
    expect(connectedOn(undefined, "America/Los_Angeles")).toBeNull();
  });
});
