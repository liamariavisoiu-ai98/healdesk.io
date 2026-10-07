import { CURRENT_BAA_VERSION, ONBOARDING_STEPS } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { AwsKmsKeyWrapper, __setKeyWrapperForTests } from "@/lib/crypto/kms";
import {
  agreementCarriesCalendarWrite,
  isIanaTimeZone,
  isMutating,
  isOpName,
  runOperation,
  type Operator,
} from "@/lib/ops/api";
import { blockersFor, listClinics, type ClinicOverview } from "@/lib/ops/clinics";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";
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
  callRouting: "conditional",
  callRoutingConfirmedAt: new Date(),
  carrier: "verizon",
  synthflowNumberE164: "+14155550100",
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
        "callRouting",
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
        "slug",
        "specialty",
        "stripeConnectAccountId",
        "stripeConnectConnectedAt",
        "stripeConnectDisconnectedAt",
        "synthflowNumberE164",
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

  test("listCalendarWrites and the OnboardingView carry no firstName or phone key", async () => {
    const { clinicId } = await seedClinic("ops-view");
    const view = await run("getOnboarding", { clinicId });
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/"firstName":/);
    expect(json).not.toMatch(/"phone":/);
    expect(json).not.toMatch(/"fullName":/);
    // The new fields are present with their resting values.
    expect(view.bookingMode).toBe("desk_confirms");
    expect(view.timezoneConfirmedAt).toBeNull();
    expect(view.calendarConnection).toBeNull();
    // The call-back switch, its queue count and the WhatsApp template are gone.
    for (const key of ["outboundCallbacksEnabled", "pendingCallbacks", "whatsappTemplateName", "whatsappTemplatesFlag"]) {
      expect(view, key).not.toHaveProperty(key);
    }
    expect(view.calendarWrites).toEqual([]);
    const requirements = view.requirements as { fields: string[]; source: string | null; catalogue: unknown[]; neverAsked: string[] };
    expect(requirements.fields.slice(0, 4)).toEqual(["first_name", "phone", "preferred_window", "alternative_windows"]);
    expect(requirements.source).toBeNull();
    expect(requirements.neverAsked.length).toBeGreaterThan(0);
    const direct = view.directBooking as { gates: { id: string; ok: boolean }[]; missing: string[]; addendumApproved: boolean };
    expect(direct.gates.map((g) => g.id)).toEqual(["env", "addendum", "election", "calendar", "production", "agent"]);
    expect(direct.gates.every((g) => g.ok === false)).toBe(true);
    expect(direct.missing.length).toBeGreaterThan(0);

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

  test("agreementCarriesCalendarWrite reads the bound, in-effect agreement's own clauses", async () => {
    const { organizationId } = await seedClinic("ops-calendar-clause");
    expect(await agreementCarriesCalendarWrite(organizationId)).toBe(false);

    // A bound 1.0.0 agreement: no calendar-write clause was in that document.
    await getMigratorPool().query(
      `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
       values ($1, '1.0.0', repeat('a', 64), 'BAA', '{"appliedClauses":["parties","safeguards"],"calendarWrite":null}'::jsonb, 'I agree', 'Alex', 'alex@clause.test', now() - interval '2 days', now() - interval '2 days')`,
      [organizationId],
    );
    expect(await agreementCarriesCalendarWrite(organizationId)).toBe(false);

    // A later bound agreement whose rendered document carried the clause.
    await getMigratorPool().query(
      `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
       values ($1, '1.1.0-draft', repeat('b', 64), 'BAA', '{"appliedClauses":["parties","calendar-write"],"calendarWrite":{"platform":"Cal.com"}}'::jsonb, 'I agree', 'Alex', 'alex@clause.test', now(), now())`,
      [organizationId],
    );
    expect(await agreementCarriesCalendarWrite(organizationId)).toBe(true);

    // Terminated: counts for nothing again.
    await getMigratorPool().query(`update baa_acceptances set terminated_at = now() where organization_id = $1 and document_version = '1.1.0-draft'`, [organizationId]);
    expect(await agreementCarriesCalendarWrite(organizationId)).toBe(false);
  });

  test("setBookingMode direct refuses listing the missing gates; desk_confirms stamps the withdrawal", async () => {
    const { clinicId } = await seedClinic("ops-mode");
    // The addendum is unapproved in the catalogue, so this is the first gate.
    const refused = await run("setBookingMode", { clinicId, mode: "direct" });
    expect(refused).toMatchObject({ status: "refused", reason: "addendum_not_approved" });
    expect((refused.missing as string[]).length).toBeGreaterThan(0);
    expect((await listClinics()).find((c) => c.id === clinicId)!.bookingMode).toBe("desk_confirms");

    // An election recorded directly, then withdrawn by the console.
    await getMigratorPool().query(
      `update clinics set direct_booking_elected_at = now(), direct_booking_elected_by_label = 'Dr Chen', direct_booking_clause_version = 'direct-booking-addendum/1.0.0', direct_booking_clause_hash = decode(repeat('c', 64), 'hex') where id = $1`,
      [clinicId],
    );
    const back = await run("setBookingMode", { clinicId, mode: "desk_confirms" });
    expect(back).toMatchObject({ status: "updated", mode: "desk_confirms" });
    const after = (await listClinics()).find((c) => c.id === clinicId)!;
    expect(after.directBookingWithdrawnAt).not.toBeNull();
    expect(after.bookingMode).toBe("desk_confirms");
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

  test("issueSetupLink mints a /setup link and setConnectionPhiBasis is audited", async () => {
    const { clinicId } = await seedClinic("ops-setup-link");
    const issued = await run("issueSetupLink", { clinicId });
    expect(issued.status).toBe("issued");
    expect(String(issued.url)).toMatch(/\/setup\/[A-Za-z0-9_-]{43}$/);
    const purposes = await inTenant(clinicId, async (client) => (await client.query<{ purpose: string }>(`select purpose from connection_links where clinic_id = $1`, [clinicId])).rows.map((r) => r.purpose));
    expect(purposes).toEqual(["setup"]);

    const missing = await run("setConnectionPhiBasis", { clinicId, connectionId: "00000000-0000-4000-8000-000000000000", basis: "vendor_baa" });
    expect(missing.status).toBe("error");
    const events = await getMigratorPool().query(`select count(*)::int as n from security_events where event = 'setup_link_issued'`);
    expect(events.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
