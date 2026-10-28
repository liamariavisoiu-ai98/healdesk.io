import { DIRECT_BOOKING_ADDENDUM_VERSION, GOOGLE_CALENDAR_DISCLOSURE, manualBookingNotice } from "@healdesk/catalog";
import { FAKE_GOOGLE_CLIENT } from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// Counsel's release of the Direct booking addendum, as the running build would
// carry it: false like the committed catalog unless a test releases it here.
// Never flipped anywhere but in this process (DB-1, lib/booking/direct-switch.ts).
const released = vi.hoisted(() => ({ addendum: false }));
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    currentDirectBookingAddendum: () => ({ ...actual.currentDirectBookingAddendum(), approvedByCounsel: released.addendum }),
  };
});

import { getClinicSettings, updateClinicSettings } from "@/lib/billing/settings";
import {
  BOOKING_MODE_REASON_CODES,
  bookingModeFor,
  decideBookingMode,
  effectiveBookingMode,
  effectiveOf,
  setAutoConfirm,
  type BookingModeFacts,
} from "@/lib/booking/mode";
import type { CalendarTerms, CalendarTermsInEffect } from "@/lib/booking/terms";
import { approveAgentConfig, seedAgentConfig } from "@/lib/onboarding/agent-config";
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
  seedDemoClinic,
  seedGoogleConnection,
} from "./setup/factories";

/**
 * The booking mode (plan §8): every gate, the order of the reasons the
 * portal's "Right now" line picks from, and the facts as the database holds
 * them, Auto-confirm included.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

const coveredTerms = (over: Partial<CalendarTermsInEffect> = {}): CalendarTermsInEffect => ({
  kind: "covered",
  account: "workspace_baa",
  sync: "live",
  bookingSystem: "google_calendar",
  clauseId: "google-calendar-covered",
  source: "agreement",
  electionId: "00000000-0000-4000-8000-000000000001",
  sequence: 1,
  electedAt: new Date("2026-10-06T10:00:00Z"),
  documentVersion: "1.3.0",
  documentReleased: true,
  ownerConfirmed: false,
  agreementId: "00000000-0000-4000-8000-000000000002",
  agreementVersion: "1.3.0",
  allowsWrite: true,
  demo: false,
  ...over,
});

const notUsedTerms = coveredTerms({
  kind: "not_used",
  bookingSystem: "mindbody",
  sync: "manual",
  clauseId: "google-calendar-not-used",
  allowsWrite: false,
});

const NO_AGREEMENT: CalendarTerms = {
  kind: "none",
  reason: "no_agreement",
  allowsWrite: false,
  demo: false,
};

const NEEDS_ELECTION: CalendarTerms = {
  kind: "needs_election",
  reason: "legacy_agreement",
  allowsWrite: false,
  agreementId: "00000000-0000-4000-8000-000000000002",
  agreementVersion: "1.2.1",
  electionId: null,
  demo: false,
};

/** Every gate met. */
const READY: BookingModeFacts = {
  killSwitchOn: true,
  autoConfirm: true,
  terms: coveredTerms(),
  googleConfigured: true,
  connection: {
    status: "active",
    managed: true,
    brokenAt: null,
    disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
  },
  openingHoursKnown: true,
  timezoneConfirmed: true,
  offboarding: false,
  production: true,
  demo: false,
  agentApproved: true,
};

const decide = (over: Partial<BookingModeFacts> = {}) => decideBookingMode({ ...READY, ...over });
const codesOf = (over: Partial<BookingModeFacts> = {}) => decide(over).reasons.map((r) => r.code);
const connected = (over: Partial<NonNullable<BookingModeFacts["connection"]>>) => ({
  connection: { ...READY.connection!, ...over },
});

