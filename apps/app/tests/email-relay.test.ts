import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { isUndeliverable } from "@/lib/email/events";
import { parseEnvelope, runOperation, type Operator } from "@/lib/ops/api";
import { claimDelivery } from "@/lib/reporting/recipients";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * Resend's webhook, relayed: the apps/app half of the `emailEvent` ops
 * operation (apps/web's half is tested beside its route). An event names the
 * ledger row by its `delivery` tag and the tenant by its `clinic` tag; it
 * updates that row and nothing else, never moves a row backwards, and alerts
 * ops when a clinic's one address cannot be reached.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "email-relay-test" } as const;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: { requestId: "req_test" } };

async function ledgerRow(
  clinicId: string,
  kind = "payment_failed",
  periodKey = crypto.randomUUID(),
) {
  const id = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    claimDelivery(tx, {
      kind: kind as "payment_failed",
      periodKey,
      recipient: "desk@radiance.test",
    }),
  );
  return id!;
}

async function delivery(
  clinicId: string,
  id: string,
): Promise<{ delivery_status: string | null; delivery_at: Date | null }> {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ delivery_status: string | null; delivery_at: Date | null }>(
      `select delivery_status, delivery_at from report_deliveries where id = $1`,
      [id],
    );
    return rows[0]!;
  });
}

async function alerts(event: string): Promise<Record<string, unknown>[]> {
  const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
    `select fields from ops_alerts where event = $1`,
    [event],
  );
  return rows.map((r) => r.fields);
}

/** The op exactly as apps/web sends it: through the envelope parser, then dispatch. */
async function relay(args: Record<string, unknown>) {
  const parsed = parseEnvelope(JSON.stringify({ op: "emailEvent", args }));
  if (!parsed.ok) return parsed.outcome;
  return runOperation(parsed.envelope.op, parsed.envelope.args, OPERATOR);
}

