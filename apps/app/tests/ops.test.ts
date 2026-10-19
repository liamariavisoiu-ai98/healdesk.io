import { createHash, randomBytes } from "node:crypto";

import { CURRENT_BAA_VERSION, ONBOARDING_STEPS } from "@healdesk/catalog";
import { FAKE_GOOGLE_CLIENT, fakeGoogleCalendar, setGoogleFetch } from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { AwsKmsKeyWrapper, __setKeyWrapperForTests } from "@/lib/crypto/kms";
import {
  agreementCarriesVendorCalendarWrite,
  isIanaTimeZone,
  isMutating,
  isOpName,
  runOperation,
  type Operator,
} from "@/lib/ops/api";
import { blockersFor, listClinics, type ClinicOverview } from "@/lib/ops/clinics";

import { asApp, at, claimForWriting, futureBase, insertHold } from "./setup/calendar-db";
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
import { fakeKms, restoreKeyEnvironment, setKeyEnvironment, TEST_KEY_ARN } from "./setup/kms";

const describeDb = hasTestDatabase ? describe : describe.skip;

const clinic = (over: Partial<ClinicOverview> = {}): ClinicOverview => ({
  id: "c1",
  slug: "radiance",
  name: "Radiance",
  timezone: "America/New_York",
  specialty: "med-spa",
  plan: "core",
  attributionMode: "estimated",
  dataClassification: "synthetic",
  isCoveredEntity: true,
  baaSignedAt: new Date(),
  createdAt: new Date(),
  phoneSystemType: "landline",
  callRoutingConfirmedAt: new Date(),
  carrier: "verizon",
  assistantNumberE164: "+14155550100",
  openingHoursPresent: true,
  onboarding: Object.fromEntries(ONBOARDING_STEPS.map((step) => [step, "2026-09-13T00:00:00.000Z"])),
  agentApprovedAt: new Date(),
  wentLiveAt: null,
  offboardingStartedAt: null,
  exportDeliveredAt: null,
  destroyAfter: null,
  destroyedAt: null,
  publishedPhoneE164: null,
  forwardingTestUntil: null,
  forwardingTestObserved: null,
  stripeConnectAccountId: null,
  stripeConnectConnectedAt: null,
  metaFrontDoorEnabled: false,
  bookingMode: "desk_confirms",
  directBookingElectedAt: null,
  directBookingWithdrawnAt: null,
  timezoneConfirmedAt: null,
  bookingRequirements: null,
  bookingRequirementsConfirmedAt: null,
  bookingRequirementsSource: null,
  baaVersion: CURRENT_BAA_VERSION,
  destructionAgreementVersion: null,
  billingClinicId: null,
  stripeConnectDisconnectedAt: null,
  regulatoryRegime: "hipaa-if-covered",
  agreementKind: "baa",
  ...over,
});

describe("clinic blockers", () => {
  test("flags production with no signed BAA as blocked", () => {
    // The database is already refusing patient data in this state. The console
    // should say so rather than let it surface as a failed insert.
    const blockers = blockersFor(
      clinic({ dataClassification: "production", baaSignedAt: null }),
    );

    expect(blockers[0]!.level).toBe("blocked");
    expect(blockers[0]!.message).toMatch(/refusing all patient data/i);
  });

  test("flags undetermined covered-entity status", () => {
    // Cash-pay med spas often are not covered entities, which removes the
    // exemptions in MHMDA, TDPSA, SB 370 and the FTC breach rule at once. It
    // has to be determined, not assumed.
    const blockers = blockersFor(clinic({ isCoveredEntity: null }));
    expect(blockers.some((b) => b.message.match(/covered-entity/i))).toBe(true);
  });

  test("notes a synthetic clinic without treating it as broken", () => {
    const blockers = blockersFor(clinic({ dataClassification: "synthetic" }));
    expect(blockers.every((b) => b.level === "attention")).toBe(true);
  });

  test("a fully configured production clinic has nothing outstanding", () => {
    const blockers = blockersFor(
      clinic({
        dataClassification: "production",
        baaSignedAt: new Date(),
        isCoveredEntity: true,
      }),
    );
    expect(blockers).toEqual([]);
  });

  test("a superseded agreement is the first thing a synthetic clinic's card says, naming both versions", () => {
    // The card shows the first blocker when none is "blocked", and go-live
    // refuses this one outright (0048), so it goes ahead of the covered-entity
    // line and the onboarding steps.
    const blockers = blockersFor(clinic({ baaVersion: "1.0.0", isCoveredEntity: null, agentApprovedAt: null }));
    const superseded = blockers.filter((b) => b.message.includes("superseded"));
    expect(superseded).toEqual([
      {
        level: "attention",
        message: `BAA v1.0.0 has been superseded: the practice accepts v${CURRENT_BAA_VERSION} before go-live.`,
      },
    ]);
    expect(blockers[0]).toEqual(superseded[0]);
  });

  test("a live clinic on a superseded agreement is told to re-accept, not shown as broken", () => {
    const blockers = blockersFor(
      clinic({ dataClassification: "production", baaSignedAt: new Date(), baaVersion: "1.2.0" }),
    );
    expect(blockers).toEqual([
      {
        level: "attention",
        message: `Live under BAA v1.2.0, which has been superseded: have the practice accept v${CURRENT_BAA_VERSION}.`,
      },
    ]);
  });

  test("go-live is automatic: a synthetic clinic's card says so, not the voice-era checklist (WP2)", () => {
    const blockers = blockersFor(
      clinic({ callRoutingConfirmedAt: null, agentApprovedAt: null, openingHoursPresent: false, onboarding: {} }),
    );
    expect(blockers.map((b) => b.message)).toEqual([
      "Synthetic only — not yet accepting real patient data. It goes live by itself once everything go-live asks holds; its onboarding page lists what is left.",
    ]);
  });

  test("an agreement that doesn't cover the practice is said before go-live, and blocks a live clinic's data (0051, 0088)", () => {
    // A DPA practice that now bills insurance: the PHI gate refuses its data.
    const live = blockersFor(
      clinic({ dataClassification: "production", baaVersion: "dpa/1.0.0", agreementKind: "dpa", isCoveredEntity: true }),
    );
    expect(live.find((b) => b.level === "blocked")?.message).toMatch(/no longer covers the practice/);
    const synthetic = blockersFor(
      clinic({ baaVersion: "dpa/1.0.0", agreementKind: "dpa", isCoveredEntity: true }),
    );
    expect(synthetic.map((b) => b.message)).toEqual(
      expect.arrayContaining([
        "The data protection agreement dpa/1.0.0 is not released: the practice can't go live under it until it is.",
        "Its agreement does not cover the practice: it signs a business associate agreement before go-live.",
      ]),
    );
    // A clinic from before 0051, with no regime recorded, is not judged on it.
    expect(
      blockersFor(clinic({ dataClassification: "production", regulatoryRegime: null, agreementKind: null })),
    ).toEqual([]);
  });

  test("the current version, or no agreement at all, adds nothing about the version", () => {
    // No agreement at all is go-live's to report ("No signed business
    // associate agreement is in effect…"); this item is only about a version
    // that has been replaced.
    for (const baaVersion of [CURRENT_BAA_VERSION, null]) {
      expect(blockersFor(clinic({ baaVersion })).some((b) => b.message.includes("superseded"))).toBe(false);
    }
  });
});