describe("the booking mode's rules (decideBookingMode)", () => {
  test("every gate met: live, with real free times on offer and no reason", () => {
    expect(decide()).toEqual({ mode: "live", canOfferTimes: true, reasons: [] });
  });

  test.each([
    // Book or request: real free times stay on offer, and the time chosen becomes a request.
    ["the owner's kill switch off", { killSwitchOn: false }, "kill_switch_off", true],
    ["Auto-confirm off", { autoConfirm: false }, "auto_confirm_off", true],
    ["not live and not the demo clinic", { production: false }, "not_production", true],
    ["the script not approved", { agentApproved: false }, "agent_not_approved", true],
    // No real times at all.
    ["no agreement in effect", { terms: NO_AGREEMENT }, "no_agreement", false],
    ["no calendar terms yet", { terms: NEEDS_ELECTION }, "needs_election", false],
    [
      "a booking system that doesn't read Google",
      { terms: notUsedTerms },
      "manual_booking_system",
      false,
    ],
    [
      "healdesk's Google client not set",
      { googleConfigured: false },
      "google_not_configured",
      false,
    ],
    ["no connection", { connection: null }, "calendar_not_connected", false],
    [
      "a connection still pending",
      connected({ status: "pending" }),
      "calendar_not_connected",
      false,
    ],
    ["a revoked connection", connected({ status: "revoked" }), "calendar_not_connected", false],
    ["a connection in error", connected({ status: "error" }), "calendar_broken", false],
    ["an active row stamped broken", connected({ brokenAt: new Date() }), "calendar_broken", false],
    ["a degraded connection", connected({ status: "degraded" }), "calendar_degraded", false],
    [
      "a personal account under Workspace terms",
      connected({ managed: false }),
      "calendar_account_mismatch",
      false,
    ],
    [
      "an account of unknown kind",
      connected({ managed: null }),
      "calendar_account_mismatch",
      false,
    ],
    [
      "a Workspace account under personal terms",
      {
        terms: coveredTerms({
          kind: "uncovered",
          account: "personal",
          clauseId: "google-calendar-uncovered",
        }),
      },
      "calendar_account_mismatch",
      false,
    ],
    [
      "a notice no longer compatible",
      connected({ disclosureVersion: "google-calendar-disclosure/0" }),
      "calendar_disclosure_outdated",
      false,
    ],
    [
      "no notice recorded",
      connected({ disclosureVersion: null }),
      "calendar_disclosure_outdated",
      false,
    ],
    ["opening hours unknown", { openingHoursKnown: false }, "opening_hours_unknown", false],
    ["the time zone unconfirmed", { timezoneConfirmed: false }, "timezone_unconfirmed", false],
    ["the location leaving", { offboarding: true }, "offboarding", false],
  ] as const)("%s: manual, for that reason alone", (_label, over, code, canOfferTimes) => {
    const decision = decide(over as Partial<BookingModeFacts>);
    expect(decision.mode).toBe("manual");
    expect(decision.reasons.map((r) => r.code)).toEqual([code]);
    expect(decision.canOfferTimes).toBe(canOfferTimes);
  });

  test("uncovered terms with a personal account, and Workspace without Google's BAA, both match", () => {
    expect(
      codesOf({
        terms: coveredTerms({
          kind: "uncovered",
          account: "personal",
          clauseId: "google-calendar-uncovered",
        }),
        ...connected({ managed: false }),
      }),
    ).toEqual([]);
    expect(
      codesOf({
        terms: coveredTerms({
          kind: "uncovered",
          account: "workspace_no_baa",
          clauseId: "google-calendar-uncovered",
        }),
      }),
    ).toEqual([]);
  });

  test("the demo clinic counts as live for going live, and for nothing else", () => {
    expect(decide({ production: false, demo: true }).mode).toBe("live");
    expect(codesOf({ production: false, demo: true, agentApproved: false })).toEqual([
      "agent_not_approved",
    ]);
    expect(codesOf({ production: false, demo: true, killSwitchOn: false })).toEqual([
      "kill_switch_off",
    ]);
  });

  test("a connection is weighed only where the terms let healdesk write", () => {
    // No agreement and no connection: the agreement is the reason, not the calendar.
    expect(codesOf({ terms: NO_AGREEMENT, connection: null })).toEqual(["no_agreement"]);
    // A stray broken row of the wrong kind under manual terms says nothing more.
    expect(
      codesOf({
        terms: notUsedTerms,
        ...connected({ status: "error", managed: null, disclosureVersion: null }),
      }),
    ).toEqual(["manual_booking_system"]);
    expect(codesOf({ terms: NEEDS_ELECTION, connection: null })).toEqual(["needs_election"]);
  });

  test("every reason that applies is listed, in one fixed order, and the first is the portal's line", () => {
    const decision = decide({
      killSwitchOn: false,
      autoConfirm: false,
      googleConfigured: false,
      connection: { status: "error", managed: null, brokenAt: new Date(), disclosureVersion: null },
      openingHoursKnown: false,
      timezoneConfirmed: false,
      offboarding: true,
      production: false,
      agentApproved: false,
    });
    const codes = decision.reasons.map((r) => r.code);
    expect(codes).toEqual([
      "offboarding",
      "google_not_configured",
      "calendar_broken",
      "calendar_account_mismatch",
      "calendar_disclosure_outdated",
      "timezone_unconfirmed",
      "opening_hours_unknown",
      "auto_confirm_off",
      "not_production",
      "agent_not_approved",
      "kill_switch_off",
    ]);
    expect(codes).toEqual(BOOKING_MODE_REASON_CODES.filter((code) => codes.includes(code)));
    expect(decision).toMatchObject({ mode: "manual", canOfferTimes: false });

    expect(effectiveOf(decision)).toEqual({
      mode: "requests",
      reason: decision.reasons[0],
      reasons: decision.reasons,
    });
    expect(effectiveOf(decide())).toEqual({ mode: "direct", reason: null, reasons: [] });
  });

  test("a manual system's sentence is the catalogue's, naming the system; the rest are plain words", () => {
    const [manual] = decide({ terms: notUsedTerms }).reasons;
    expect(manual).toEqual({
      code: "manual_booking_system",
      sentence: manualBookingNotice("mindbody"),
    });
    expect(manual!.sentence).toContain("Mindbody");

    // Every other reason, at least once across these, with a sentence a clinic can read.
    const sentences = [
      ...decide({
        killSwitchOn: false,
        autoConfirm: false,
        googleConfigured: false,
        connection: { status: "degraded", managed: false, brokenAt: null, disclosureVersion: null },
        openingHoursKnown: false,
        timezoneConfirmed: false,
        offboarding: true,
        production: false,
        agentApproved: false,
      }).reasons,
      ...decide({ terms: NO_AGREEMENT }).reasons,
      ...decide({ terms: NEEDS_ELECTION }).reasons,
      ...decide({ connection: null }).reasons,
      ...decide(connected({ status: "error" })).reasons,
    ];
    expect(new Set(sentences.map((r) => r.code))).toEqual(
      new Set(BOOKING_MODE_REASON_CODES.filter((code) => code !== "manual_booking_system")),
    );
    for (const { code, sentence } of sentences) {
      expect(sentence.length, code).toBeGreaterThan(10);
      expect(sentence, code).not.toMatch(/HEALDESK_|GOOGLE_OAUTH|HIPAA|_/);
    }
  });

  test("there is no other booking mode: the direct-booking addendum's gate is gone (plan C17)", async () => {
    expect(await import("@/lib/booking/mode")).not.toHaveProperty("directBookingAllowed");
  });
});

