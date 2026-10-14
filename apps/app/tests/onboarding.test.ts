import { CURRENT_BAA_VERSION, findClinicalContent, forwardingInstructions, openRequiredSteps } from "@healdesk/catalog";
import { DrizzleQueryError, sql } from "drizzle-orm";
import { DatabaseError } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { unsafeDb } from "@/db";

import {
  AgentConfigError,
  approveAgentConfig,
  defaultAgentConfig,
  getAgentConfig,
  seedAgentConfig,
  updateAgentConfig,
  validateAgentConfig,
} from "@/lib/onboarding/agent-config";
import { issueConnectionLink } from "@/lib/connections/links";
import {
  goLive,
  goLivePreconditions,
  NO_DIRECT_LINE,
  readVoiceLine,
  refusalReason,
} from "@/lib/onboarding/go-live";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { applyBookingRequirementDefaults, applyBookingRequirementDefaultsFor } from "@/lib/onboarding/requirements";
import { completeStep, readOnboarding, reopenStep } from "@/lib/onboarding/steps";
import { listClinics } from "@/lib/ops/clinics";
import { undoSteps } from "@/lib/portal/settings-view";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedChannels, seedClinic } from "./setup/factories";

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;

describe("forwarding instructions", () => {
  test("conditional routing on a known carrier gives busy and no-answer codes, never *72", () => {
    const f = forwardingInstructions({ carrier: "verizon", phoneSystemType: "landline", routing: "conditional", destinationE164: "+14155550100" });
    expect(f.steps.map((s) => s.dial)).toEqual(["*904155550100", "*924155550100"]);
    expect(f.undo.map((s) => s.dial)).toEqual(["*91", "*93"]);
    expect(JSON.stringify(f)).not.toContain("*72");
    expect(f.needsCarrierHelp).toBe(false);
  });

  test("always routing is the only place unconditional forwarding appears, with its warning", () => {
    const f = forwardingInstructions({ carrier: "att", phoneSystemType: "landline", routing: "always", destinationE164: "+14155550100" });
    expect(f.steps[0]!.dial).toBe("*724155550100");
    expect(f.notes.join(" ")).toMatch(/Only after-hours calls count/);
  });

  test("an unknown carrier refuses to guess", () => {
    const f = forwardingInstructions({ carrier: null, phoneSystemType: "unknown", routing: "conditional", destinationE164: "+14155550100" });
    expect(f.needsCarrierHelp).toBe(true);
    expect(f.steps[0]!.dial).toBe("+14155550100");
  });

  test("the Safety net's undo codes follow the coverage mode: After hours only undoes all-call forwarding, never *91 and *93", () => {
    // After hours only forwards every call at closing (*72), so *91 and *93
    // would leave the line forwarded; it was shown them while the mode was
    // read as 'conditional'.
    const dialsFor = (mode: "all_calls" | "overflow_after_hours" | "after_hours_only") =>
      undoSteps("verizon", "landline", mode).map((row) => [row.carrier, row.steps.map((s) => s.dial)]);
    expect(dialsFor("after_hours_only")).toEqual([["Verizon", ["*73"]]]);
    expect(dialsFor("all_calls")).toEqual([["Verizon", ["*73"]]]);
    expect(dialsFor("overflow_after_hours")).toEqual([["Verizon", ["*91", "*93"]]]);
    // With no carrier on file, every carrier's, each for the mode.
    for (const row of undoSteps(null, "landline", "after_hours_only")) {
      expect(JSON.stringify(row.steps), row.carrier).not.toMatch(/\*91|\*93|##67#|##61#/);
    }
  });

  test("VoIP gets a rule, not a star code, and asks for caller-ID pass-through", () => {
    const f = forwardingInstructions({ carrier: "other", phoneSystemType: "voip", routing: "conditional", destinationE164: "+14155550100" });
    expect(f.steps.some((s) => /caller/i.test(s.label))).toBe(true);
    expect(JSON.stringify(f.steps)).not.toMatch(/\*9/);
  });
});

describe("clinical content guard", () => {
  test("names the field and the kind of claim", () => {
    const findings = findClinicalContent({
      greeting: "Welcome! Botox is safe during pregnancy, ask us how.",
      notes: "Free parking behind the building.",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ field: "greeting", label: "a safety claim" });
  });

  test("scheduling copy passes", () => {
    expect(findClinicalContent({ greeting: "Thanks for calling Radiance. I can book a consultation or take a message." })).toEqual([]);
  });

  test("validateAgentConfig refuses dosing, candidacy and guarantees in any field", () => {
    const base = defaultAgentConfig("med-spa", "Radiance");
    expect(() => validateAgentConfig({ ...base, notes: "Typical dose is 20 units per area." })).toThrow(AgentConfigError);
    expect(() => validateAgentConfig({ ...base, services: [{ name: "Botox for ideal candidates", priceFromUsd: 300, priceToUsd: 600, durationMinutes: 30 }] })).toThrow(/candidacy/);
    expect(() => validateAgentConfig({ ...base, greeting: "Guaranteed results every time." })).toThrow(/results guarantee/);
    expect(() => validateAgentConfig(base)).not.toThrow();
  });

  test("a med spa's services named for a condition, and a greeting that names them, are its own words and are kept", () => {
    // The everyday skin and hair conditions are the Meta channels' rule only.
    const base = defaultAgentConfig("med-spa", "Glow");
    const config = {
      ...base,
      greeting: "Thanks for calling Glow. I can book an Acne Facial, our Rosacea Laser or a consultation, and take a message for the team.",
      services: [
        ...base.services,
        { name: "Acne Facial", priceFromUsd: 150, priceToUsd: 150, durationMinutes: 60 },
        { name: "Rosacea Laser", priceFromUsd: 350, priceToUsd: 450, durationMinutes: 45 },
        { name: "Hair loss PRP", priceFromUsd: 600, priceToUsd: 900, durationMinutes: 60 },
      ],
      notes: "Scar revision consultations are free.",
    };
    expect(() => validateAgentConfig(config)).not.toThrow();
    // The same words would be refused on a Meta channel.
    expect(findClinicalContent({ name: "Acne Facial" }, { conditions: true })).toHaveLength(1);
  });
});

describe("open required steps", () => {
  test("platform_connected is required only for verified attribution", () => {
    const all = Object.fromEntries(["hours_confirmed","phone_type_confirmed","call_routing_chosen","covered_entity_confirmed","agent_script_approved","forwarding_configured","test_call_passed","booking_requirements_confirmed"].map((s) => [s, "2026-09-13T00:00:00Z"]));
    expect(openRequiredSteps(all)).toEqual([]);
    expect(openRequiredSteps(all, { requirePlatform: true })).toEqual(["platform_connected"]);
    expect(openRequiredSteps({})).toHaveLength(8);
  });
});

describe("a go-live refusal reaches the console in the database's words", () => {
  test("the pg error under drizzle's wrapper is the reason, hint included", () => {
    // drizzle-orm 0.45's own message is the failed query and its parameters.
    // Before refusalReason walked to `.cause`, that is what the console showed.
    const refusal = Object.assign(
      new DatabaseError(
        "Clinic c1 is bound to business associate agreement version 1.0.0, which has been superseded; refusing to mark it production.",
        0,
        "error",
      ),
      { code: "23514", hint: "The practice accepts the current agreement first." },
    );
    const wrapped = new DrizzleQueryError("select app_mark_clinic_production($1::uuid) as signed", ["c1"], refusal);
    expect(wrapped.message).toMatch(/^Failed query/);
    expect(refusalReason(wrapped)).toBe(`${refusal.message} The practice accepts the current agreement first.`);
  });

  test("an error with no SQLSTATE in its chain keeps its own message", () => {
    expect(refusalReason(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe("connect ECONNREFUSED 127.0.0.1:5432");
    expect(refusalReason("not an error")).toBe("Refused.");
  });
});

describeDb("onboarding", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("steps stamp once, keep their first timestamp, and can be reopened", async () => {
    const { clinicId } = await seedClinic("steps");
    const first = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
      completeStep(tx, "forwarding_configured", { at: new Date("2026-09-01T00:00:00Z"), note: "dialled *90" }),
    );
    expect(first.forwarding_configured).toBe("2026-09-01T00:00:00.000Z");
    const again = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
      completeStep(tx, "forwarding_configured", { at: new Date("2026-09-02T00:00:00Z") }),
    );
    expect(again.forwarding_configured).toBe("2026-09-01T00:00:00.000Z");
    const reopened = await withTenant({ clinicId, actor: ACTOR }, (tx) => reopenStep(tx, "forwarding_configured", "test failed"));
    expect(reopened.forwarding_configured).toBeNull();
    expect(await withTenant({ clinicId, actor: ACTOR }, readOnboarding)).toHaveProperty("hours_confirmed", null);
    // A reopened step, like every step provisioning seeds open, holds a JSON
    // null, and completing it stamps it again.
    const restamped = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
      completeStep(tx, "forwarding_configured", { at: new Date("2026-09-03T00:00:00Z") }),
    );
    expect(restamped.forwarding_configured).toBe("2026-09-03T00:00:00.000Z");
  });

  test("the agent script is seeded, edits clear approval, approval stamps the step", async () => {
    const { clinicId } = await seedClinic("agent");
    await withTenant({ clinicId, actor: ACTOR }, (tx) => seedAgentConfig(tx, "dental", "Bright Smiles"));
    const seeded = await withTenant({ clinicId, actor: ACTOR }, getAgentConfig);
    expect(seeded?.greeting).toContain("Bright Smiles");
    expect(seeded?.version).toBe(1);

    await expect(
      withTenant({ clinicId, actor: ACTOR }, (tx) =>
        updateAgentConfig(tx, { greeting: "We diagnose gum disease over the phone.", services: [], escalationPhone: null, escalationHours: null, notes: null }),
      ),
    ).rejects.toThrow(AgentConfigError);

    const approved = await withTenant({ clinicId, actor: ACTOR }, (tx) => approveAgentConfig(tx, "Dr Chen"));
    expect(approved.approvedAt).not.toBeNull();
    const state = await withTenant({ clinicId, actor: ACTOR }, readOnboarding);
    expect(state.agent_script_approved).not.toBeNull();

    const edited = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
      updateAgentConfig(tx, { greeting: "Thanks for calling Bright Smiles. I can book a cleaning.", services: [{ name: "Cleaning", priceFromUsd: 120, priceToUsd: 180, durationMinutes: 45 }], escalationPhone: "+14155550100", escalationHours: "Weekdays 9 to 5", notes: null }),
    );
    expect(edited.version).toBe(2);
    expect(edited.approvedAt).toBeNull();
    const overview = (await listClinics()).find((c) => c.id === clinicId)!;
    expect(overview.agentApprovedAt).toBeNull();
  });

  test("go-live lists what is missing, then flips the clinic once everything is confirmed", async () => {
    const { clinicId, organizationId } = await seedClinic("golive");
    const before = (await listClinics()).find((c) => c.id === clinicId)!;
    const check = goLivePreconditions(before);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.missing.length).toBeGreaterThan(3);

    const refused = await goLive(clinicId, { label: "ops@healdesk.test" });
    expect(refused.status).toBe("refused");

    // Ready it the way the onboarding call does.
    await getMigratorPool().query(
      `update clinics set is_covered_entity = false, opening_hours = '{"mon":[["09:00","17:00"]]}'::jsonb where id = $1`,
      [clinicId],
    );
    await getMigratorPool().query(
      `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
       values ($1, $2, repeat('b', 64), 'BAA', '{}'::jsonb, 'I agree', 'Alex', 'alex@golive.test', now(), now())`,
      [organizationId, CURRENT_BAA_VERSION],
    );
    await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { phoneSystemType: "landline", carrier: "verizon", callRouting: "conditional", assistantNumberE164: "+14155550199" });
      await seedAgentConfig(tx, "med-spa", "Golive Clinic");
      await approveAgentConfig(tx, "Owner");
      await completeStep(tx, "hours_confirmed");
      await completeStep(tx, "covered_entity_confirmed");
      await completeStep(tx, "forwarding_configured");
      await completeStep(tx, "test_call_passed");
    });

    // 0040: the booking requirement set must be confirmed too, and the
    // database refuses on its own while it is open — whichever of the two
    // checks (goLivePreconditions or app_mark_clinic_production) says no
    // first, the refusal names the step.
    const stillOpen = await goLive(clinicId, { label: "ops@healdesk.test" });
    expect(stillOpen.status).toBe("refused");
    expect(JSON.stringify(stillOpen)).toMatch(/booking.requirements.confirmed/);
    await getMigratorPool().query(
      `update clinics set onboarding = onboarding || jsonb_build_object('booking_requirements_confirmed', now()::text) where id = $1`,
      [clinicId],
    );

    const live = await goLive(clinicId, { label: "ops@healdesk.test" });
    expect(live.status, JSON.stringify(live)).toBe("live");
    const after = (await listClinics()).find((c) => c.id === clinicId)!;
    expect(after.dataClassification).toBe("production");
    expect(after.wentLiveAt).not.toBeNull();
    const events = await getMigratorPool().query(`select count(*)::int as n from security_events where event = 'clinic_went_live'`);
    expect(events.rows[0].n).toBe(1);

    expect((await goLive(clinicId, { label: "ops@healdesk.test" })).status).toBe("refused");
  });

  test("go-live refuses an account on a superseded agreement, in the console's words and the database's", async () => {
    const { clinicId, organizationId } = await seedClinic("superseded");
    await getMigratorPool().query(
      `update clinics
          set is_covered_entity = false,
              opening_hours = '{"mon":[["09:00","17:00"]]}'::jsonb,
              call_routing_confirmed_at = now(),
              agent_approved_at = now(),
              onboarding = jsonb_build_object(
                'hours_confirmed', now()::text, 'phone_type_confirmed', now()::text,
                'call_routing_chosen', now()::text, 'covered_entity_confirmed', now()::text,
                'agent_script_approved', now()::text, 'forwarding_configured', now()::text,
                'test_call_passed', now()::text, 'booking_requirements_confirmed', now()::text)
        where id = $1`,
      [clinicId],
    );
    await getMigratorPool().query(
      `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
       values ($1, '1.0.0', repeat('c', 64), 'BAA', '{}'::jsonb, 'I agree', 'Alex', 'alex@superseded.test', now() - interval '30 days', now() - interval '30 days')`,
      [organizationId],
    );

    // Everything else is confirmed, so the agreement is the one thing missing.
    const superseded = `The agreement in effect is BAA v1.0.0, which has been superseded. The practice must accept v${CURRENT_BAA_VERSION} before go-live.`;
    const before = (await listClinics()).find((c) => c.id === clinicId)!;
    expect(before.baaVersion).toBe("1.0.0");
    expect(goLivePreconditions(before)).toEqual({ ok: false, missing: [superseded] });
    expect(await goLive(clinicId, { label: "ops@healdesk.test" })).toEqual({ status: "refused", reason: "Not ready.", missing: [superseded] });

    // The database refuses on its own, and its sentence, not drizzle's
    // "Failed query", is what the console would show.
    const refused = await unsafeDb
      .execute(sql`select app_mark_clinic_production(${clinicId}::uuid) as signed`)
      .then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(DrizzleQueryError);
    const reason = refusalReason(refused);
    expect(reason).toContain("version 1.0.0, which has been superseded; refusing to mark it production.");
    expect(reason).toContain("The practice accepts the current agreement first");
    expect(reason).not.toMatch(/Failed query/);
    expect((await listClinics()).find((c) => c.id === clinicId)!.dataClassification).toBe("synthetic");

    // Once the practice has accepted the current version and it is bound, it
    // is the agreement in effect and go-live copies its date. Bound here as
    // the migrator: the re-acceptance path is a portal-build item, and
    // app_bind_agreement refuses a second agreement for an organisation.
    const { rows } = await getMigratorPool().query<{ accepted_at: Date }>(
      `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
       values ($1, $2, repeat('d', 64), 'BAA', '{}'::jsonb, 'I agree', 'Alex', 'alex@superseded.test', now(), now())
       returning accepted_at`,
      [organizationId, CURRENT_BAA_VERSION],
    );
    const live = await goLive(clinicId, { label: "ops@healdesk.test" });
    expect(live, JSON.stringify(live)).toEqual({ status: "live", baaSignedAt: rows[0]!.accepted_at });
  });

  test("go-live refuses a clinic that bought phone until it has a direct line", async () => {
    // CLAUDE.md, "Failure": every call AYA can't answer goes to the direct
    // line. The wizard lets it be skipped, and says phone can't go live
    // without it; go-live is where that holds.
    const { clinicId, organizationId } = await seedClinic("golive-line");
    await getMigratorPool().query(
      `update clinics
          set is_covered_entity = false,
              opening_hours = '{"mon":[["09:00","17:00"]]}'::jsonb,
              call_routing_confirmed_at = now(),
              agent_approved_at = now(),
              onboarding = jsonb_build_object(
                'hours_confirmed', now()::text, 'phone_type_confirmed', now()::text,
                'call_routing_chosen', now()::text, 'covered_entity_confirmed', now()::text,
                'agent_script_approved', now()::text, 'forwarding_configured', now()::text,
                'test_call_passed', now()::text, 'booking_requirements_confirmed', now()::text)
        where id = $1`,
      [clinicId],
    );
    await getMigratorPool().query(
      `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
       values ($1, $2, repeat('e', 64), 'BAA', '{}'::jsonb, 'I agree', 'Alex', 'alex@golive-line.test', now(), now())`,
      [organizationId, CURRENT_BAA_VERSION],
    );
    await seedChannels(clinicId, [{ channel: "voice" }]);

    const overview = (await listClinics()).find((c) => c.id === clinicId)!;
    expect(goLivePreconditions(overview, await readVoiceLine(clinicId))).toEqual({
      ok: false,
      missing: [NO_DIRECT_LINE],
    });
    expect(await goLive(clinicId, { label: "ops@healdesk.test" })).toEqual({
      status: "refused",
      reason: "Not ready.",
      missing: [NO_DIRECT_LINE],
    });

    await inTenant(clinicId, (c) =>
      c.query(`insert into clinic_settings (clinic_id, direct_line_e164) values ($1, '+14155550190')`, [
        clinicId,
      ]),
    );
    const live = await goLive(clinicId, { label: "ops@healdesk.test" });
    expect(live.status, JSON.stringify(live)).toBe("live");
  });

  test("the expiry fallback stamps source 'defaults' once the setup link has expired unspent", async () => {
    const { clinicId } = await seedClinic("defaults");
    const source = async () =>
      (await getMigratorPool().query<{ s: string | null; r: unknown }>(`select booking_requirements_source as s, booking_requirements as r from clinics where id = $1`, [clinicId])).rows[0]!;

    // Fresh clinic, no link: inside its grace, left alone.
    expect(await applyBookingRequirementDefaultsFor(clinicId)).toBe("not_yet");

    // An outstanding link: the practice may still answer.
    const { token } = await issueConnectionLink(clinicId, { purpose: "setup" }, { actor: ACTOR, request: {} });
    expect(await applyBookingRequirementDefaultsFor(clinicId)).toBe("link_outstanding");
    expect((await source()).s).toBeNull();

    // The link expires unspent (born expired, as connect-links.test.ts does it).
    await inTenant(clinicId, async (client) => {
      await client.query(`delete from connection_links where clinic_id = $1`, [clinicId]);
      await client.query(
        `insert into connection_links (clinic_id, token_hash, purpose, created_at, expires_at)
         values ($1, $2, 'setup', now() - interval '15 days', now() - interval '1 day')`,
        [clinicId, Buffer.from(token.padEnd(43, "x").slice(0, 32))],
      );
    });
    const applied = await applyBookingRequirementDefaults(new Date());
    expect(applied).toBeGreaterThanOrEqual(1);
    const row = await source();
    expect(row.s).toBe("defaults");
    expect(row.r).toBeNull();
    const state = await withTenant({ clinicId, actor: ACTOR }, readOnboarding);
    expect(state.booking_requirements_confirmed).not.toBeNull();

    // Idempotent: the next sweep stamps nothing again.
    expect(await applyBookingRequirementDefaultsFor(clinicId)).toBe("already_confirmed");
  });

  test("a clinic with no setup link at all gets the defaults after fourteen days", async () => {
    const { clinicId } = await seedClinic("defaults-nolink");
    await getMigratorPool().query(`update clinics set created_at = now() - interval '15 days' where id = $1`, [clinicId]);
    expect(await applyBookingRequirementDefaultsFor(clinicId)).toBe("applied");
    const { rows } = await getMigratorPool().query<{ s: string | null }>(`select booking_requirements_source as s from clinics where id = $1`, [clinicId]);
    expect(rows[0]!.s).toBe("defaults");
  });
});
