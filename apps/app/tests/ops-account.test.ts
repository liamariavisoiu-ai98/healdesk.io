import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedContact } from "./setup/factories";
import { provisionPortalClinic } from "./setup/portal-clinic";

/**
 * The console's account operations (plan Part K, D5 and L): the clinic's
 * address and changeClinicEmail, setCoveredEntity, the clinic cards and the
 * site-read failures. Each is a projection apps/app decides; none carries a
 * patient row.
 */

const sent = vi.hoisted(() => ({ to: [] as string[], texts: [] as string[] }));
vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return {
    ...actual,
    sendEmail: (
      email: Parameters<typeof actual.sendEmail>[0],
      options: Parameters<typeof actual.sendEmail>[1] = {},
    ) =>
      actual.sendEmail(email, {
        ...options,
        transport: {
          name: "fake",
          send: async (target, message) => {
            sent.to.push(target.to);
            sent.texts.push(message.text);
            return { status: "sent", messageId: `msg_${sent.to.length}` };
          },
        },
      }),
  };
});

const { isMutating, isOpName, parseEnvelope, runOperation } = await import("@/lib/ops/api");

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR = { email: "ops@healdesk.test", request: {} };
const ORIGIN = "https://app.healdesk.test";

async function op(name: string, args: Record<string, unknown> = {}) {
  const parsed = parseEnvelope(JSON.stringify({ op: name, args }));
  if (!parsed.ok) throw new Error(`${name} is not an operation`);
  const outcome = await runOperation(parsed.envelope.op, parsed.envelope.args, OPERATOR);
  return outcome as { status: number; body: { data?: Record<string, unknown>; error?: string } };
}

async function events(name: string) {
  const { rows } = await getMigratorPool().query<{
    actor_label: string;
    metadata: Record<string, unknown>;
  }>(`select actor_label, metadata from security_events where event = $1 order by occurred_at`, [
    name,
  ]);
  return rows;
}

/** As the runtime role, in the clinic's tenant: does the PHI gate take a patient row? */
async function acceptsPhi(clinicId: string): Promise<boolean> {
  const client = await getAppPool().connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      `select app_clinic_accepts_phi($1) as ok`,
      [clinicId],
    );
    return rows[0]!.ok;
  } finally {
    client.release();
  }
}

describe("the account operations are on the list", () => {
  test("three writes and three reads", () => {
    for (const name of ["changeClinicEmail", "stopClinicEmailChange", "setCoveredEntity"]) {
      expect(isOpName(name), name).toBe(true);
      expect(isMutating(name as never), name).toBe(true);
    }
    for (const name of ["getClinicSignIn", "listClinicCards", "listSiteReadFailures"]) {
      expect(isOpName(name), name).toBe(true);
      expect(isMutating(name as never), name).toBe(false);
    }
  });
});

