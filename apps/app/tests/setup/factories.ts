import { randomUUID } from "node:crypto";

import { getMigratorPool } from "./db";

/**
 * Synthetic fixtures.
 *
 * Everything here is invented. Clinics are created with the default
 * `data_classification = 'synthetic'`, so the BAA gate in
 * drizzle/0004_baa_gate.sql lets PHI-shaped writes through — which is the whole
 * point of that column: tests exercise the real tables without ever implying
 * real patients.
 *
 * Seeding runs as the MIGRATOR, and follows the provisioning sequence the RLS
 * policies require: insert the clinic (not FORCEd), then set the tenant, then
 * insert everything that is.
 */

export type SeededClinic = {
  clinicId: string;
  organizationId: string;
  slug: string;
  staffUserId: string;
  staffEmail: string;
};

export async function seedClinic(label: string): Promise<SeededClinic> {
  const pool = getMigratorPool();
  const organizationId = `org_${label}_${randomUUID().slice(0, 8)}`;
  const staffUserId = `usr_${label}_${randomUUID().slice(0, 8)}`;
  const staffEmail = `${label}@example-clinic.test`;
  const slug = `${label}-${randomUUID().slice(0, 6)}`;

  await pool.query(
    `insert into organization (id, name, slug, created_at) values ($1, $2, $3, now())`,
    [organizationId, `${label} Group`, `${slug}-org`],
  );

  await pool.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, $2, $3, true, now(), now())`,
    [staffUserId, `${label} staff`, staffEmail],
  );

  const { rows } = await pool.query<{ id: string }>(
    `insert into clinics (organization_id, slug, name, specialty)
     values ($1, $2, $3, 'med-spa')
     returning id`,
    [organizationId, slug, `${label} Clinic`],
  );
  const clinicId = rows[0]!.id;

  // clinic_memberships IS forced, so declare the tenant before writing to it.
  await inTenant(clinicId, async (client) => {
    await client.query(
      `insert into clinic_memberships (clinic_id, user_id, role) values ($1, $2, 'owner')`,
      [clinicId, staffUserId],
    );
  });

  return { clinicId, organizationId, slug, staffUserId, staffEmail };
}

/** Insert a contact as the migrator, inside a declared tenant. */
export async function seedContact(
  clinicId: string,
  phone = "+15550100000",
): Promise<string> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into contacts (clinic_id, phone, full_name)
       values ($1, $2, 'Synthetic Patient') returning id`,
      [clinicId, phone],
    );
    return rows[0]!.id;
  });
}

/** The ways a contact can be one the clinic would otherwise have lost. */
export type RecoveryReason =
  | "after_hours"
  | "line_busy"
  | "rang_unanswered"
  | "missed_call_callback";

/**
 * A conversation the agent handled, optionally one it recovered.
 *
 * `recovered: true` is shorthand for a missed-call callback, which keeps the
 * existing call sites readable. Pass `recoveryReason` instead to seed one of
 * the other three — the report counts all of them, so a test that only ever
 * seeds callbacks cannot tell whether the broader definition actually works.
 */
export async function seedConversation(
  clinicId: string,
  options: {
    startedAt: Date;
    recovered?: boolean;
    recoveryReason?: RecoveryReason;
    booked?: boolean;
    contactId?: string;
  },
): Promise<{ conversationId: string; appointmentId: string | null }> {
  const recoveryReason =
    options.recoveryReason ??
    (options.recovered ? "missed_call_callback" : null);

  return inTenant(clinicId, async (client) => {
    const { rows: convo } = await client.query<{ id: string }>(
      `insert into conversations
         (clinic_id, channel, recovery_reason, outcome, started_at, contact_id)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [
        clinicId,
        "voice",
        recoveryReason,
        options.booked ? "booked" : "qualified_no_booking",
        options.startedAt,
        options.contactId ?? null,
      ],
    );
    const conversationId = convo[0]!.id;

    if (!options.booked) return { conversationId, appointmentId: null };

    const contactId =
      options.contactId ??
      (
        await client.query<{ id: string }>(
          `insert into contacts (clinic_id, phone) values ($1, $2) returning id`,
          [clinicId, `+1555${Math.floor(Math.random() * 10_000_000)}`],
        )
      ).rows[0]!.id;

    const { rows: appt } = await client.query<{ id: string }>(
      `insert into appointments
         (clinic_id, contact_id, conversation_id, scheduled_for)
       values ($1, $2, $3, $4)
       returning id`,
      [clinicId, contactId, conversationId, options.startedAt],
    );

    return { conversationId, appointmentId: appt[0]!.id };
  });
}

/** Set the clinic's average appointment value, as checkout would. */
export async function setAverageTreatmentValue(
  clinicId: string,
  value: number | null,
): Promise<void> {
  await getMigratorPool().query(
    `update clinics set average_treatment_value_usd = $2 where id = $1`,
    [clinicId, value],
  );
}

/**
 * Run a callback on a migrator connection with the tenant GUC set, using the
 * same transaction-local mechanism the application uses.
 */
export async function inTenant<T>(
  clinicId: string,
  fn: (client: {
    query: <R extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ) => Promise<{ rows: R[] }>;
  }) => Promise<T>,
): Promise<T> {
  const client = await getMigratorPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [
      clinicId,
    ]);
    const result = await fn(client as never);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