describeDb("the booking mode, read from the database", () => {
  const SLOW = 60_000;
  const ENV_KEYS = [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "HEALDESK_DIRECT_BOOKING_ENABLED",
    "HEALDESK_DIRECT_BOOKING_ADDENDUM",
  ] as const;
  let saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
    delete process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM;
    released.addendum = false;
    process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  afterAll(async () => {
    await closePools();
  });

  const SERVICE = { type: "service", serviceName: "booking-mode-test" } as const;
  const modeOf = (clinicId: string) =>
    withTenant({ clinicId, actor: SERVICE }, (tx) => bookingModeFor(tx));

  /** A location ready in every way the database holds: terms, connection, hours, zone, script, live. */
  async function readyClinic(label: string) {
    const clinic = await seedClinic(label);
    await seedCalendarTerms(clinic);
    await seedGoogleConnection(clinic.clinicId);
    await withTenant({ clinicId: clinic.clinicId, actor: SERVICE }, async (tx) => {
      await seedAgentConfig(tx, "med-spa", `${label} Clinic`);
      await approveAgentConfig(tx, "Dr Chen");
    });
    await getMigratorPool().query(
      `update clinics
          set opening_hours = '{"sun":[],"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]],"sat":[]}'::jsonb,
              timezone_confirmed_at = now(), data_classification = 'production', baa_signed_at = now()
        where id = $1`,
      [clinic.clinicId],
    );
    return clinic;
  }

  /** Until a session waits on an advisory lock (lockAutoConfirm's), for ten seconds at most. */
  async function untilSomeoneWaitsOnAnAdvisoryLock(): Promise<void> {
    for (let tries = 0; tries < 400; tries += 1) {
      const { rows } = await getMigratorPool().query<{ n: number }>(
        `select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`,
      );
      if (rows[0]!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Nothing waited on the Auto-confirm lock.");
  }

  /** The database's own rule for the assistant's write and for a staff confirmation. */
  const databasePermits = (clinicId: string) =>
    inTenant(clinicId, async (c) => {
      const { rows } = await c.query<{ assistant: boolean; staff: boolean }>(
        `select app_calendar_write_permitted($1, true) as assistant,
                app_calendar_write_permitted($1, false) as staff`,
        [clinicId],
      );
      return rows[0]!;
    });

  test(
    "a new location has no settings row, so Auto-confirm reads on, and every gate it has not met is named",
    async () => {
      const { clinicId } = await seedClinic("mode-fresh");
      const mode = await modeOf(clinicId);
      expect(mode.reasons.map((r) => r.code)).toEqual([
        "no_agreement",
        "timezone_unconfirmed",
        "opening_hours_unknown",
        "not_production",
        "agent_not_approved",
        "kill_switch_off",
      ]);
      expect(mode).toMatchObject({
        mode: "manual",
        canOfferTimes: false,
        connection: null,
        demo: false,
      });
      expect(mode.terms.kind).toBe("none");
      const rows = await inTenant(
        clinicId,
        async (c) =>
          (await c.query(`select 1 from clinic_settings where clinic_id = $1`, [clinicId])).rows,
      );
      expect(rows).toEqual([]);
    },
    SLOW,
  );

  test(
    "a ready location books only with the owner's switch on, Auto-confirm off turns it to requests with times still offered, and a broken calendar takes the times away",
    async () => {
      const { clinicId, staffUserId, staffEmail } = await readyClinic("mode-ready");

      // Ready in every way but the owner's switch, which stays the last word.
      expect(await effectiveBookingMode(clinicId)).toEqual({
        mode: "requests",
        reason: { code: "kill_switch_off", sentence: expect.any(String) },
        reasons: [{ code: "kill_switch_off", sentence: expect.any(String) }],
      });
      expect((await modeOf(clinicId)).canOfferTimes).toBe(true);

      // DB-1: the owner's env var alone never makes it live, nor with the
      // version set while counsel's addendum is unreleased in this build.
      const killed = {
        mode: "requests",
        reason: { code: "kill_switch_off", sentence: expect.any(String) },
        reasons: [{ code: "kill_switch_off", sentence: expect.any(String) }],
      };
      process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
      expect(await effectiveBookingMode(clinicId)).toEqual(killed);
      expect((await modeOf(clinicId)).reasons.map((r) => r.code)).toEqual(["kill_switch_off"]);
      process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM = DIRECT_BOOKING_ADDENDUM_VERSION;
      expect(await effectiveBookingMode(clinicId)).toEqual(killed);
      // Released, but the deployed version names another addendum: still requests.
      released.addendum = true;
      process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM = "direct-booking-addendum/0.9.0";
      expect(await effectiveBookingMode(clinicId)).toEqual(killed);
      // All three: live.
      process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM = DIRECT_BOOKING_ADDENDUM_VERSION;
      expect(await effectiveBookingMode(clinicId)).toEqual({
        mode: "direct",
        reason: null,
        reasons: [],
      });
      // "Live" is never wider than the database's own rule.
      expect(await databasePermits(clinicId)).toEqual({ assistant: true, staff: true });

      // The clinic's own switch, as the portal flips it.
      const portalUser = { type: "user", userId: staffUserId, label: staffEmail } as const;
      const off = await setAutoConfirm(clinicId, false, portalUser);
      expect(off).toMatchObject({
        changed: true,
        autoConfirm: false,
        changedByLabel: staffEmail,
        mode: "requests",
        reason: { code: "auto_confirm_off" },
      });
      expect(off.reasons.map((r) => r.code)).toEqual(["auto_confirm_off"]);
      expect((await modeOf(clinicId)).canOfferTimes).toBe(true);
      // The database refuses the assistant's write, and still lets staff confirmations write.
      expect(await databasePermits(clinicId)).toEqual({ assistant: false, staff: true });

      const on = await setAutoConfirm(clinicId, true, portalUser);
      expect(on).toMatchObject({ changed: true, autoConfirm: true, mode: "direct", reason: null });

      // Google refused the calendar: the next read is manual, with no times to offer.
      await inTenant(clinicId, (c) =>
        c.query(
          `update provider_connections set status = 'error', broken_at = now(), last_error = 'access_denied'
            where clinic_id = $1 and provider = 'google_calendar'`,
          [clinicId],
        ),
      );
      const broken = await modeOf(clinicId);
      expect(broken.reasons.map((r) => r.code)).toEqual(["calendar_broken"]);
      expect(broken).toMatchObject({ mode: "manual", canOfferTimes: false });
      expect(await databasePermits(clinicId)).toEqual({ assistant: false, staff: false });
    },
    SLOW,
  );

  test(
    "setAutoConfirm stamps who switched it and when, audits a boolean, and re-saving changes nothing",
    async () => {
      const { clinicId } = await seedClinic("mode-switch");
      const at = new Date("2026-10-08T09:00:00Z");
      const first = await setAutoConfirm(clinicId, false, SERVICE, {
        label: "healdesk support",
        now: at,
      });
      expect(first).toMatchObject({
        changed: true,
        autoConfirm: false,
        changedByLabel: "healdesk support",
      });
      expect(first.changedAt?.getTime()).toBe(at.getTime());

      // The same value again: not changed, and the stamps stay where they were.
      const again = await setAutoConfirm(clinicId, false, SERVICE, {
        now: new Date("2026-10-08T10:00:00Z"),
      });
      expect(again).toMatchObject({
        changed: false,
        autoConfirm: false,
        changedByLabel: "healdesk support",
      });
      expect(again.changedAt?.getTime()).toBe(at.getTime());

      // Without a label, the stamp names the actor.
      const back = await setAutoConfirm(clinicId, true, SERVICE);
      expect(back).toMatchObject({
        changed: true,
        autoConfirm: true,
        changedByLabel: SERVICE.serviceName,
      });

      const audits = await inTenant(clinicId, async (c) => {
        const { rows } = await c.query<{ metadata: Record<string, unknown>; actor_label: string }>(
          `select metadata, actor_label from audit_log
            where clinic_id = $1 and resource_type = 'clinic_settings' order by occurred_at`,
          [clinicId],
        );
        return rows;
      });
      expect(audits).toEqual([
        {
          metadata: { fields: ["autoConfirm"], autoConfirm: false },
          actor_label: SERVICE.serviceName,
        },
        {
          metadata: { fields: ["autoConfirm"], autoConfirm: true },
          actor_label: SERVICE.serviceName,
        },
      ]);
    },
    SLOW,
  );

  test(
    "a switch made while another is in flight waits for it, so what it answers is what is stored",
    async () => {
      const { clinicId } = await seedClinic("mode-race");
      await setAutoConfirm(clinicId, false, SERVICE);

      // Another session switches it on, and has not committed yet.
      let commit!: () => void;
      const held = new Promise<void>((resolve) => (commit = resolve));
      let switched!: () => void;
      const inFlight = new Promise<void>((resolve) => (switched = resolve));
      const other = withTenant({ clinicId, actor: SERVICE }, async (tx) => {
        await updateClinicSettings(tx, { autoConfirmBookings: true }, "other session");
        switched();
        await held;
      });
      try {
        await inFlight;
        // The portal's "off" waits on the same lock rather than comparing
        // with the value the other session is replacing, which would answer
        // "off" and write nothing while on commits.
        const portal = setAutoConfirm(clinicId, false, SERVICE);
        await untilSomeoneWaitsOnAnAdvisoryLock();
        commit();
        await other;
        expect(await portal).toMatchObject({
          changed: true,
          autoConfirm: false,
          mode: "requests",
        });
        const stored = await withTenant({ clinicId, actor: SERVICE }, (tx) =>
          getClinicSettings(tx),
        );
        expect(stored.autoConfirmBookings).toBe(false);
      } finally {
        commit();
        await other.catch(() => {});
      }
    },
    SLOW,
  );

  test(
    "healdesk's demo clinic is exempt from going live, and from nothing else",
    async () => {
      const demo = await seedDemoClinic("mode-demo");
      const mode = await modeOf(demo.clinicId);
      expect(mode.demo).toBe(true);
      const codes = mode.reasons.map((r) => r.code);
      expect(codes).not.toContain("not_production");
      // Still synthetic, and still short of everything else it has not done.
      const { rows } = await getMigratorPool().query<{ data_classification: string }>(
        `select data_classification from clinics where id = $1`,
        [demo.clinicId],
      );
      expect(rows[0]!.data_classification).toBe("synthetic");
      expect(codes).toContain("kill_switch_off");
      expect(mode.mode).toBe("manual");
    },
    SLOW,
  );
});
