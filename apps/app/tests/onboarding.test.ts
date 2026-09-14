import { findClinicalContent, forwardingInstructions, openRequiredSteps } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  AgentConfigError,
  approveAgentConfig,
  defaultAgentConfig,
  getAgentConfig,
  seedAgentConfig,
  updateAgentConfig,
  validateAgentConfig,
} from "@/lib/onboarding/agent-config";
import { goLive, goLivePreconditions } from "@/lib/onboarding/go-live";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { completeStep, readOnboarding, reopenStep } from "@/lib/onboarding/steps";
import { listClinics } from "@/lib/ops/clinics";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { seedClinic } from "./setup/factories";

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
});

describe("open required steps", () => {
  test("platform_connected is required only for verified attribution", () => {
    const all = Object.fromEntries(["hours_confirmed","phone_type_confirmed","call_routing_chosen","covered_entity_confirmed","agent_script_approved","forwarding_configured","test_call_passed"].map((s) => [s, "2026-09-13T00:00:00Z"]));
    expect(openRequiredSteps(all)).toEqual([]);
    expect(openRequiredSteps(all, { requirePlatform: true })).toEqual(["platform_connected"]);
    expect(openRequiredSteps({})).toHaveLength(7);
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
       values ($1, '1.0.0', repeat('b', 64), 'BAA', '{}'::jsonb, 'I agree', 'Alex', 'alex@golive.test', now(), now())`,
      [organizationId],
    );
    await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { phoneSystemType: "landline", carrier: "verizon", callRouting: "conditional", synthflowNumberE164: "+14155550199" });
      await seedAgentConfig(tx, "med-spa", "Golive Clinic");
      await approveAgentConfig(tx, "Owner");
      await completeStep(tx, "hours_confirmed");
      await completeStep(tx, "covered_entity_confirmed");
      await completeStep(tx, "forwarding_configured");
      await completeStep(tx, "test_call_passed");
    });

    const live = await goLive(clinicId, { label: "ops@healdesk.test" });
    expect(live.status, JSON.stringify(live)).toBe("live");
    const after = (await listClinics()).find((c) => c.id === clinicId)!;
    expect(after.dataClassification).toBe("production");
    expect(after.wentLiveAt).not.toBeNull();
    const events = await getMigratorPool().query(`select count(*)::int as n from security_events where event = 'clinic_went_live'`);
    expect(events.rows[0].n).toBe(1);

    expect((await goLive(clinicId, { label: "ops@healdesk.test" })).status).toBe("refused");
  });
});