describeDb("ops clinic listing", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("lists clinics the runtime role cannot select directly", async () => {
    const seeded = await seedClinic("ops-list");

    const clinics = await listClinics();
    expect(clinics.map((c) => c.id)).toContain(seeded.clinicId);

    // Proves the SECURITY DEFINER function is doing real work — a plain SELECT
    // as the app role with no tenant set returns nothing.
    const { Pool } = await import("pg");
    const app = new Pool({ connectionString: process.env.TEST_APP_URL });
    try {
      const direct = await app.query(`select id from clinics`);
      expect(direct.rows).toHaveLength(0);
    } finally {
      await app.end();
    }
  });

  test("returns configuration only, never patient data", async () => {
    await seedClinic("ops-shape");
    const [first] = await listClinics();

    // This projection is the entire privileged surface. If a patient-adjacent
    // column ever appears here, it bypasses RLS for every caller.
    expect(Object.keys(first!).sort()).toEqual(
      [
        "agentApprovedAt",
        "agreementKind",
        "assistantNumberE164",
        "attributionMode",
        "baaSignedAt",
        "baaVersion",
        "billingClinicId",
        "bookingMode",
        "bookingRequirements",
        "bookingRequirementsConfirmedAt",
        "bookingRequirementsSource",
        "directBookingElectedAt",
        "directBookingWithdrawnAt",
        "timezoneConfirmedAt",
        "callRoutingConfirmedAt",
        "carrier",
        "createdAt",
        "dataClassification",
        "destroyAfter",
        "destroyedAt",
        "destructionAgreementVersion",
        "exportDeliveredAt",
        "forwardingTestObserved",
        "forwardingTestUntil",
        "id",
        "isCoveredEntity",
        "metaFrontDoorEnabled",
        "name",
        "offboardingStartedAt",
        "onboarding",
        "openingHoursPresent",
        "phoneSystemType",
        "plan",
        "publishedPhoneE164",
        "regulatoryRegime",
        "slug",
        "specialty",
        "stripeConnectAccountId",
        "stripeConnectConnectedAt",
        "stripeConnectDisconnectedAt",
        "timezone",
        "wentLiveAt",
      ].sort(),
    );
  });

  test("reflects BAA and covered-entity state from the database", async () => {
    const seeded = await seedClinic("ops-state");
    await getMigratorPool().query(
      `update clinics
          set is_covered_entity = true, baa_signed_at = now(),
              data_classification = 'production'
        where id = $1`,
      [seeded.clinicId],
    );

    const found = (await listClinics()).find((c) => c.id === seeded.clinicId);
    expect(found?.isCoveredEntity).toBe(true);
    expect(found?.baaSignedAt).toBeInstanceOf(Date);
    expect(found?.dataClassification).toBe("production");
    expect(blockersFor(found!)).toEqual([]);
  });

  test("projects the agreement gate's two columns, as provisioning and a supersede leave them (0088)", async () => {
    const { clinicId } = await seedClinic("ops-gate-cols");
    const read = async () => {
      const found = (await listClinics()).find((c) => c.id === clinicId)!;
      return { regime: found.regulatoryRegime, kind: found.agreementKind };
    };
    expect(await read()).toEqual({ regime: null, kind: null });
    await getMigratorPool().query(
      `update clinics set regulatory_regime = 'hipaa-if-covered', agreement_kind = 'baa' where id = $1`,
      [clinicId],
    );
    expect(await read()).toEqual({ regime: "hipaa-if-covered", kind: "baa" });
  });

  test("reports the version of the agreement in effect: the newest bound, unterminated one (0048)", async () => {
    const { clinicId, organizationId } = await seedClinic("ops-version");
    const version = async () => (await listClinics()).find((c) => c.id === clinicId)!.baaVersion;
    expect(await version()).toBeNull();

    // Two bound rows for one organisation is a state only the migrator can
    // produce today; it is the one a re-acceptance will leave behind.
    const bind = (v: string, acceptedAgo: string) =>
      getMigratorPool().query(
        `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
         values ($1, $2, repeat('e', 64), 'BAA', '{}'::jsonb, 'I agree', 'Alex', 'alex@version.test', now() - $3::interval, now() - $3::interval)`,
        [organizationId, v, acceptedAgo],
      );
    await bind("1.0.0", "40 days");
    expect(await version()).toBe("1.0.0");
    await bind(CURRENT_BAA_VERSION, "1 day");
    expect(await version()).toBe(CURRENT_BAA_VERSION);

    await getMigratorPool().query(
      `update baa_acceptances set terminated_at = now() where organization_id = $1 and document_version = $2`,
      [organizationId, CURRENT_BAA_VERSION],
    );
    expect(await version()).toBe("1.0.0");
  });
});