describeDb("the emailEvent relay", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(async () => {
    await getMigratorPool().query(`truncate ops_alerts`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closePools();
  });

  test("updates the ledger row its tags name, at the event's own time", async () => {
    const c = await seedClinic("relay-delivered");
    const id = await ledgerRow(c.clinicId);
    const at = "2026-10-06T15:04:05.000Z";
    const outcome = await relay({
      type: "delivered",
      at,
      clinic: c.clinicId,
      delivery: id,
      kind: "payment_failed",
    });
    expect(outcome).toEqual({ status: 200, body: { data: { recorded: true } } });
    const row = await delivery(c.clinicId, id);
    expect(row.delivery_status).toBe("delivered");
    expect(row.delivery_at?.toISOString()).toBe(at);
    expect(await alerts("clinic_address_bounced")).toEqual([]);
  });

  test("never moves a row backwards: a late 'sent' after 'delivered' is ignored, a complaint is not", async () => {
    const c = await seedClinic("relay-order");
    const id = await ledgerRow(c.clinicId);
    await relay({
      type: "delivered",
      at: "2026-10-06T15:00:00Z",
      clinic: c.clinicId,
      delivery: id,
    });
    const late = await relay({
      type: "sent",
      at: "2026-10-06T14:59:00Z",
      clinic: c.clinicId,
      delivery: id,
    });
    expect(late).toEqual({ status: 200, body: { data: { recorded: false } } });
    expect((await delivery(c.clinicId, id)).delivery_status).toBe("delivered");
    await relay({
      type: "complained",
      at: "2026-10-06T16:00:00Z",
      clinic: c.clinicId,
      delivery: id,
    });
    expect((await delivery(c.clinicId, id)).delivery_status).toBe("complained");
  });

  test("a permanent bounce marks the address undeliverable and tells ops, until mail gets through again", async () => {
    const c = await seedClinic("relay-bounce");
    const first = await ledgerRow(c.clinicId);
    await relay({
      type: "bounced",
      at: "2026-10-06T15:00:00Z",
      clinic: c.clinicId,
      delivery: first,
      kind: "payment_failed",
    });
    expect(await alerts("clinic_address_bounced")).toEqual([
      { clinicId: c.clinicId, kind: "payment_failed" },
    ]);
    expect(
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        isUndeliverable(tx, "desk@radiance.test"),
      ),
    ).toBe(true);

    const second = await ledgerRow(c.clinicId);
    await relay({
      type: "delivered",
      at: "2026-10-06T18:00:00Z",
      clinic: c.clinicId,
      delivery: second,
    });
    expect(
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        isUndeliverable(tx, "desk@radiance.test"),
      ),
    ).toBe(false);
  });

  test("a suppression and a complaint alert ops too; a delay does not", async () => {
    const c = await seedClinic("relay-suppressed");
    await relay({
      type: "suppressed",
      at: "2026-10-06T15:00:00Z",
      clinic: c.clinicId,
      delivery: await ledgerRow(c.clinicId),
    });
    await relay({
      type: "complained",
      at: "2026-10-06T15:00:00Z",
      clinic: c.clinicId,
      delivery: await ledgerRow(c.clinicId),
    });
    await relay({
      type: "delayed",
      at: "2026-10-06T15:00:00Z",
      clinic: c.clinicId,
      delivery: await ledgerRow(c.clinicId),
    });
    expect(await alerts("clinic_address_suppressed")).toHaveLength(1);
    expect(await alerts("clinic_address_complained")).toHaveLength(1);
    expect(await alerts("clinic_address_bounced")).toHaveLength(0);
  });

  test("a bounce from someone the clinic sent its steps on to is recorded, and ops is not told the clinic's address bounced", async () => {
    const c = await seedClinic("relay-steps");
    const row = await ledgerRow(c.clinicId, "steps_sent", "2026-10-06:1");
    await relay({
      type: "bounced",
      at: "2026-10-06T15:00:00Z",
      clinic: c.clinicId,
      delivery: row,
      kind: "steps_sent",
    });
    expect((await delivery(c.clinicId, row)).delivery_status).toBe("bounced");
    expect(await alerts("clinic_address_bounced")).toEqual([]);
  });

  test("another clinic's tag cannot reach this clinic's row", async () => {
    const mine = await seedClinic("relay-mine");
    const other = await seedClinic("relay-other");
    const id = await ledgerRow(mine.clinicId);
    const outcome = await relay({
      type: "delivered",
      at: "2026-10-06T15:00:00Z",
      clinic: other.clinicId,
      delivery: id,
    });
    expect(outcome).toEqual({ status: 200, body: { data: { recorded: false } } });
    expect((await delivery(mine.clinicId, id)).delivery_status).toBeNull();
  });

  test("mail with no clinic is logged; a sign-in that cannot arrive also tells ops", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const bounced = await relay({
      type: "bounced",
      at: "2026-10-06T15:00:00Z",
      delivery: crypto.randomUUID(),
      kind: "ops_alert",
    });
    expect(bounced).toEqual({ status: 200, body: { data: { recorded: false } } });
    expect(
      info.mock.calls.some((call) =>
        String(call[0]).includes("email event for mail with no clinic"),
      ),
    ).toBe(true);
    expect(await alerts("clinic_address_bounced")).toEqual([]);

    const delivery = crypto.randomUUID();
    await relay({ type: "suppressed", at: "2026-10-06T15:00:00Z", delivery, kind: "sign_in_link" });
    expect(await alerts("clinic_address_suppressed")).toEqual([
      { kind: "sign_in_link", deliveryId: delivery },
    ]);
  });

  test("refuses anything that is not an event, and never reads an address", async () => {
    const c = await seedClinic("relay-refuse");
    expect(await relay({ type: "opened", at: "2026-10-06T15:00:00Z" })).toMatchObject({
      status: 400,
    });
    expect(await relay({ type: "delivered" })).toMatchObject({ status: 400 });
    expect(await relay({ type: "delivered", at: "yesterday" })).toMatchObject({ status: 400 });
    expect(
      await relay({ type: "delivered", at: "2026-10-06T15:00:00Z", clinic: "not-a-clinic" }),
    ).toMatchObject({ status: 400 });
    expect(
      await relay({ type: "delivered", at: "2026-10-06T15:00:00Z", kind: "Lip filler" }),
    ).toMatchObject({ status: 400 });
    // An address that strayed into the envelope is ignored, not stored.
    const id = await ledgerRow(c.clinicId);
    const outcome = await relay({
      type: "delivered",
      at: "2026-10-06T15:00:00Z",
      clinic: c.clinicId,
      delivery: id,
      to: "owner@radiance.test",
    });
    expect(outcome).toEqual({ status: 200, body: { data: { recorded: true } } });
  });

  /** email_events, as the digest reads it: a kind, a status, a time and nothing else. */
  async function counted(): Promise<{ app: string; kind: string; status: string; event_id: string | null }[]> {
    const { rows } = await getMigratorPool().query<{
      app: string;
      kind: string;
      status: string;
      event_id: string | null;
    }>(`select app, kind, status, event_id from email_events order by recorded_at, kind`);
    return rows;
  }

  /**
   * The I2 digest's email health read only the ledgers and the ops log: the
   * clinic-less kinds' bounces were only logged here, and apps/web's mail
   * never reached apps/app at all (19 October 2026).
   */
  test("a bounce on a kind no ledger holds is counted for the digest, once per webhook delivery", async () => {
    await getMigratorPool().query(`truncate email_events`);
    vi.spyOn(console, "info").mockImplementation(() => {});
    for (let i = 0; i < 2; i += 1) {
      await relay({
        type: "bounced",
        at: "2026-10-06T15:00:00Z",
        delivery: crypto.randomUUID(),
        kind: "sign_in_link",
        eventId: "msg_bounce_1",
      });
    }
    // A delivery is not something the digest counts; a ledger kind's bounce is the ledger's.
    await relay({ type: "delivered", at: "2026-10-06T15:00:00Z", kind: "device_changed" });
    await relay({ type: "bounced", at: "2026-10-06T15:00:00Z", kind: "ops_alert" });
    expect(await counted()).toEqual([
      { app: "app", kind: "sign_in_link", status: "bounced", event_id: "msg_bounce_1" },
    ]);
  });

  test("apps/web's own mail is counted and nothing else: no ledger, no alert, once per delivery", async () => {
    await getMigratorPool().query(`truncate email_events`);
    for (const [type, kind, eventId] of [
      ["sent", "nurture_1", "msg_w1"],
      ["complained", "nurture_1", "msg_w2"],
      ["complained", "nurture_1", "msg_w2"],
      ["delivered", "nurture_1", "msg_w3"],
    ] as const) {
      const outcome = await relay({ type, at: "2026-10-06T15:00:00Z", kind, app: "web", eventId });
      expect(outcome).toMatchObject({ status: 200 });
    }
    expect(await counted()).toEqual([
      { app: "web", kind: "nurture_1", status: "sent", event_id: "msg_w1" },
      { app: "web", kind: "nurture_1", status: "complained", event_id: "msg_w2" },
    ]);
    expect(await alerts("clinic_address_complained")).toEqual([]);
    // A web event names no clinic or delivery of ours, and no other app.
    expect(
      await relay({ type: "sent", at: "2026-10-06T15:00:00Z", kind: "nurture_1", app: "web", clinic: crypto.randomUUID() }),
    ).toMatchObject({ status: 400 });
    expect(
      await relay({ type: "sent", at: "2026-10-06T15:00:00Z", kind: "nurture_1", app: "leadgen" }),
    ).toMatchObject({ status: 400 });
  });
});
