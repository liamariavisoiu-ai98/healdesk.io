import { getPlan } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { BillingStatus } from "@/db/schema";
import { seedEntitlements } from "@/lib/billing/entitlements";
import {
  ALLOWED_TRANSITIONS,
  BillingTransitionError,
  canTransition,
  recordBillingNote,
  transition,
} from "@/lib/billing/state-machine";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

const describeDb = hasTestDatabase ? describe : describe.skip;

const ALL_STATUSES = Object.keys(ALLOWED_TRANSITIONS) as BillingStatus[];

describe("billing status edges", () => {
  test("every listed edge is allowed", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALLOWED_TRANSITIONS[from]) {
        expect(canTransition(from, to), `${from} → ${to}`).toBe(true);
      }
    }
  });

  test("the edges that must never exist", () => {
    // Terminal states stay terminal.
    expect(canTransition("purged", "active")).toBe(false);
    expect(canTransition("canceled", "active")).toBe(false);
    // Nothing goes backwards into provisioning.
    expect(canTransition("active", "provisioning")).toBe(false);
    // A card cannot fail before it was ever charged.
    expect(canTransition("provisioning", "past_due")).toBe(false);
    // Only a cancellation reaches purged.
    expect(canTransition("active", "purged")).toBe(false);
    // Staying put is not a transition.
    for (const status of ALL_STATUSES) {
      expect(canTransition(status, status), status).toBe(false);
    }
  });

  test("the whole graph, so an edit here is a deliberate one", () => {
    expect(ALLOWED_TRANSITIONS).toEqual({
      demo: ["provisioning"],
      provisioning: ["active", "suspended", "canceled"],
      active: ["past_due", "paused", "canceling", "suspended", "canceled"],
      past_due: ["active", "paused", "suspended", "canceling", "canceled"],
      suspended: ["active", "canceled"],
      paused: ["active", "canceled"],
      canceling: ["active", "suspended", "canceled"],
      canceled: ["purged"],
      purged: [],
    });
  });
});

describeDb("transition()", () => {
  let clinicId: string;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    clinicId = (await seedClinic("sm")).clinicId;
    await withTenant({ clinicId, actor: { type: "system" } }, (tx) =>
      seedEntitlements(tx.db, clinicId, {
        plan: getPlan("chat-web")!,
        interval: "month",
        stripeCustomerId: "cus_sm",
        stripeSubscriptionId: "sub_sm",
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  async function status(): Promise<string> {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ status: string }>(
        `select status from entitlements where clinic_id = $1`,
        [clinicId],
      ),
    );
    return rows[0]!.status;
  }

  async function history(): Promise<
    { from_status: string | null; to_status: string; actor: string; reason: string }[]
  > {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{
        from_status: string | null;
        to_status: string;
        actor: string;
        reason: string;
      }>(
        `select from_status, to_status, actor, reason
           from billing_transitions where clinic_id = $1 order by created_at`,
        [clinicId],
      ),
    );
    return rows;
  }

  test("an allowed edge updates the row, the history and the audit log together", async () => {
    const edge = await withTenant(
      { clinicId, actor: { type: "service", serviceName: "test" } },
      (tx) =>
        transition(tx, "active", {
          actor: "system",
          reason: "invoice.paid",
          stripeEventId: "evt_sm_activate",
        }),
    );
    expect(edge).toEqual({ from: "provisioning", to: "active" });
    expect(await status()).toBe("active");

    expect(await history()).toEqual([
      { from_status: null, to_status: "provisioning", actor: "system", reason: "provisioned" },
      { from_status: "provisioning", to_status: "active", actor: "system", reason: "invoice.paid" },
    ]);

    const audit = await inTenant(clinicId, (client) =>
      client.query<{ action: string; actor_label: string; metadata: Record<string, unknown> }>(
        `select action, actor_label, metadata
           from audit_log where clinic_id = $1 and resource_type = 'entitlements'`,
        [clinicId],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: "update",
      actor_label: "test",
      metadata: { field: "status", from: "provisioning", to: "active" },
    });
  });

  test("a disallowed edge throws, names both statuses, and writes nothing", async () => {
    const before = await history();

    await expect(
      withTenant({ clinicId, actor: { type: "system" } }, (tx) =>
        transition(tx, "purged", { actor: "support", reason: "test" }),
      ),
    ).rejects.toMatchObject({
      name: "BillingTransitionError",
      from: "active",
      to: "purged",
    });

    // And the same for a backwards edge and a same-status one.
    await expect(
      withTenant({ clinicId, actor: { type: "system" } }, (tx) =>
        transition(tx, "provisioning", { actor: "support", reason: "test" }),
      ),
    ).rejects.toBeInstanceOf(BillingTransitionError);
    await expect(
      withTenant({ clinicId, actor: { type: "system" } }, (tx) =>
        transition(tx, "active", { actor: "support", reason: "test" }),
      ),
    ).rejects.toBeInstanceOf(BillingTransitionError);

    expect(await status()).toBe("active");
    // The throw rolled the transaction back: no half-written history.
    expect(await history()).toEqual(before);
  });

  test("a note records without moving the status", async () => {
    const current = await withTenant(
      { clinicId, actor: { type: "system" } },
      (tx) =>
        recordBillingNote(tx, {
          actor: "system",
          reason: "authentication_required",
          stripeEventId: "evt_sm_note",
        }),
    );
    expect(current).toBe("active");
    expect(await status()).toBe("active");
    expect((await history()).at(-1)).toEqual({
      from_status: "active",
      to_status: "active",
      actor: "system",
      reason: "authentication_required",
    });
  });

  test("walks a full life: active → past_due → suspended → active → canceling → canceled → purged", async () => {
    const path: BillingStatus[] = [
      "past_due",
      "suspended",
      "active",
      "canceling",
      "canceled",
      "purged",
    ];
    for (const to of path) {
      await withTenant({ clinicId, actor: { type: "system" } }, (tx) =>
        transition(tx, to, { actor: "support", reason: `walk:${to}` }),
      );
      expect(await status()).toBe(to);
    }
    // Purged is terminal.
    await expect(
      withTenant({ clinicId, actor: { type: "system" } }, (tx) =>
        transition(tx, "active", { actor: "support", reason: "resurrect" }),
      ),
    ).rejects.toBeInstanceOf(BillingTransitionError);
  });
});