const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };

async function run(op: Parameters<typeof runOperation>[0], args: Record<string, unknown>) {
  const outcome = await runOperation(op, args, OPERATOR);
  expect(outcome.status, JSON.stringify(outcome)).toBe(200);
  return (outcome.body as { data: Record<string, unknown> }).data;
}

describe("IANA time zones", () => {
  test("accepts real zones and refuses abbreviations and offsets", () => {
    expect(isIanaTimeZone("America/New_York")).toBe(true);
    expect(isIanaTimeZone("Europe/London")).toBe(true);
    expect(isIanaTimeZone("UTC")).toBe(true);
    expect(isIanaTimeZone("EST")).toBe(false);
    expect(isIanaTimeZone("UTC+5")).toBe(false);
    expect(isIanaTimeZone("America/Nowhere")).toBe(false);
    expect(isIanaTimeZone("")).toBe(false);
  });
});

describe("inbound only: the call-back and template operations are gone", () => {
  test("neither the call-back switch nor the WhatsApp template op is an operation any more", () => {
    expect(isOpName("setOutboundCallbacks")).toBe(false);
    expect(isOpName("setWhatsAppTemplate")).toBe(false);
  });
});

describe("the operator's sign-in is not an operation (14 October 2026)", () => {
  test("none of the five ops that answered apps/web before a session exists any more", () => {
    // The second factor moved onto Vercel (apps/web/src/lib/admin/totp.ts) so
    // /admin can be signed into while this host is off; drizzle/0074 dropped
    // its table. An op that answers without a session is one nobody should be
    // able to add back by accident.
    for (const op of [
      "getAdminTotpState",
      "enrolAdminTotp",
      "verifyAdminTotpStep",
      "burnRecoveryCode",
      "sendSignInAlert",
    ]) {
      expect(isOpName(op), op).toBe(false);
    }
  });
});

describe("ops: the credential key (getCredentialKeyStatus)", () => {
  afterEach(() => {
    restoreKeyEnvironment();
    vi.restoreAllMocks();
  });

  const KMS_CONFIGURED = {
    HEALDESK_KMS_PROVIDER: "aws-kms",
    HEALDESK_KMS_KEY_ID: TEST_KEY_ARN,
    AWS_REGION: undefined,
  } as const;

  test("is a read: on the list, off the mutating half, so it writes no audit row", () => {
    expect(isOpName("getCredentialKeyStatus")).toBe(true);
    expect(isMutating("getCredentialKeyStatus")).toBe(false);
    // The calendar's two: each mints, mails or revokes something, so each is audited.
    for (const op of ["issueCalendarLink", "disconnectCalendar"]) {
      expect(isOpName(op), op).toBe(true);
      expect(isMutating(op as Parameters<typeof isMutating>[0]), op).toBe(true);
    }
  });

  test("on the local wrapper: configured, no key to name, and a live check that passes", async () => {
    const status = await run("getCredentialKeyStatus", {});
    expect(status).toEqual({
      provider: "local",
      keyConfigured: true,
      keyArnSuffix: null,
      selfCheck: { ok: true, at: expect.any(String) },
    });
    const at = (status.selfCheck as { at: string }).at;
    expect(new Date(at).toISOString()).toBe(at);
  });

  test("on KMS: the key's last six characters, and a check that went through KMS itself", async () => {
    setKeyEnvironment(KMS_CONFIGURED);
    const kms = fakeKms();
    __setKeyWrapperForTests(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }));

    const status = await run("getCredentialKeyStatus", {});
    expect(status).toEqual({
      provider: "aws-kms",
      keyConfigured: true,
      keyArnSuffix: "7890ab",
      selfCheck: { ok: true, at: expect.any(String) },
    });
    expect(kms.calls.map((call) => [call.command, call.keyId])).toEqual([
      ["GenerateDataKey", TEST_KEY_ARN],
      ["Decrypt", TEST_KEY_ARN],
    ]);
    // Never the full ARN, which names the AWS account.
    expect(JSON.stringify(status)).not.toContain("111122223333");
  });

  test("a key id that is not a key ARN: answered rather than failed, with no suffix and the check's word", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setKeyEnvironment({ ...KMS_CONFIGURED, HEALDESK_KMS_KEY_ID: "alias/healdesk-credentials" });

    const status = await run("getCredentialKeyStatus", {});
    expect(status).toEqual({
      provider: "aws-kms",
      keyConfigured: false,
      keyArnSuffix: null,
      selfCheck: { ok: false, at: expect.any(String), error: "unconfigured" },
    });
  });

  test("a refusal from KMS crosses as a word, never as AWS's message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setKeyEnvironment(KMS_CONFIGURED);
    __setKeyWrapperForTests(
      new AwsKmsKeyWrapper(TEST_KEY_ARN, {
        client: fakeKms(TEST_KEY_ARN, { fail: "AccessDeniedException" }).client,
      }),
    );

    const status = await run("getCredentialKeyStatus", {});
    expect(status).toMatchObject({
      provider: "aws-kms",
      keyConfigured: true,
      selfCheck: { ok: false, error: "denied" },
    });
    expect(JSON.stringify(status)).not.toContain("stand-in");
  });
});

