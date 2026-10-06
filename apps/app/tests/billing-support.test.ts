import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { getEntitlements, recordOpenInvoice, setGrace } from "@/lib/billing/entitlements";
import { closeUnfinishedSetup } from "@/lib/billing/requests";
import { transition } from "@/lib/billing/state-machine";
import { extendSetupDeadline, liftSuspension } from "@/lib/billing/support";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedEntitled } from "./setup/factories";

/**
 * The library behind the console's billing support operations (R35):
 * lifting a suspension and extending the setup window. The location and
 * overage retries are tested beside the actions they resume
 * (add-location.test.ts, annual-overage.test.ts).
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

const actor = { type: "service", serviceName: "billing-support-test" } as const;
const NOW = new Date("2026-10-10T12:00:00Z");

async function rowOf(clinicId: string) {
  const row = await withTenant({ clinicId, actor }, (tx) => getEntitlements(tx.db, clinicId));
  if (!row) throw new Error("no entitlements");
  return row;
}

async function suspended(label: string) {
  const { clinicId } = await seedClinic(label);
  await seedEntitled(clinicId, {
    planId: "chat-web",
    planStartedAt: new Date("2026-09-01T00:00:00Z"),
  });
  await withTenant({ clinicId, actor }, async (tx) => {
    await transition(tx, "past_due", { actor: "system", reason: "invoice.payment_failed" });
    await setGrace(tx.db, clinicId, new Date("2026-10-01T00:00:00Z"));
    await transition(tx, "suspended", { actor: "system", reason: "grace_expired" });
  });
  return clinicId;
}

describeDb("billing support operations", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  describe("liftSuspension", () => {
    test("refused while an invoice is open: paying it is the way back", async () => {
      const clinicId = await suspended("lift-open");
      await withTenant({ clinicId, actor }, (tx) =>
        recordOpenInvoice(tx.db, clinicId, {
          invoiceId: "in_open_lift",
          url: null,
          amountDueCents: 39_700,
        }),
      );
      expect(
        await liftSuspension({
          clinicId,
          reason: "Dispute withdrawn",
          actorLabel: "ops@healdesk.test",
        }),
      ).toMatchObject({
        status: "refused",
        message: expect.stringMatching(/invoice is still open/),
      });
      expect((await rowOf(clinicId)).status).toBe("suspended");
    });

    test("lifts a suspension with nothing owed, through the state machine, as support, with the reason on record", async () => {
      const clinicId = await suspended("lift-ok");
      expect(
        await liftSuspension({
          clinicId,
          reason: "Dispute withdrawn by the bank",
          actorLabel: "ops@healdesk.test",
        }),
      ).toEqual({ status: "lifted" });
      expect(await rowOf(clinicId)).toMatchObject({ status: "active", graceEndsAt: null });
      const history = await inTenant(
        clinicId,
        async (c) =>
          (
            await c.query<{
              from_status: string;
              to_status: string;
              actor: string;
              reason: string;
            }>(
              `select from_status, to_status, actor, reason from billing_transitions where clinic_id = $1 order by created_at desc limit 1`,
              [clinicId],
            )
          ).rows,
      );
      expect(history).toEqual([
        {
          from_status: "suspended",
          to_status: "active",
          actor: "support",
          reason: "suspension_lifted",
        },
      ]);
      const audit = await inTenant(
        clinicId,
        async (c) =>
          (
            await c.query<{ metadata: Record<string, unknown> }>(
              `select metadata from audit_log where clinic_id = $1 and metadata->>'field' = 'suspension'`,
              [clinicId],
            )
          ).rows,
      );
      expect(audit).toEqual([
        {
          metadata: { field: "suspension", lifted: true, remark: "Dispute withdrawn by the bank" },
        },
      ]);
    });

    test("refused for an account that isn't suspended, and for a reason that carries contact details", async () => {
      const { clinicId } = await seedClinic("lift-active");
      await seedEntitled(clinicId, { planId: "chat-web" });
      expect(
        await liftSuspension({ clinicId, reason: "Checked", actorLabel: "ops@healdesk.test" }),
      ).toMatchObject({ status: "refused", message: "This account isn't suspended." });
      const other = await suspended("lift-phi");
      expect(
        await liftSuspension({
          clinicId: other,
          reason: "Spoke to jo@clinic.test",
          actorLabel: "ops",
        }),
      ).toMatchObject({ status: "refused", message: expect.stringMatching(/email address/) });
      expect((await rowOf(other)).status).toBe("suspended");
    });
  });

  describe("extendSetupDeadline", () => {
    test("adds the days to the deadline and moves a recorded closure to the new one", async () => {
      const { clinicId } = await seedClinic("extend-ok");
      const deadline = new Date("2026-10-30T23:59:59Z");
      await seedEntitled(clinicId, { planId: "chat-web", setupDeadlineAt: deadline });
      await withTenant({ clinicId, actor }, (tx) => closeUnfinishedSetup(tx, clinicId, "deadline"));

      const result = await extendSetupDeadline(
        { clinicId, days: 7, actorLabel: "ops@healdesk.test" },
        { now: NOW },
      );
      const extended = new Date(deadline.getTime() + 7 * 24 * 60 * 60 * 1000);
      expect(result).toEqual({ status: "extended", setupDeadlineAt: extended.toISOString() });
      expect(await rowOf(clinicId)).toMatchObject({
        setupDeadlineAt: extended,
        stripeMutationLeaseOwner: null,
      });
      const closure = await inTenant(
        clinicId,
        async (c) =>
          (
            await c.query<{ next_attempt_at: Date; done_at: Date | null }>(
              `select next_attempt_at, done_at from billing_requests where clinic_id = $1 and kind = 'close_setup'`,
              [clinicId],
            )
          ).rows,
      );
      expect(closure).toEqual([{ next_attempt_at: extended, done_at: null }]);
      const audit = await inTenant(
        clinicId,
        async (c) =>
          (
            await c.query<{ metadata: Record<string, unknown> }>(
              `select metadata from audit_log where clinic_id = $1 and metadata->>'field' = 'setup_deadline'`,
              [clinicId],
            )
          ).rows,
      );
      expect(audit).toEqual([{ metadata: { field: "setup_deadline", days: 7 } }]);
    });

    test("a deadline already past is extended from now", async () => {
      const { clinicId } = await seedClinic("extend-past");
      await seedEntitled(clinicId, {
        planId: "chat-web",
        setupDeadlineAt: new Date("2026-10-01T00:00:00Z"),
      });
      expect(
        await extendSetupDeadline({ clinicId, days: 3, actorLabel: "ops" }, { now: NOW }),
      ).toEqual({
        status: "extended",
        setupDeadlineAt: new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      });
    });

    test("busy while the closure worker holds the request, and nothing moves", async () => {
      const { clinicId } = await seedClinic("extend-leased");
      const deadline = new Date("2026-10-08T23:59:59Z");
      await seedEntitled(clinicId, { planId: "chat-web", setupDeadlineAt: deadline });
      await withTenant({ clinicId, actor }, (tx) => closeUnfinishedSetup(tx, clinicId, "deadline"));
      await inTenant(clinicId, (c) =>
        c.query(
          `update billing_requests set lease_until = now() + interval '5 minutes', attempts = 1 where clinic_id = $1`,
          [clinicId],
        ),
      );
      expect(
        await extendSetupDeadline({ clinicId, days: 7, actorLabel: "ops" }, { now: NOW }),
      ).toMatchObject({ status: "busy" });
      expect(await rowOf(clinicId)).toMatchObject({
        setupDeadlineAt: deadline,
        stripeMutationLeaseOwner: null,
      });
    });

    test("refused for days outside 1 to 30, once the plan has started, and with no deadline", async () => {
      const { clinicId } = await seedClinic("extend-refused");
      await seedEntitled(clinicId, {
        planId: "chat-web",
        planStartedAt: new Date("2026-10-02T00:00:00Z"),
      });
      for (const days of [0, 31, 1.5]) {
        expect(
          await extendSetupDeadline({ clinicId, days, actorLabel: "ops" }, { now: NOW }),
        ).toMatchObject({
          status: "refused",
        });
      }
      expect(
        await extendSetupDeadline({ clinicId, days: 5, actorLabel: "ops" }, { now: NOW }),
      ).toMatchObject({
        status: "refused",
        message: expect.stringMatching(/plan has started/),
      });
      const bare = await seedClinic("extend-none");
      await seedEntitled(bare.clinicId, { planId: "chat-web" });
      expect(
        await extendSetupDeadline(
          { clinicId: bare.clinicId, days: 5, actorLabel: "ops" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "refused", message: expect.stringMatching(/no setup deadline/) });
    });
  });
});