describeDb("the account operations", () => {
  beforeAll(async () => {
    await runMigrations();
    process.env.BETTER_AUTH_URL = ORIGIN;
  });

  beforeEach(async () => {
    await truncateAll();
    sent.to.length = 0;
    sent.texts.length = 0;
  });

  afterAll(async () => {
    await closePools();
  });

  test("changeClinicEmail: in effect 72 hours on, O5 to both addresses, shown on the sign-in view, and stopped on an objection", async () => {
    const clinic = await seedClinic("opsaddr");
    const before = Date.now();
    const entered = await op("changeClinicEmail", {
      clinicId: clinic.clinicId,
      newEmail: "Front@Radiance.test",
    });
    expect(entered.status).toBe(200);
    expect(entered.body.data).toMatchObject({
      status: "entered",
      newEmail: "front@radiance.test",
      emailed: true,
    });
    const effectiveAt = Date.parse(String(entered.body.data!.effectiveAt));
    expect(effectiveAt - before).toBeGreaterThan(72 * 3_600_000 - 60_000);
    expect(sent.to).toEqual([clinic.staffEmail, "front@radiance.test"]);
    const entry = await events("sign_in_address_change_entered");
    expect(entry).toHaveLength(1);
    expect(entry[0]!.actor_label).toBe("ops@healdesk.test");

    const view = await op("getClinicSignIn", { clinicId: clinic.clinicId });
    expect(view.body.data).toMatchObject({
      address: clinic.staffEmail,
      changes: [
        {
          status: "pending",
          source: "operator",
          newEmail: "front@radiance.test",
          requestedBy: "ops@healdesk.test",
        },
      ],
    });

    expect(
      (await op("changeClinicEmail", { clinicId: clinic.clinicId, newEmail: "desk@radiance.test" }))
        .body.data,
    ).toMatchObject({
      status: "refused",
    });
    expect((await op("stopClinicEmailChange", { clinicId: clinic.clinicId })).body.data).toEqual({
      status: "stopped",
    });
    expect((await op("stopClinicEmailChange", { clinicId: clinic.clinicId })).body.data).toEqual({
      status: "none",
    });
    const stopped = await events("sign_in_address_change_stopped");
    expect(stopped[0]!.metadata).toMatchObject({ stoppedBy: "operator" });
  });

  test("setCoveredEntity refuses a veterinary practice", async () => {
    const vet = await seedClinic("opsvet");
    await getMigratorPool().query(
      `update clinics set specialty = 'veterinary', regulatory_regime = 'non-hipaa', agreement_kind = 'dpa', is_covered_entity = false where id = $1`,
      [vet.clinicId],
    );
    const outcome = await op("setCoveredEntity", { clinicId: vet.clinicId, answer: "yes" });
    expect(outcome.body.data).toMatchObject({ status: "refused" });
    const { rows } = await getMigratorPool().query<{ covered: boolean | null }>(
      `select is_covered_entity as covered from clinics where id = $1`,
      [vet.clinicId],
    );
    expect(rows[0]!.covered).toBe(false);
  });

  test("setCoveredEntity on a BAA clinic records the answer and nothing else", async () => {
    const clinic = await seedClinic("opsbaa");
    await getMigratorPool().query(
      `update clinics set regulatory_regime = 'hipaa-if-covered', agreement_kind = 'baa', is_covered_entity = null where id = $1`,
      [clinic.clinicId],
    );
    const outcome = await op("setCoveredEntity", { clinicId: clinic.clinicId, answer: "no" });
    expect(outcome.body.data).toEqual({
      status: "recorded",
      agreementKind: "baa",
      isCoveredEntity: false,
      covered: true,
      supersedeStarted: false,
      linkSent: false,
      auditRecorded: true,
    });
    expect(await events("agreement_supersede_started")).toEqual([]);
    expect((await events("covered_entity_recorded"))[0]!.metadata).toMatchObject({
      clinicId: clinic.clinicId,
      coveredEntity: false,
    });
    expect(
      (await op("setCoveredEntity", { clinicId: clinic.clinicId, answer: "maybe" })).body.data,
    ).toMatchObject({
      status: "refused",
    });
  });

  test("setCoveredEntity on a DPA clinic that is now covered closes the PHI gate and starts the supersede", async () => {
    const clinic = await seedClinic("opsdpa");
    const agreementId = randomUUID();
    const acceptedAt = new Date(Date.now() - 86_400_000);
    await getMigratorPool().query(
      `insert into baa_acceptances
         (id, organization_id, document_version, document_hash, rendered_text, variables,
          assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
       values ($1, $2, 'dpa/1.0.0', repeat('a', 64), 'DPA (test)', '{}'::jsonb, 'I agree',
               'Alex Chen', 'alex@practice.test', $3, $3)`,
      [agreementId, clinic.organizationId, acceptedAt],
    );
    await getMigratorPool().query(
      `update clinics
          set regulatory_regime = 'hipaa-if-covered', agreement_kind = 'dpa', is_covered_entity = false,
              data_classification = 'production', baa_signed_at = $2
        where id = $1`,
      [clinic.clinicId, acceptedAt],
    );
    expect(await acceptsPhi(clinic.clinicId)).toBe(true);
    await expect(seedContact(clinic.clinicId, "+15550190101")).resolves.toBeTruthy();

    const outcome = await op("setCoveredEntity", { clinicId: clinic.clinicId, answer: "yes" });
    expect(outcome.body.data).toMatchObject({
      status: "recorded",
      agreementKind: "dpa",
      isCoveredEntity: true,
      covered: false,
      supersedeStarted: true,
      // L22 went to the practice with its re-sign link (WP9, lib/agreements/resign.ts).
      linkSent: true,
    });
    expect(await acceptsPhi(clinic.clinicId)).toBe(false);
    await expect(seedContact(clinic.clinicId, "+15550190102")).rejects.toMatchObject({
      code: "23514",
    });
    const started = await events("agreement_supersede_started");
    expect(started).toHaveLength(1);
    expect(started[0]!.metadata).toMatchObject({
      clinicId: clinic.clinicId,
      fromAgreementId: agreementId,
      fromKind: "dpa",
      toKind: "baa",
      reason: "now_covered",
    });

    // "Not sure" is no cover for a DPA either; "No" again restores it.
    expect(
      (await op("setCoveredEntity", { clinicId: clinic.clinicId, answer: "not_sure" })).body.data,
    ).toMatchObject({
      covered: false,
      supersedeStarted: true,
    });
    expect(
      (await op("setCoveredEntity", { clinicId: clinic.clinicId, answer: "no" })).body.data,
    ).toMatchObject({
      covered: true,
      supersedeStarted: false,
    });
    expect(await acceptsPhi(clinic.clinicId)).toBe(true);
  });

  test("the clinic cards: each bought channel's state, the tracker without its detail, and the agreement label", async () => {
    const portal = await provisionPortalClinic("opscards", { plan: "voice-metachat-1000-1000" });
    const bare = await seedClinic("opscards-bare");
    const outcome = await op("listClinicCards");
    expect(outcome.status).toBe(200);
    const cards = outcome.body.data!.cards as {
      id: string;
      agreementKind: string | null;
      agreementLabel: string;
      channels: { channel: string; status: string }[];
      tracker: { id: string; label: string; state: string }[];
      trackerLeft: string[];
    }[];
    const card = cards.find((c) => c.id === portal.clinicId)!;
    expect(card.agreementKind).toBe("baa");
    expect(card.agreementLabel).toBe("Business associate agreement");
    expect(card.channels.map((c) => c.channel)).toEqual(["web", "meta", "voice"]);
    expect(card.channels.every((c) => c.status === "setting_up")).toBe(true);
    expect(card.tracker.map((s) => s.id)).toEqual([
      "agreement",
      "payment",
      "website",
      "answers",
      "calendar",
      "built",
      "practice_questions",
    ]);
    expect(card.tracker[0]).toEqual({ id: "agreement", label: "Agreement signed", state: "done" });
    expect(card.trackerLeft).toContain("Assistant built");
    // Projections only: no stage's detail, no address, no calendar account.
    const json = JSON.stringify(cards);
    expect(json).not.toContain("detail");
    expect(json).not.toContain(portal.email);
    expect(json).not.toContain("@");
    expect(cards.find((c) => c.id === bare.clinicId)).toMatchObject({
      agreementKind: null,
      agreementLabel: "No agreement recorded",
      channels: [],
    });
  });

  test("the site-read failures: purchases whose read failed, and whether a profile arrived since", async () => {
    const clinic = await seedClinic("opsread");
    const ref = randomUUID();
    await getMigratorPool().query(
      `insert into checkout_intents
         (ref, payload, agreement_id, contact_email, plan, billing_interval, expires_at,
          profile_status, consumed_at, provisioned_clinic_id)
       values ($1, $2::jsonb, $3, 'buyer@radiance.test', 'voice-100', 'month', now() + interval '1 day',
               'failed', now(), $4)`,
      [
        ref,
        JSON.stringify({ clinicName: "Radiance Med Spa", website: "https://radiance.test" }),
        randomUUID(),
        clinic.clinicId,
      ],
    );
    await getMigratorPool().query(
      `insert into checkout_intents
         (ref, payload, agreement_id, contact_email, plan, billing_interval, expires_at, profile_status)
       values ($1, '{"clinicName":"Read Fine"}'::jsonb, $2, 'other@fine.test', 'voice-100', 'month', now() + interval '1 day', 'read')`,
      [randomUUID(), randomUUID()],
    );
    const first = await op("listSiteReadFailures");
    expect(first.body.data!.failures).toEqual([
      expect.objectContaining({
        ref,
        clinicName: "Radiance Med Spa",
        website: "https://radiance.test",
        clinicId: clinic.clinicId,
        profileSince: false,
      }),
    ]);
    expect(JSON.stringify(first.body.data)).not.toContain("buyer@radiance.test");

    await inTenant(clinic.clinicId, (c) =>
      c.query(`update clinics set site_profile = $2::jsonb where id = $1`, [
        clinic.clinicId,
        JSON.stringify({ website: "https://radiance.test" }),
      ]),
    );
    const second = await op("listSiteReadFailures");
    expect((second.body.data!.failures as { profileSince: boolean }[])[0]!.profileSince).toBe(true);
  });
});