describeDb("ops: booking hand-off and direct booking", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
    delete process.env.HEALDESK_PHASE_TWO_ATTRIBUTION;
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("the OnboardingView's forwarding codes follow the coverage mode, not clinics.call_routing", async () => {
    const { clinicId } = await seedClinic("ops-coverage");
    // call_routing still says 'conditional', as it does for After hours only;
    // read from it, the console printed the busy and no-answer pair (*91, *93)
    // for a line forwarded in full at closing.
    await getMigratorPool().query(
      `update clinics set phone_system_type = 'landline', carrier = 'verizon',
              call_routing = 'conditional', assistant_number_e164 = '+14155550100'
        where id = $1`,
      [clinicId],
    );
    await inTenant(clinicId, (c) =>
      c.query(
        `insert into clinic_settings (clinic_id, coverage_mode) values ($1, 'after_hours_only')
         on conflict (clinic_id) do update set coverage_mode = 'after_hours_only'`,
        [clinicId],
      ),
    );
    const view = await run("getOnboarding", { clinicId });
    const clinic = view.clinic as { coverageMode: string; callRouting: string };
    expect(clinic.coverageMode).toBe("after_hours_only");
    expect(clinic.callRouting).toBe("conditional");
    const forwarding = view.forwarding as { steps: { dial: string }[]; undo: { dial: string }[] };
    expect(forwarding.steps.map((s) => s.dial)).toEqual(["*724155550100", "*73"]);
    expect(forwarding.undo.map((s) => s.dial)).toEqual(["*73"]);

    // All calls reads as 'always' for the console's phone form, whatever call_routing says.
    await inTenant(clinicId, (c) =>
      c.query(`update clinic_settings set coverage_mode = 'all_calls' where clinic_id = $1`, [
        clinicId,
      ]),
    );
    expect(((await run("getOnboarding", { clinicId })).clinic as { callRouting: string }).callRouting).toBe(
      "always",
    );
  });

  test("listCalendarWrites and the OnboardingView carry no firstName or phone key", async () => {
    const { clinicId } = await seedClinic("ops-view");
    const view = await run("getOnboarding", { clinicId });
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/"firstName":/);
    expect(json).not.toMatch(/"phone":/);
    expect(json).not.toMatch(/"fullName":/);
    // The new fields are present with their resting values.
    expect(view.timezoneConfirmedAt).toBeNull();
    expect(view.booking).toMatchObject({ mode: "manual", canOfferTimes: false, calendar: null });
    // The call-back switch, its queue count and the WhatsApp template are gone;
    // so are the direct-booking addendum's switch and gates and the vendor
    // connection's PHI basis (plan C17): the booking mode is derived, and
    // `booking` is the console's only account of it.
    for (const key of [
      "outboundCallbacksEnabled",
      "pendingCallbacks",
      "whatsappTemplateName",
      "whatsappTemplatesFlag",
      "bookingMode",
      "directBookingElectedAt",
      "directBookingWithdrawnAt",
      "directBooking",
      "calendarConnection",
    ]) {
      expect(view, key).not.toHaveProperty(key);
    }
    expect(view.calendarWrites).toEqual([]);
    const requirements = view.requirements as { fields: string[]; source: string | null; catalogue: unknown[]; neverAsked: string[] };
    expect(requirements.fields.slice(0, 4)).toEqual(["first_name", "phone", "preferred_window", "alternative_windows"]);
    expect(requirements.source).toBeNull();
    expect(requirements.neverAsked.length).toBeGreaterThan(0);

    const writes = await run("listCalendarWrites", { clinicId });
    expect(JSON.stringify(writes)).not.toMatch(/"(firstName|phone|fullName)":/);
    expect(writes.writes).toEqual([]);
  });

  test("setClinicTimezone refuses what is not an IANA zone and stamps the confirmation", async () => {
    const { clinicId } = await seedClinic("ops-timezone");
    expect((await run("setClinicTimezone", { clinicId, timezone: "EST" })).status).toBe("error");
    const tz = await run("setClinicTimezone", { clinicId, timezone: "America/Chicago" });
    expect(tz).toMatchObject({ status: "updated", timezone: "America/Chicago" });
    const overview = (await listClinics()).find((c) => c.id === clinicId)!;
    expect(overview.timezone).toBe("America/Chicago");
    expect(overview.timezoneConfirmedAt).not.toBeNull();
  });

  test("issueConnectLink is phase two: refused in v1, and with the fence lifted a read-only guide issues", async () => {
    const { clinicId: acuityId } = await seedClinic("ops-acuity");
    await getMigratorPool().query(`update clinics set booking_provider = 'acuity' where id = $1`, [acuityId]);

    delete process.env.HEALDESK_PHASE_TWO_ATTRIBUTION;
    const refused = await run("issueConnectLink", { clinicId: acuityId });
    expect(refused.status).toBe("error");
    expect(String(refused.message)).toMatch(/phase two/i);
    const none = await inTenant(acuityId, async (client) => (await client.query(`select id from connection_links where clinic_id = $1`, [acuityId])).rows);
    expect(none).toEqual([]);

    process.env.HEALDESK_PHASE_TWO_ATTRIBUTION = "true";
    try {
      const issued = await run("issueConnectLink", { clinicId: acuityId });
      expect(issued.status).toBe("issued");
      expect(String(issued.url)).toMatch(/\/connect\/[A-Za-z0-9_-]{43}$/);
    } finally {
      delete process.env.HEALDESK_PHASE_TWO_ATTRIBUTION;
    }
  });

  test("agreementCarriesVendorCalendarWrite reads the bound, in-effect agreement's own clauses", async () => {
    const { organizationId } = await seedClinic("ops-calendar-clause");
    expect(await agreementCarriesVendorCalendarWrite(organizationId)).toBe(false);

    // A bound 1.0.0 agreement: no calendar-write clause was in that document.
    await getMigratorPool().query(
      `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
       values ($1, '1.0.0', repeat('a', 64), 'BAA', '{"appliedClauses":["parties","safeguards"],"calendarWrite":null}'::jsonb, 'I agree', 'Alex', 'alex@clause.test', now() - interval '2 days', now() - interval '2 days')`,
      [organizationId],
    );
    expect(await agreementCarriesVendorCalendarWrite(organizationId)).toBe(false);

    // A later bound agreement whose rendered document carried the clause.
    await getMigratorPool().query(
      `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
       values ($1, '1.1.0-draft', repeat('b', 64), 'BAA', '{"appliedClauses":["parties","calendar-write"],"calendarWrite":{"platform":"Cal.com"}}'::jsonb, 'I agree', 'Alex', 'alex@clause.test', now(), now())`,
      [organizationId],
    );
    expect(await agreementCarriesVendorCalendarWrite(organizationId)).toBe(true);

    // Terminated: counts for nothing again.
    await getMigratorPool().query(`update baa_acceptances set terminated_at = now() where organization_id = $1 and document_version = '1.1.0-draft'`, [organizationId]);
    expect(await agreementCarriesVendorCalendarWrite(organizationId)).toBe(false);
  });

  test("the Google Calendar clauses and a data protection agreement never carry the vendor write", async () => {
    // Each its own organisation, so each acceptance is the agreement in effect.
    let n = 0;
    const signed = async (version: string, variables: Record<string, unknown>) => {
      const { organizationId } = await seedClinic(`ops-vendor-write-${(n += 1)}`);
      await getMigratorPool().query(
        `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
         values ($1, $2, repeat('c', 64), 'AGREEMENT', $3::jsonb, 'I agree', 'Alex', 'alex@vendor-write.test', now(), now())`,
        [organizationId, version, JSON.stringify(variables)],
      );
      return agreementCarriesVendorCalendarWrite(organizationId);
    };
    // 1.2.x's unconditional Google clause.
    expect(
      await signed("1.2.1", {
        appliedClauses: ["parties", "google-calendar"],
        calendarWrite: null,
      }),
    ).toBe(false);
    // 1.3.0's three calendar clauses.
    for (const clause of [
      "google-calendar-covered",
      "google-calendar-uncovered",
      "google-calendar-not-used",
    ]) {
      expect(
        await signed("1.3.0", { appliedClauses: ["parties", clause], calendarWrite: null }),
        clause,
      ).toBe(false);
    }
    // A recorded clause list without the vendor clause is the answer, whatever else the row says.
    expect(
      await signed("1.1.0-draft", {
        appliedClauses: ["parties"],
        calendarWrite: { platform: "Cal.com" },
      }),
    ).toBe(false);
    // Only a BAA counts: a DPA is never read for the vendor write.
    expect(await signed("dpa/1.0.0", { appliedClauses: ["parties", "calendar-write"] })).toBe(
      false,
    );
    // A row from before the clause list was recorded falls back to the 1.1.0 draft's selection.
    expect(await signed("1.1.0-draft", { calendarWrite: { platform: "Cal.com" } })).toBe(true);
  });

  test("setBookingMode is gone, and the addendum's election on the row changes nothing the console shows", async () => {
    // The console switches Auto-confirm (setAutoConfirm); nothing sets a mode.
    expect(isOpName("setBookingMode")).toBe(false);
    const { clinicId } = await seedClinic("ops-mode");
    const before = (await run("getOnboarding", { clinicId })).booking as { mode: string; reasons: { code: string }[] };
    expect(before.mode).toBe("manual");
    // A row the old switch could have left: elected and `direct`. The mode is
    // derived from the terms, the calendar, Auto-confirm and the kill switch,
    // and never reads the addendum's columns, so the console's whole account
    // of booking is what it was before them, reasons and all.
    await getMigratorPool().query(
      `update clinics set direct_booking_elected_at = now(), direct_booking_elected_by_label = 'Dr Chen', direct_booking_clause_version = 'direct-booking-addendum/1.0.0', direct_booking_clause_hash = decode(repeat('c', 64), 'hex'), booking_mode = 'direct' where id = $1`,
      [clinicId],
    );
    expect((await run("getOnboarding", { clinicId })).booking).toEqual(before);
  });

  test("setBookingRequirements keeps the locked four, refuses unknown ids, and records the operator", async () => {
    const { clinicId } = await seedClinic("ops-requirements");
    const bad = await run("setBookingRequirements", { clinicId, fields: ["last_name", "date_of_birth"] });
    expect(bad.status).toBe("error");
    const good = await run("setBookingRequirements", { clinicId, fields: ["preferred_provider"] });
    expect(good).toMatchObject({ status: "updated", fields: ["first_name", "phone", "preferred_window", "alternative_windows", "preferred_provider"] });
    const overview = (await listClinics()).find((c) => c.id === clinicId)!;
    expect(overview.bookingRequirementsSource).toBe("operator");
    expect(overview.onboarding.booking_requirements_confirmed).not.toBeNull();
  });

  test("issueSetupLink is retired with the setup wizard, and setConnectionPhiBasis refuses an unknown connection", async () => {
    const { clinicId } = await seedClinic("ops-setup-link");
    // The wizard asks what the setup page asked (plan C2): the op is gone,
    // so the console cannot mint a link to a page that no longer exists.
    const retired = await runOperation("issueSetupLink" as Parameters<typeof runOperation>[0], { clinicId }, OPERATOR);
    expect(retired.status).toBe(400);
    const purposes = await inTenant(clinicId, async (client) => (await client.query<{ purpose: string }>(`select purpose from connection_links where clinic_id = $1`, [clinicId])).rows.map((r) => r.purpose));
    expect(purposes).toEqual([]);

    const missing = await run("setConnectionPhiBasis", { clinicId, connectionId: "00000000-0000-4000-8000-000000000000", basis: "vendor_baa" });
    expect(missing.status).toBe("error");
  });
});

