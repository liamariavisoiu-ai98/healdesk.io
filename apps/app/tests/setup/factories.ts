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

  // Better Auth's org-level row, as provisioning writes it (design D3).
  // app_user_clinic_grants walks only the clinics in a user's own
  // organisations, so a grant with no member row is invisible to the portal.
  await pool.query(
    `insert into member (id, organization_id, user_id, role, created_at)
     values ($1, $2, $3, 'owner', now())`,
    [`mem_${label}_${randomUUID().slice(0, 8)}`, organizationId, staffUserId],
  );

  // clinic_memberships IS forced, so declare the tenant before writing to it.
  await inTenant(clinicId, async (client) => {
    await client.query(
      `insert into clinic_memberships (clinic_id, user_id, role) values ($1, $2, 'owner')`,
      [clinicId, staffUserId],
    );
  });

  return { clinicId, organizationId, slug, staffUserId, staffEmail };
}

export type ClinicRole = "owner" | "admin" | "clinician" | "front_desk" | "billing" | "read_only";

/**
 * Another person with a grant on an existing clinic: a user, a `member` row in
 * the clinic's organisation and an active clinic_memberships row with `role`.
 * The portal's three roles are owner, admin (the spec's manager) and billing.
 */
export async function seedPortalUser(
  clinicId: string,
  role: ClinicRole,
  options: { label?: string; memberRole?: string } = {},
): Promise<{ userId: string; email: string }> {
  const pool = getMigratorPool();
  const label = options.label ?? role;
  const suffix = randomUUID().slice(0, 8);
  const userId = `usr_${label}_${suffix}`;
  const email = `${label}-${suffix}@example-clinic.test`;

  const { rows } = await pool.query<{ organization_id: string }>(
    `select organization_id from clinics where id = $1`,
    [clinicId],
  );
  const organizationId = rows[0]?.organization_id;
  if (!organizationId) throw new Error(`seedPortalUser: no clinic ${clinicId}`);

  await pool.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, $2, $3, true, now(), now())`,
    [userId, `${label} person`, email],
  );
  await pool.query(
    `insert into member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, $4, now())`,
    [`mem_${label}_${suffix}`, organizationId, userId, options.memberRole ?? (role === "owner" ? "owner" : "member")],
  );
  await inTenant(clinicId, async (client) => {
    await client.query(
      `insert into clinic_memberships (clinic_id, user_id, role) values ($1, $2, $3::clinic_role)`,
      [clinicId, userId, role],
    );
  });
  return { userId, email };
}

export type SeedChannelRow = {
  channel: "web" | "meta" | "voice";
  /** The Settings On/Off. Default true. */
  enabled?: boolean;
  readyAt?: Date | null;
  waitingOn?: "setup" | "forwarding" | "snippet" | "meta_connect" | "whatsapp_payment_method" | null;
  liveAt?: Date | null;
  firstAnswerAt?: Date | null;
};

export type SeedEntitledOptions = {
  /** The package on `plan_code`: the one Stripe bills. Default "complete". */
  planId?: string;
  /**
   * The package bought (`bought_plan_id`), which decides `channels_enabled`.
   * Default: `planId`. Not with `legacy`.
   */
  boughtPlanId?: string;
  interval?: "month" | "year";
  /**
   * false: the no-Stripe path (no ids, seeded straight to active). Otherwise
   * Stripe ids are invented unless given, the row starts in `provisioning`
   * and is moved to `active` as the first paid invoice would.
   */
  stripe?: false | { customerId?: string; subscriptionId?: string };
  /**
   * The first invoice, through `recordFirstInvoice`: the setup fee, paid at
   * `periodStart`. On a legacy row its period also opens the allowance
   * window, as it did before the deferred start; on any other row it opens
   * none (the $0 placeholder buys no period). Default: a period starting
   * 2026-10-01.
   */
  firstInvoice?: false | { periodStart?: Date; periodEnd?: Date; setupFeePaidUsd?: number };
  /** Leave the row in `provisioning` instead of moving it to `active`. */
  status?: "active" | "provisioning";
  locations?: number;
  /**
   * The first plan invoice was paid then: stamps `plan_started_at`, opens the
   * first allowance window from it through `allowanceWindow` (an annual
   * plan's first month) and sets `paid_through` to the end of the period
   * bought. Not with `legacy`.
   */
  planStartedAt?: Date;
  /** The plan-start worker's Stripe update went through then (R8). Not with `legacy`. */
  planStartAppliedAt?: Date;
  /** The first plan invoice's id (R9). Not with `legacy`. */
  firstPlanInvoiceId?: string;
  setupDeadlineAt?: Date;
  /** clinic_channels rows on this clinic (seedChannels). */
  channelRows?: SeedChannelRow[];
  /**
   * The row as written before the deferred start: no bought package, so
   * `channels_enabled` follows `plan_code`, and the first invoice opens the
   * allowance window. What every fixture got before 6 October 2026.
   */
  legacy?: boolean;
};

/**
 * An entitlements row for a seeded clinic, written through the real writers
 * (seedEntitlements, applyBoughtPlan, recordFirstInvoice, transition and the
 * deferred start's writers) on the RUNTIME role inside the clinic's tenant,
 * so the fixture obeys the same grants and edges production does. Imported
 * lazily so suites that never call it do not open the application's own
 * pool.
 *
 * The default is a clinic bought under the deferred start whose plan has not
 * started: `bought_plan_id` set, the setup fee paid, `active`, and no
 * allowance window. `planStartedAt` starts it; `legacy: true` writes the row
 * every fixture got before 6 October 2026.
 */
export async function seedEntitled(
  clinicId: string,
  options: SeedEntitledOptions = {},
): Promise<{ stripeCustomerId: string | null; stripeSubscriptionId: string | null }> {
  const [{ getPlan }, writers, { transition }, { withTenant }, { entitlements }, { eq }] =
    await Promise.all([
      import("@healdesk/catalog"),
      import("@/lib/billing/entitlements"),
      import("@/lib/billing/state-machine"),
      import("@/lib/tenant"),
      import("@/db/schema"),
      import("drizzle-orm"),
    ]);

  if (
    options.legacy &&
    (options.boughtPlanId !== undefined ||
      options.planStartedAt !== undefined ||
      options.planStartAppliedAt !== undefined ||
      options.firstPlanInvoiceId !== undefined)
  ) {
    throw new Error("seedEntitled: a legacy row has no bought package and no plan start.");
  }
  const plan = getPlan(options.planId ?? "complete");
  if (!plan) throw new Error(`seedEntitled: no plan ${options.planId}`);
  const bought = options.legacy ? null : getPlan(options.boughtPlanId ?? plan.id);
  if (!options.legacy && !bought) throw new Error(`seedEntitled: no plan ${options.boughtPlanId}`);
  const interval = options.interval ?? "month";
  const suffix = randomUUID().replace(/-/g, "").slice(0, 14);
  const stripeCustomerId = options.stripe === false ? null : (options.stripe?.customerId ?? `cus_test${suffix}`);
  const stripeSubscriptionId =
    options.stripe === false ? null : (options.stripe?.subscriptionId ?? `sub_test${suffix}`);

  await withTenant({ clinicId, actor: { type: "service", serviceName: "test-fixture" } }, async (tx) => {
    const status = await writers.seedEntitlements(tx.db, clinicId, {
      plan,
      interval,
      stripeCustomerId,
      stripeSubscriptionId,
    });
    if (bought) await writers.applyBoughtPlan(tx.db, clinicId, bought);
    if (options.firstInvoice !== false) {
      const periodStart = options.firstInvoice?.periodStart ?? new Date("2026-10-01T00:00:00Z");
      const periodEnd =
        options.firstInvoice?.periodEnd ??
        new Date(Date.UTC(periodStart.getUTCFullYear() + (interval === "year" ? 1 : 0), periodStart.getUTCMonth() + (interval === "year" ? 0 : 1), periodStart.getUTCDate()));
      await writers.recordFirstInvoice(tx.db, clinicId, {
        periodStart,
        periodEnd,
        setupFeePaidUsd: options.firstInvoice?.setupFeePaidUsd ?? (bought ?? plan).setupFeeUsd,
        paidAt: periodStart,
      });
    }
    if (status === "provisioning" && (options.status ?? "active") === "active") {
      await transition(tx, "active", { actor: "system", reason: "invoice.paid" });
    }
    if (options.locations !== undefined) {
      await writers.setLocations(tx.db, clinicId, options.locations);
    }
    if (options.setupDeadlineAt !== undefined) {
      await writers.setSetupDeadline(tx.db, clinicId, options.setupDeadlineAt);
    }
    if (options.planStartedAt !== undefined) {
      const start = options.planStartedAt;
      const end = writers.addMonthsUtc(start, interval === "year" ? 12 : 1);
      await writers.markPlanStarted(tx.db, clinicId, start);
      await writers.openAllowanceWindow(tx.db, clinicId, { start, end });
      await tx.db.update(entitlements).set({ paidThrough: end }).where(eq(entitlements.clinicId, clinicId));
    }
    if (options.planStartAppliedAt !== undefined) {
      await writers.markPlanStartApplied(tx.db, clinicId, options.planStartAppliedAt);
    }
    if (options.firstPlanInvoiceId !== undefined) {
      await writers.markFirstPlanInvoice(tx.db, clinicId, options.firstPlanInvoiceId);
    }
  });

  if (options.channelRows?.length) await seedChannels(clinicId, options.channelRows);

  return { stripeCustomerId, stripeSubscriptionId };
}

/**
 * clinic_channels rows for a clinic (a billing clinic or one of its
 * locations), on the RUNTIME role inside its tenant, as provisioning and the
 * channel lifecycle write them.
 */
export async function seedChannels(clinicId: string, rows: readonly SeedChannelRow[]): Promise<void> {
  const [{ withTenant }, { clinicChannels }] = await Promise.all([
    import("@/lib/tenant"),
    import("@/db/schema"),
  ]);
  await withTenant({ clinicId, actor: { type: "service", serviceName: "test-fixture" } }, async (tx) => {
    await tx.db.insert(clinicChannels).values(
      rows.map((row) => ({
        clinicId,
        channel: row.channel,
        enabled: row.enabled ?? true,
        readyAt: row.readyAt ?? null,
        waitingOn: row.waitingOn ?? null,
        liveAt: row.liveAt ?? null,
        firstAnswerAt: row.firstAnswerAt ?? null,
      })),
    );
  });
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
