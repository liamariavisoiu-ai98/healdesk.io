import {
  CURRENT_BAA_VERSION,
  currentBaaDocument,
  hashBaaText,
} from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  ProvisioningError,
  provisionClinic,
  validateProvisionRequest,
  type ProvisionRequest,
} from "@/lib/provisioning";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";

/**
 * Provisioning: turning a completed checkout into an account.
 *
 * The case that matters most is the DEFAULT one — a clinic with no booking
 * software, connecting nothing. If that path ever requires an integration
 * step, integration has crept back onto the critical path to revenue.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

function validRequest(overrides: Partial<ProvisionRequest> = {}): ProvisionRequest {
  return {
    clinicName: "Radiance Med Spa",
    specialty: "med-spa",
    platform: "none",
    attributionMode: "estimated",
    averageTreatmentValueUsd: 550,
    plan: "core",
    contactName: "Alex Chen",
    contactEmail: "alex@radiance.test",
    baaVersion: CURRENT_BAA_VERSION,
    baaAccepted: true,
    ...overrides,
  };
}

describe("provision request validation", () => {
  test("accepts the default path: no platform, estimated attribution", () => {
    expect(() => validateProvisionRequest(validRequest())).not.toThrow();
  });

  test("requires an average treatment value for estimated attribution", () => {
    // It is the only input to the figures we report. Without it the first
    // monthly report would have nothing to say.
    expect(() =>
      validateProvisionRequest(
        validRequest({ averageTreatmentValueUsd: undefined }),
      ),
    ).toThrow(ProvisioningError);
  });

  test("refuses verified attribution when there is nothing to read from", () => {
    expect(() =>
      validateProvisionRequest(
        validRequest({ platform: "none", attributionMode: "verified" }),
      ),
    ).toThrow(/nothing for us to read from|has none/i);
  });

  test("allows verified attribution on a connectable platform", () => {
    expect(() =>
      validateProvisionRequest(
        validRequest({
          platform: "boulevard",
          attributionMode: "verified",
          averageTreatmentValueUsd: undefined,
        }),
      ),
    ).not.toThrow();
  });

  test("refuses an unaccepted agreement", () => {
    expect(() =>
      validateProvisionRequest(validRequest({ baaAccepted: false })),
    ).toThrow(/business associate agreement/i);
  });

  test("refuses a stale agreement version", () => {
    // Someone left a tab open across a revision — make them read it again
    // rather than record acceptance of a document they never saw.
    expect(() =>
      validateProvisionRequest(validRequest({ baaVersion: "0.0.0-ancient" })),
    ).toThrow(ProvisioningError);
  });

  test("rejects unknown platforms, plans and specialties", () => {
    expect(() =>
      validateProvisionRequest(validRequest({ platform: "epic" })),
    ).toThrow(/platform/i);
    expect(() =>
      validateProvisionRequest(validRequest({ plan: "enterprise" })),
    ).toThrow(/plan/i);
    expect(() =>
      validateProvisionRequest(validRequest({ specialty: "veterinary" })),
    ).toThrow(/specialty/i);
  });
});

describeDb("provisioning", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("the default path completes with zero integration steps", async () => {
    const result = await provisionClinic(validRequest());

    expect(result.clinicSlug).toBe("radiance-med-spa");
    expect(result.clinicId).toBeTruthy();

    const { rows } = await getMigratorPool().query<{
      attribution_mode: string;
      booking_provider: string | null;
      average_treatment_value_usd: string | null;
      data_classification: string;
      plan: string;
    }>(
      `select attribution_mode, booking_provider, average_treatment_value_usd,
              data_classification, plan
         from clinics where id = $1`,
      [result.clinicId],
    );

    const clinic = rows[0]!;
    expect(clinic.attribution_mode).toBe("estimated");
    expect(clinic.booking_provider).toBeNull();
    expect(clinic.average_treatment_value_usd).toBe("550.00");
    expect(clinic.plan).toBe("core");

    // Always synthetic at creation, whatever the buyer ticked. Moving to
    // production requires a signed BAA and is a separate, deliberate act.
    expect(clinic.data_classification).toBe("synthetic");
  });

  test("records the agreement with its version and a hash of the exact text", async () => {
    const result = await provisionClinic(
      validRequest({ contactEmail: "owner@hashcheck.test" }),
    );

    const { rows } = await getMigratorPool().query<{
      document_version: string;
      document_hash: string;
      accepted_by_email: string;
      accepted_by_name: string;
      user_id: string | null;
    }>(
      `select document_version, document_hash, accepted_by_email,
              accepted_by_name, user_id
         from baa_acceptances where organization_id = $1`,
      [result.organizationId],
    );

    const acceptance = rows[0]!;
    expect(acceptance.document_version).toBe(CURRENT_BAA_VERSION);
    // The hash is what makes "what did they actually agree to" survive a later
    // revision of the document.
    expect(acceptance.document_hash).toBe(
      hashBaaText(currentBaaDocument().text),
    );
    expect(acceptance.accepted_by_email).toBe("owner@hashcheck.test");
    expect(acceptance.accepted_by_name).toBe("Alex Chen");
    // The user does not exist yet — the frozen columns carry the record.
    expect(acceptance.user_id).toBeNull();
  });

  test("the acceptance record cannot be altered by the runtime role", async () => {
    // A BAA acceptance the application can edit afterwards is not evidence.
    const { Pool } = await import("pg");
    const app = new Pool({ connectionString: process.env.TEST_APP_URL });
    try {
      await expect(
        app.query(`update baa_acceptances set accepted_by_name = 'someone else'`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        app.query(`delete from baa_acceptances`),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end();
    }
  });

  test("invites the buyer rather than creating an account for them", async () => {
    const result = await provisionClinic(
      validRequest({ contactEmail: "invitee@example.test" }),
    );

    const { rows: invites } = await getMigratorPool().query<{
      email: string;
      status: string;
      role: string;
    }>(`select email, status, role from invitation where id = $1`, [
      result.invitationId,
    ]);

    expect(invites[0]).toMatchObject({
      email: "invitee@example.test",
      status: "pending",
      role: "owner",
    });

    // Sign-up is closed; no user exists until the invite is accepted.
    const { rows: users } = await getMigratorPool().query(
      `select id from "user" where email = $1`,
      ["invitee@example.test"],
    );
    expect(users).toHaveLength(0);
  });

  test("gives colliding clinic names distinct slugs", async () => {
    const first = await provisionClinic(
      validRequest({ clinicName: "Glow Clinic", contactEmail: "a@glow.test" }),
    );
    const second = await provisionClinic(
      validRequest({ clinicName: "Glow Clinic", contactEmail: "b@glow.test" }),
    );

    expect(first.clinicSlug).toBe("glow-clinic");
    expect(second.clinicSlug).not.toBe(first.clinicSlug);
    expect(second.clinicSlug).toMatch(/^glow-clinic-/);
  });

  test("a provisioned clinic accepts synthetic data immediately", async () => {
    const result = await provisionClinic(
      validRequest({ contactEmail: "phi@example.test" }),
    );

    // The BAA gate allows writes to a 'synthetic' clinic, so the product is
    // testable end to end without implying a real patient anywhere.
    const pool = getMigratorPool();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [
        result.clinicId,
      ]);
      await expect(
        client.query(
          `insert into contacts (clinic_id, phone) values ($1, '+15550100002')`,
          [result.clinicId],
        ),
      ).resolves.toBeTruthy();
      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});