describeDb("ops: the Google Calendar connection and the demo clinic", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  const SLOW = 60_000;

  test(
    "setConnectionPhiBasis refuses a Google Calendar connection, whose basis is the location's calendar terms",
    async () => {
      const { clinicId } = await seedClinic("ops-google-basis");
      const { connectionId } = await seedGoogleConnection(clinicId);
      const refused = await run("setConnectionPhiBasis", {
        clinicId,
        connectionId,
        basis: "practice_account",
      });
      expect(refused).toMatchObject({
        status: "error",
        message: expect.stringMatching(/calendar terms/),
      });
      const row = await inTenant(
        clinicId,
        async (client) =>
          (
            await client.query<{ phi_basis: string | null }>(
              `select phi_basis from provider_connections where id = $1`,
              [connectionId],
            )
          ).rows[0]!,
      );
      expect(row.phi_basis).toBeNull();
      const events = await getMigratorPool().query(
        `select count(*)::int as n from security_events where event = 'connection_phi_basis_set' and metadata ->> 'provider' = 'google_calendar'`,
      );
      expect(events.rows[0].n).toBe(0);
    },
    SLOW,
  );

  test(
    "a Google Calendar connection is never the legacy write path's, nor offered a basis, even with one forced onto the row",
    async () => {
      const { clinicId } = await seedClinic("ops-google-writable");
      const { connectionId } = await seedGoogleConnection(clinicId);
      // Only the migrator could do this; the legacy path must still not take it.
      await inTenant(clinicId, (client) =>
        client.query(
          `update provider_connections set phi_basis = 'practice_account' where id = $1`,
          [connectionId],
        ),
      );
      // Nothing offers it a basis: the console shows it as `booking.calendar`,
      // and the mode is derived without one.
      const view = await run("getOnboarding", { clinicId });
      expect(view).not.toHaveProperty("calendarConnection");
      expect(view.booking).toMatchObject({ mode: "manual", calendar: { connectionId } });
      const { writableConnection } = await import("@/lib/booking/calendar");
      const { withTenant } = await import("@/lib/tenant");
      expect(
        await withTenant({ clinicId, actor: { type: "service", serviceName: "test" } }, (tx) =>
          writableConnection(tx),
        ),
      ).toBeNull();
    },
    SLOW,
  );

  test(
    "issueCalendarLink mails the practice's own address, takes none, and shows a link only for the demo clinic",
    async () => {
      const saved = {
        id: process.env.GOOGLE_OAUTH_CLIENT_ID,
        secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      };
      process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
      process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
      try {
        const clinic = await seedClinic("ops-calendar-link");
        await seedCalendarTerms(clinic);
        const issued = await run("issueCalendarLink", { clinicId: clinic.clinicId });
        expect(issued).toMatchObject({ status: "issued", delivery: { recipients: 1, failed: 0 } });
        expect(issued).not.toHaveProperty("url");
        expect(JSON.stringify(issued)).not.toMatch(/\/calendar\//);
        const links = await inTenant(
          clinic.clinicId,
          async (client) =>
            (
              await client.query<{ sent_to: string[]; audience: string }>(
                `select sent_to, audience from connection_links where clinic_id = $1 and purpose = 'calendar'`,
                [clinic.clinicId],
              )
            ).rows,
        );
        expect(links).toEqual([
          { sent_to: [clinic.staffEmail.toLowerCase()], audience: "recipients" },
        ]);

        expect(
          await run("issueCalendarLink", {
            clinicId: clinic.clinicId,
            to: "someone@elsewhere.test",
          }),
        ).toMatchObject({
          status: "error",
          message: expect.stringMatching(/own address/),
        });
        expect(
          await run("issueCalendarLink", { clinicId: clinic.clinicId, expiresInDays: 31 }),
        ).toMatchObject({ status: "error" });

        // No agreement in effect: a link would show nothing to do.
        const bare = await seedClinic("ops-calendar-bare");
        expect(await run("issueCalendarLink", { clinicId: bare.clinicId })).toMatchObject({
          status: "error",
        });

        // The demo clinic's link is for the verification video, so it is shown.
        const demo = await seedDemoClinic("ops-calendar-demo");
        const shown = await run("issueCalendarLink", { clinicId: demo.clinicId, expiresInDays: 2 });
        expect(shown).toMatchObject({
          status: "issued",
          url: expect.stringMatching(/\/calendar\/[A-Za-z0-9_-]{43}$/),
        });
      } finally {
        if (saved.id === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
        else process.env.GOOGLE_OAUTH_CLIENT_ID = saved.id;
        if (saved.secret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
        else process.env.GOOGLE_OAUTH_CLIENT_SECRET = saved.secret;
      }
    },
    SLOW,
  );

  test(
    "disconnectCalendar, a recorded termination and the start of offboarding each take the calendar away and revoke the grant at Google",
    async () => {
      const google = fakeGoogleCalendar();
      setGoogleFetch(google.fetch);
      const connect = async (label: string) => {
        const clinic = await seedClinic(label);
        const { agreementId } = await seedCalendarTerms(clinic);
        const sub = `13${Date.now()}${Math.floor(Math.random() * 1e6)}`;
        google.addAccount({ sub, email: `${label}@clinic.test`, hd: "clinic.test" });
        const { refreshToken } = google.grant({ sub });
        await seedGoogleConnection(clinic.clinicId, {
          refreshToken,
          accountRef: createHash("sha256").update(`google:${sub}`).digest("hex"),
        });
        return { clinic, agreementId, refreshToken };
      };
      const statusOf = (clinicId: string) =>
        inTenant(
          clinicId,
          async (client) =>
            (
              await client.query<{ status: string; last_error: string | null }>(
                `select status, last_error from provider_connections where clinic_id = $1 and provider = 'google_calendar'`,
                [clinicId],
              )
            ).rows[0]!,
        );
      try {
        const operated = await connect("ops-disconnect");
        expect(
          await run("disconnectCalendar", { clinicId: operated.clinic.clinicId }),
        ).toMatchObject({
          status: "disconnected",
          revokedAtGoogle: true,
        });
        expect(await statusOf(operated.clinic.clinicId)).toEqual({
          status: "revoked",
          last_error: "operator",
        });
        expect(google.grantOf(operated.refreshToken)?.revoked).toBe(true);
        expect(await run("disconnectCalendar", { clinicId: operated.clinic.clinicId })).toEqual({
          status: "not_connected",
        });

        const terminated = await connect("ops-terminated");
        const untouched = await connect("ops-terminated-other");
        expect(
          await run("markAgreementTerminated", {
            agreementId: terminated.agreementId,
            terminationDate: new Date().toISOString().slice(0, 10),
            terminationReason: "services_ended",
          }),
        ).toMatchObject({ status: "recorded" });
        expect(await statusOf(terminated.clinic.clinicId)).toEqual({
          status: "revoked",
          last_error: "terms_ended",
        });
        expect(google.grantOf(terminated.refreshToken)?.revoked).toBe(true);
        expect(await statusOf(untouched.clinic.clinicId)).toEqual({
          status: "active",
          last_error: null,
        });
        expect(google.grantOf(untouched.refreshToken)?.revoked).toBe(false);

        const leaving = await connect("ops-offboarding");
        await run("startOffboarding", {
          clinicId: leaving.clinic.clinicId,
          reason: "The practice cancelled.",
        });
        expect(await statusOf(leaving.clinic.clinicId)).toEqual({
          status: "revoked",
          last_error: "offboarding",
        });
        expect(google.grantOf(leaving.refreshToken)?.revoked).toBe(true);
      } finally {
        setGoogleFetch(undefined);
      }
    },
    SLOW,
  );

  test(
    "getOnboarding's booking: the mode and its reasons, Auto-confirm and the terms, and never the Google account's address, reference or zone",
    async () => {
      const saved = {
        id: process.env.GOOGLE_OAUTH_CLIENT_ID,
        secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      };
      process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
      process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
      delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
      try {
        const bare = await seedClinic("ops-booking-bare");
        const resting = (await run("getOnboarding", { clinicId: bare.clinicId })).booking;
        expect(resting).toMatchObject({
          mode: "manual",
          canOfferTimes: false,
          autoConfirm: true,
          autoConfirmChangedAt: null,
          killSwitchOn: false,
          demo: false,
          terms: {
            kind: "none",
            source: null,
            clauseId: null,
            documentVersion: null,
            documentReleased: null,
            electedAt: null,
            reason: "no_agreement",
          },
          calendar: null,
          calendarLinkOutstanding: false,
          pendingAssistantWrites: 0,
        });

        const clinic = await seedClinic("ops-booking");
        await seedCalendarTerms(clinic);
        const { connectionId, accountRef } = await seedGoogleConnection(clinic.clinicId);
        // What the connect flow stores beside the token: the account's address
        // and the calendar's own zone, for the clinic's portal only.
        await inTenant(clinic.clinicId, (client) =>
          client.query(
            `update provider_connections
                set metadata = metadata || jsonb_build_object(
                      'accountEmail', 'owner@radiance-booking.test',
                      'calendarTimeZone', 'Europe/Lisbon',
                      'connectedAt', '2026-10-08T09:00:00.000Z')
              where id = $1`,
            [connectionId],
          ),
        );
        const view = await run("getOnboarding", { clinicId: clinic.clinicId });
        const booking = view.booking as Record<string, unknown>;
        expect(booking).toMatchObject({
          mode: "manual",
          canOfferTimes: false,
          terms: {
            kind: "covered",
            source: "agreement",
            clauseId: "google-calendar-covered",
            documentVersion: "1.3.0",
            documentReleased: true,
            electedAt: expect.any(String),
            reason: null,
          },
          calendar: {
            connectionId,
            status: "active",
            accountKind: "workspace",
            hostedDomain: "radiance.test",
            // The clinic is on America/New_York; only the comparison crosses.
            timeZoneMatches: false,
            disclosureCurrent: true,
            connectedAt: "2026-10-08T09:00:00.000Z",
            lastVerifiedAt: expect.any(String),
            lastError: null,
            brokenAt: null,
          },
        });
        expect((booking.reasons as { code: string }[]).map((r) => r.code)).toEqual([
          "timezone_unconfirmed",
          "opening_hours_unknown",
          "not_production",
          "agent_not_approved",
          "kill_switch_off",
        ]);
        const json = JSON.stringify(view);
        expect(json).not.toContain("owner@radiance-booking.test");
        expect(json).not.toContain(accountRef);
        expect(JSON.stringify(booking)).not.toContain("Europe/Lisbon");

        // What the console counts. A spent calendar link, a lapsed one and a
        // live link for something else are not outstanding...
        const addLink = (purpose: string, createdAgo: string, expiresIn: string, used: boolean) =>
          inTenant(clinic.clinicId, (client) =>
            client.query(
              `insert into connection_links (clinic_id, token_hash, purpose, created_at, expires_at, used_at)
               values ($1, $2, $3, now() - $4::interval, now() + $5::interval,
                       case when $6::boolean then now() end)`,
              [clinic.clinicId, randomBytes(32), purpose, createdAgo, expiresIn, used],
            ),
          );
        await addLink("calendar", "1 day", "6 days", true);
        await addLink("calendar", "10 days", "-3 days", false);
        await addLink("connect", "0 seconds", "7 days", false);
        // ...nor is a hold still held or one released; a write in flight and
        // one not yet read back are the assistant's writes pending.
        const base = futureBase();
        const placeHold = (holder: string, minutes: number) =>
          asApp(clinic.clinicId, (c) =>
            insertHold(c, clinic.clinicId, { holder, startsAt: at(base, minutes) }),
          );
        const writing = await placeHold("voice:ops-writing", 0);
        await asApp(clinic.clinicId, (c) => claimForWriting(c, writing));
        const unknown = await placeHold("voice:ops-unknown", 60);
        await asApp(clinic.clinicId, (c) => claimForWriting(c, unknown));
        await asApp(clinic.clinicId, (c) =>
          c.query(
            `update slot_holds set status = 'unknown', next_check_at = clock_timestamp() + interval '2 minutes'
              where id = $1`,
            [unknown],
          ),
        );
        await placeHold("voice:ops-held", 120);
        const released = await placeHold("voice:ops-released", 180);
        await asApp(clinic.clinicId, (c) =>
          c.query(
            `update slot_holds set status = 'released', outcome_reason = 'superseded',
                                   released_at = now(), updated_at = now() where id = $1`,
            [released],
          ),
        );
        expect((await run("getOnboarding", { clinicId: clinic.clinicId })).booking).toMatchObject({
          calendarLinkOutstanding: false,
          pendingAssistantWrites: 2,
        });

        // An unspent, unexpired calendar link is; and a calendar in the
        // clinic's own zone matches it.
        await addLink("calendar", "0 seconds", "7 days", false);
        await inTenant(clinic.clinicId, (client) =>
          client.query(
            `update provider_connections
                set metadata = metadata || jsonb_build_object('calendarTimeZone', 'America/New_York')
              where id = $1`,
            [connectionId],
          ),
        );
        expect((await run("getOnboarding", { clinicId: clinic.clinicId })).booking).toMatchObject({
          calendarLinkOutstanding: true,
          pendingAssistantWrites: 2,
          calendar: { timeZoneMatches: true },
        });
      } finally {
        if (saved.id === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
        else process.env.GOOGLE_OAUTH_CLIENT_ID = saved.id;
        if (saved.secret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
        else process.env.GOOGLE_OAUTH_CLIENT_SECRET = saved.secret;
      }
    },
    SLOW,
  );

  test(
    "setAutoConfirm switches the clinic's Auto-confirm under the team's name, audits the operator once, and answers with the mode",
    async () => {
      expect(isOpName("setAutoConfirm")).toBe(true);
      expect(isMutating("setAutoConfirm")).toBe(true);
      const { clinicId } = await seedClinic("ops-auto-confirm");
      const events = async () =>
        (
          await getMigratorPool().query<{ actor_label: string; metadata: Record<string, unknown> }>(
            `select actor_label, metadata from security_events
              where event = 'auto_confirm_set' and metadata ->> 'clinicId' = $1`,
            [clinicId],
          )
        ).rows;

      expect(await run("setAutoConfirm", { clinicId })).toMatchObject({ status: "error" });
      expect(await run("setAutoConfirm", { clinicId, on: "false" })).toMatchObject({
        status: "error",
      });
      expect(
        await run("setAutoConfirm", {
          clinicId: "00000000-0000-4000-8000-000000000000",
          on: false,
        }),
      ).toEqual({ status: "error", message: "No such clinic." });

      const off = await run("setAutoConfirm", { clinicId, on: false });
      expect(off).toMatchObject({
        status: "updated",
        changed: true,
        autoConfirm: false,
        mode: "manual",
        auditRecorded: true,
      });
      expect((off.reasons as { code: string }[]).map((r) => r.code)).toContain("auto_confirm_off");
      expect(await events()).toEqual([
        { actor_label: OPERATOR.email, metadata: { clinicId, on: false } },
      ]);
      // The clinic's screens name the team; the audit rows name the operator.
      const stamp = await inTenant(
        clinicId,
        async (client) =>
          (
            await client.query<{
              auto_confirm_bookings: boolean;
              auto_confirm_changed_by_label: string;
            }>(
              `select auto_confirm_bookings, auto_confirm_changed_by_label from clinic_settings where clinic_id = $1`,
              [clinicId],
            )
          ).rows[0]!,
      );
      expect(stamp).toEqual({
        auto_confirm_bookings: false,
        auto_confirm_changed_by_label: "healdesk support",
      });

      // Already off: nothing changes and nothing more is audited.
      expect(await run("setAutoConfirm", { clinicId, on: false })).toMatchObject({
        status: "updated",
        changed: false,
        autoConfirm: false,
      });
      expect(await events()).toHaveLength(1);
      expect(
        (await run("getOnboarding", { clinicId })).booking as Record<string, unknown>,
      ).toMatchObject({ autoConfirm: false, autoConfirmChangedAt: expect.any(String) });
    },
    SLOW,
  );

  test(
    "goLive refuses a demo clinic, which stays synthetic, and goes on to judge any other",
    async () => {
      const demo = await seedDemoClinic("ops-golive-demo");
      const refused = await run("goLive", { clinicId: demo.clinicId });
      expect(refused).toMatchObject({
        status: "refused",
        message: expect.stringMatching(/demo clinic/),
      });
      const after = (await listClinics()).find((c) => c.id === demo.clinicId)!;
      expect(after.dataClassification).toBe("synthetic");
      expect(after.wentLiveAt).toBeNull();

      // A clinic that is not a demo clinic is judged as before: here, not ready.
      const { clinicId } = await seedClinic("ops-golive-real");
      const judged = await run("goLive", { clinicId });
      expect(judged).toMatchObject({ status: "refused", message: "Not ready." });
    },
    SLOW,
  );
});
