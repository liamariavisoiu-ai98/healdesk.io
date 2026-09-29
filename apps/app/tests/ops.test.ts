import { ONBOARDING_STEPS } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { agreementCarriesCalendarWrite, isIanaTimeZone, runOperation, type Operator } from "@/lib/ops/api";
import { blockersFor, listClinics, type ClinicOverview } from "@/lib/ops/clinics";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

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
  outboundCallbacksEnabled: false,
  timezoneConfirmedAt: null,
  bookingRequirements: null,
  bookingRequirementsConfirmedAt: null,
  bookingRequirementsSource: null,
  synthflowCallbackAgentId: null,
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
        "bookingMode",
        "bookingRequirements",
        "bookingRequirementsConfirmedAt",
        "bookingRequirementsSource",
        "directBookingElectedAt",
        "directBookingWithdrawnAt",
        "outboundCallbacksEnabled",
        "synthflowCallbackAgentId",
        "timezoneConfirmedAt",
        "callRouting",
        "callRoutingConfirmedAt",
        "carrier",
        "createdAt",
        "dataClassification",
        "destroyAfter",
        "destroyedAt",
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

describeDb("ops: booking hand-off, callbacks and direct booking", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    delete process.env.HEALDESK_WHATSAPP_TEMPLATES_ENABLED;
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
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
    expect(view.outboundCallbacksEnabled).toBe(false);
    expect(view.timezoneConfirmedAt).toBeNull();
    expect(view.pendingCallbacks).toBe(0);
    expect(view.calendarConnection).toBeNull();
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

  test("setOutboundCallbacks refuses on until the time zone is confirmed and the number is on file", async () => {
    const { clinicId } = await seedClinic("ops-callbacks");
    const refusedTz = await run("setOutboundCallbacks", { clinicId, enabled: true });
    expect(refusedTz.status).toBe("error");
    expect(String(refusedTz.message)).toMatch(/time zone/i);

    expect((await run("setClinicTimezone", { clinicId, timezone: "EST" })).status).toBe("error");
    const tz = await run("setClinicTimezone", { clinicId, timezone: "America/Chicago" });
    expect(tz).toMatchObject({ status: "updated", timezone: "America/Chicago" });
    const overview = (await listClinics()).find((c) => c.id === clinicId)!;
    expect(overview.timezone).toBe("America/Chicago");
    expect(overview.timezoneConfirmedAt).not.toBeNull();

    const refusedPhone = await run("setOutboundCallbacks", { clinicId, enabled: true });
    expect(refusedPhone.status).toBe("error");
    expect(String(refusedPhone.message)).toMatch(/published number/i);

    await getMigratorPool().query(`update clinics set published_phone_e164 = '+14155550199' where id = $1`, [clinicId]);
    expect((await run("setOutboundCallbacks", { clinicId, enabled: true })).status).toBe("updated");
    expect((await listClinics()).find((c) => c.id === clinicId)!.outboundCallbacksEnabled).toBe(true);
    // Off always succeeds.
    expect((await run("setOutboundCallbacks", { clinicId, enabled: false })).status).toBe("updated");
  });

  test("setWhatsAppTemplate refuses without the flag", async () => {
    const { clinicId } = await seedClinic("ops-whatsapp");
    delete process.env.HEALDESK_WHATSAPP_TEMPLATES_ENABLED;
    const refused = await run("setWhatsAppTemplate", { clinicId, templateName: "healdesk_request_update_v1" });
    expect(refused.status).toBe("error");
    expect(String(refused.message)).toMatch(/HEALDESK_WHATSAPP_TEMPLATES_ENABLED/);
    // With the flag but no WhatsApp channel there is nowhere to put it.
    process.env.HEALDESK_WHATSAPP_TEMPLATES_ENABLED = "true";
    try {
      const noChannel = await run("setWhatsAppTemplate", { clinicId, templateName: "healdesk_request_update_v1" });
      expect(noChannel.status).toBe("error");
      expect(String(noChannel.message)).toMatch(/WhatsApp channel/);
    } finally {
      delete process.env.HEALDESK_WHATSAPP_TEMPLATES_ENABLED;
    }
  });

  test("issueConnectLink for calcom refuses without a calendar-write agreement", async () => {
    const { clinicId, organizationId } = await seedClinic("ops-calcom");
    await getMigratorPool().query(`update clinics set booking_provider = 'calcom' where id = $1`, [clinicId]);

    // No agreement at all.
    const none = await run("issueConnectLink", { clinicId });
    expect(none).toMatchObject({ status: "error", reason: "baa_lacks_calendar_write" });

    // A bound 1.0.0 agreement: no calendar-write clause was in that document.
    await getMigratorPool().query(
      `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
       values ($1, '1.0.0', repeat('a', 64), 'BAA', '{"appliedClauses":["parties","safeguards"],"calendarWrite":null}'::jsonb, 'I agree', 'Alex', 'alex@calcom.test', now() - interval '2 days', now() - interval '2 days')`,
      [organizationId],
    );
    expect(await agreementCarriesCalendarWrite(organizationId)).toBe(false);
    expect(await run("issueConnectLink", { clinicId })).toMatchObject({ status: "error", reason: "baa_lacks_calendar_write" });

    // A later bound agreement whose rendered document carried the clause.
    await getMigratorPool().query(
      `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
       values ($1, '1.1.0-draft', repeat('b', 64), 'BAA', '{"appliedClauses":["parties","calendar-write"],"calendarWrite":{"platform":"Cal.com"}}'::jsonb, 'I agree', 'Alex', 'alex@calcom.test', now(), now())`,
      [organizationId],
    );
    expect(await agreementCarriesCalendarWrite(organizationId)).toBe(true);
    const issued = await run("issueConnectLink", { clinicId });
    expect(issued.status).toBe("issued");
    expect(String(issued.url)).toMatch(/\/connect\/[A-Za-z0-9_-]{43}$/);

    // Terminated: counts for nothing again.
    await getMigratorPool().query(`update baa_acceptances set terminated_at = now() where organization_id = $1 and document_version = '1.1.0-draft'`, [organizationId]);
    expect(await agreementCarriesCalendarWrite(organizationId)).toBe(false);

    // A read-only platform never asks the question.
    const { clinicId: acuityId } = await seedClinic("ops-acuity");
    await getMigratorPool().query(`update clinics set booking_provider = 'acuity' where id = $1`, [acuityId]);
    expect((await run("issueConnectLink", { clinicId: acuityId })).status).toBe("issued");
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
