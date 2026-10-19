import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { __setStripeForTests } from "@/lib/billing/stripe-client";
import type {
  DeliveryResult,
  DeliveryTarget,
  EmailTransport,
  OutgoingEmail,
} from "@/lib/reporting/deliver";
import {
  ADDRESS_CHANGE_WAIT_MS,
  confirmAddressChange,
  lookUpAddressLink,
  normaliseAddress,
  operatorChangeClinicEmail,
  requestAddressChange,
  runAddressChangesJob,
  stopAddressChange,
} from "@/lib/sign-in/address-change";
import { issueSignInLink, lookUpSignInLink } from "@/lib/sign-in/links";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  bindAgreementInEffect,
  inTenant,
  seedClinic,
  seedEntitled,
  seedPortalUser,
  type SeededClinic,
} from "./setup/factories";

/**
 * A change of the clinic's one address (plan Part D5, Annex X5 O5): from
 * Settings it waits for the new address to confirm, then 72 hours; from ops
 * it waits 72 hours with notice to both addresses. When it takes effect the
 * sign-in, the Stripe customer and the notice address move together, and
 * every resolution writes a security event.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "https://app.healdesk.test";
const DEVICE = "Front desk Mac";

type Sent = { target: DeliveryTarget; message: OutgoingEmail; to: string };

function fakeTransport(result: DeliveryResult = { status: "sent", messageId: "msg_1" }) {
  const sent: Sent[] = [];
  const transport: EmailTransport = {
    name: "fake",
    send: async (target, message) => {
      sent.push({ target, message, to: target.to });
      return result;
    },
  };
  return { sent, transport };
}

type StripeUpdate = { customerId: string; email: string; idempotencyKey?: string };

function fakeStripe(fail = false) {
  const updates: StripeUpdate[] = [];
  const stripe = {
    customers: {
      update: async (
        customerId: string,
        params: { email: string },
        options?: { idempotencyKey?: string },
      ) => {
        if (fail) throw new Error("Stripe is down");
        updates.push({ customerId, email: params.email, idempotencyKey: options?.idempotencyKey });
        return { id: customerId, email: params.email };
      },
    },
  };
  return { stripe, updates };
}

function confirmTokenIn(text: string): string {
  const match = new RegExp(
    `${ORIGIN.replace(/\./g, "\\.")}/address-change/([A-Za-z0-9_-]{43})`,
  ).exec(text);
  if (!match) throw new Error("no confirmation link in the email");
  return match[1]!;
}

async function userEmail(userId: string): Promise<string> {
  const { rows } = await getMigratorPool().query<{ email: string }>(
    `select email from "user" where id = $1`,
    [userId],
  );
  return rows[0]!.email;
}

async function events(name: string): Promise<{ metadata: Record<string, unknown> }[]> {
  const { rows } = await getMigratorPool().query<{ metadata: Record<string, unknown> }>(
    `select metadata from security_events where event = $1 order by occurred_at`,
    [name],
  );
  return rows;
}

/** Move a change's clocks back, as the migrator (the owner), so its 72 hours are up. */
async function makeDue(clinicId: string, changeId: string): Promise<void> {
  await inTenant(clinicId, (c) =>
    c.query(
      `update sign_in_address_changes
          set effective_at = now() - interval '1 minute', confirmed_at = now() - interval '73 hours'
        where id = $1`,
      [changeId],
    ),
  );
}

const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET"]) SAVED[key] = process.env[key];
  process.env.BETTER_AUTH_URL = ORIGIN;
  process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-tests";
});

afterEach(() => {
  __setStripeForTests(null);
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
    else (process.env as Record<string, string>)[key] = value;
  }
});

describe("what an address change accepts", () => {
  test("one address, trimmed and lower-cased", () => {
    expect(normaliseAddress("  Info@GlowSpa.COM ")).toBe("info@glowspa.com");
    expect(normaliseAddress("info@glowspa")).toBeNull();
    expect(normaliseAddress("a@b.com, c@d.com")).toBeNull();
    expect(normaliseAddress(42)).toBeNull();
  });
});

describeDb("a change of the clinic's address", () => {
  let clinic: SeededClinic;
  const actor = { type: "user" as const, userId: "", label: DEVICE };

  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    clinic = await seedClinic("addr");
    actor.userId = clinic.staffUserId;
  });

  afterAll(async () => {
    await closePools();
  });

  async function ask(newEmail: string, transport: EmailTransport) {
    return requestAddressChange(
      {
        clinicId: clinic.clinicId,
        userId: clinic.staffUserId,
        newEmail,
        requestedBy: DEVICE,
        actor,
      },
      { transport },
    );
  }

  test("from Settings: a link to the new address, and nothing else until it is used", async () => {
    const { sent, transport } = fakeTransport();
    const outcome = await ask(" Front@Radiance.test ", transport);
    expect(outcome).toMatchObject({ status: "requested", emailed: true });
    if (outcome.status !== "requested") throw new Error("not requested");
    expect(outcome.change).toMatchObject({
      status: "awaiting_confirmation",
      source: "settings",
      oldEmail: clinic.staffEmail,
      newEmail: "front@radiance.test",
      requestedBy: DEVICE,
    });
    // One email, to the new address, carrying the link; the old one hears
    // nothing until the new one confirms.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("front@radiance.test");
    expect(sent[0]!.message.tags).toContainEqual({ name: "kind", value: "address_change_confirm" });
    const token = confirmTokenIn(sent[0]!.message.text);
    // Only the token's digest is stored.
    const { rows } = await inTenant(clinic.clinicId, (c) =>
      c.query<{ hash: Buffer }>(`select confirm_token_hash as hash from sign_in_address_changes`),
    );
    expect(rows[0]!.hash).toHaveLength(32);
    expect(rows[0]!.hash.toString("base64url")).not.toBe(token);
    expect(await userEmail(clinic.staffUserId)).toBe(clinic.staffEmail);
    expect(await events("sign_in_address_change_requested")).toHaveLength(1);
  });

  test("a clinic whose name the email rule refuses still gets O5's link, without the name", async () => {
    await getMigratorPool().query(`update clinics set name = $1 where id = $2`, [
      "Glow @ Main Street Med Spa",
      clinic.clinicId,
    ]);
    const { sent, transport } = fakeTransport();
    const outcome = await ask("front@radiance.test", transport);
    expect(outcome).toMatchObject({ status: "requested", emailed: true });
    expect(sent).toHaveLength(1);
    for (const body of [sent[0]!.message.text, sent[0]!.message.html]) {
      expect(body).not.toContain("@ Main Street");
    }
    expect(sent[0]!.message.text).toContain("someone at a practice asked");
  });

  test("refuses a malformed address, the current one, another sign-in's, and a second open change", async () => {
    const { transport } = fakeTransport();
    expect(await ask("not an address", transport)).toMatchObject({ status: "refused" });
    expect(await ask(clinic.staffEmail.toUpperCase(), transport)).toMatchObject({
      status: "refused",
      message: "That's already the clinic's address.",
    });
    const other = await seedClinic("addr-other");
    expect(await ask(other.staffEmail, transport)).toMatchObject({ status: "refused" });
    expect(await ask("front@radiance.test", transport)).toMatchObject({ status: "requested" });
    expect(await ask("desk@radiance.test", transport)).toMatchObject({
      status: "refused",
      message: "A change of address is already under way. Stop it first, then ask again.",
    });
  });

  test("refuses a user who is not the clinic's sign-in", async () => {
    const { transport } = fakeTransport();
    const outsider = await seedClinic("addr-outsider");
    const outcome = await requestAddressChange(
      {
        clinicId: clinic.clinicId,
        userId: outsider.staffUserId,
        newEmail: "front@radiance.test",
        requestedBy: DEVICE,
        actor,
      },
      { transport },
    );
    expect(outcome).toMatchObject({ status: "refused" });
  });

  test("the link: a look spends nothing, the POST confirms once, and O5 goes to the old address naming the moment", async () => {
    const { sent, transport } = fakeTransport();
    await ask("front@radiance.test", transport);
    const token = confirmTokenIn(sent[0]!.message.text);

    const looked = await lookUpAddressLink(token);
    expect(looked).toMatchObject({ ok: true, newEmailMasked: "f•••@radiance.test" });
    expect(await lookUpAddressLink(token)).toMatchObject({ ok: true });

    const before = Date.now();
    const confirmed = await confirmAddressChange(token, {}, { transport });
    expect(confirmed).toMatchObject({ ok: true, emailed: true });
    if (!confirmed.ok) throw new Error("not confirmed");
    const wait = confirmed.effectiveAt.getTime() - before;
    expect(wait).toBeGreaterThan(ADDRESS_CHANGE_WAIT_MS - 60_000);
    expect(wait).toBeLessThan(ADDRESS_CHANGE_WAIT_MS + 60_000);

    expect(sent).toHaveLength(2);
    expect(sent[1]!.to).toBe(clinic.staffEmail);
    expect(sent[1]!.message.tags).toContainEqual({ name: "kind", value: "address_changing" });
    expect(sent[1]!.message.text).toContain("Stop this change:");
    expect(sent[1]!.message.text).toContain(`${ORIGIN}/c/${clinic.slug}/settings#sign-in`);
    // A notice, not a link email: no token of its own.
    expect(sent[1]!.message.text).not.toMatch(/\/address-change\//);

    expect(await confirmAddressChange(token, {}, { transport })).toEqual({
      ok: false,
      reason: "used",
    });
    expect(await confirmAddressChange("x".repeat(43), {}, { transport })).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(await events("sign_in_address_change_confirmed")).toHaveLength(1);
    // Still the old address until the 72 hours are up.
    expect(await userEmail(clinic.staffUserId)).toBe(clinic.staffEmail);
    expect((await runAddressChangesJob()).applied).toBe(0);
  });

  test("the clinic can stop it, signed in, and then nothing takes effect", async () => {
    const { sent, transport } = fakeTransport();
    await ask("front@radiance.test", transport);
    const token = confirmTokenIn(sent[0]!.message.text);
    const confirmed = await confirmAddressChange(token, {}, { transport });
    if (!confirmed.ok) throw new Error("not confirmed");
    const stopped = await stopAddressChange({
      clinicId: clinic.clinicId,
      stoppedBy: "clinic",
      label: "the clinic's sign-in",
      actor,
    });
    expect(stopped.status).toBe("stopped");
    expect(
      await stopAddressChange({
        clinicId: clinic.clinicId,
        stoppedBy: "clinic",
        label: "x",
        actor,
      }),
    ).toEqual({ status: "none" });
    const stopEvents = await events("sign_in_address_change_stopped");
    expect(stopEvents).toHaveLength(1);
    expect(stopEvents[0]!.metadata).toMatchObject({
      stoppedBy: "clinic",
      clinicId: clinic.clinicId,
    });

    expect((await runAddressChangesJob()).applied).toBe(0);
    expect(await userEmail(clinic.staffUserId)).toBe(clinic.staffEmail);
    expect(await lookUpAddressLink(token)).toMatchObject({ ok: false, reason: "stopped" });
  });

  test("at 72 hours: Stripe's customer, then the sign-in, its unused links, the history and the notice address", async () => {
    await bindAgreementInEffect(clinic.clinicId);
    const { stripeCustomerId } = await seedEntitled(clinic.clinicId);
    const { stripe, updates } = fakeStripe();
    __setStripeForTests(stripe);
    const { sent, transport } = fakeTransport();
    const asked = await ask("front@radiance.test", transport);
    if (asked.status !== "requested") throw new Error("not requested");
    await confirmAddressChange(confirmTokenIn(sent[0]!.message.text), {}, { transport });
    const oldLink = await issueSignInLink({
      userId: clinic.staffUserId,
      purpose: "sign_in",
      issuedBy: "test",
    });

    await makeDue(clinic.clinicId, asked.change.id);
    const run = await runAddressChangesJob();
    expect(run).toEqual({ applied: 1, expired: 0, failed: 0, waiting: 0 });

    expect(updates).toEqual([
      {
        customerId: stripeCustomerId,
        email: "front@radiance.test",
        idempotencyKey: `hd-address-change-${asked.change.id}-${stripeCustomerId}`,
      },
    ]);
    expect(await userEmail(clinic.staffUserId)).toBe("front@radiance.test");
    // A link mailed to the old address signs nobody in after the move.
    expect(await lookUpSignInLink(oldLink!.token)).toEqual({ ok: false, reason: "used" });

    const history = await inTenant(clinic.clinicId, (c) =>
      c.query<{ field: string; before_value: string; after_value: string; actor_label: string }>(
        `select field, before_value, after_value, actor_label from clinic_settings_history`,
      ),
    );
    expect(history.rows).toEqual([
      {
        field: "sign_in_email",
        before_value: `a•••@example-clinic.test`,
        after_value: "f•••@radiance.test",
        actor_label: DEVICE,
      },
    ]);
    expect(await events("sign_in_address_changed")).toHaveLength(1);
    const notice = await events("agreement_notice_address_changed");
    expect(notice).toHaveLength(1);
    expect(notice[0]!.metadata).toMatchObject({ changeId: asked.change.id });

    // Applied once: the next hour finds nothing due.
    expect(await runAddressChangesJob()).toEqual({ applied: 0, expired: 0, failed: 0, waiting: 0 });
  });

  test("a Stripe failure moves nothing, and the next hour tries again", async () => {
    await seedEntitled(clinic.clinicId);
    const { stripe } = fakeStripe(true);
    __setStripeForTests(stripe);
    const { sent, transport } = fakeTransport();
    const asked = await ask("front@radiance.test", transport);
    if (asked.status !== "requested") throw new Error("not requested");
    await confirmAddressChange(confirmTokenIn(sent[0]!.message.text), {}, { transport });
    await makeDue(clinic.clinicId, asked.change.id);

    expect(await runAddressChangesJob()).toMatchObject({ applied: 0, waiting: 1 });
    expect(await userEmail(clinic.staffUserId)).toBe(clinic.staffEmail);

    const { stripe: working, updates } = fakeStripe();
    __setStripeForTests(working);
    expect(await runAddressChangesJob()).toMatchObject({ applied: 1, waiting: 0 });
    expect(updates).toHaveLength(1);
    expect(await userEmail(clinic.staffUserId)).toBe("front@radiance.test");
  });

  test("an address that became another sign-in's in the meantime closes the change without effect", async () => {
    const { sent, transport } = fakeTransport();
    const asked = await ask("front@radiance.test", transport);
    if (asked.status !== "requested") throw new Error("not requested");
    await confirmAddressChange(confirmTokenIn(sent[0]!.message.text), {}, { transport });
    await getMigratorPool().query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values ('usr_squatter', 'Someone', 'front@radiance.test', true, now(), now())`,
    );
    await makeDue(clinic.clinicId, asked.change.id);
    expect(await runAddressChangesJob()).toMatchObject({ applied: 0, failed: 1 });
    expect(await userEmail(clinic.staffUserId)).toBe(clinic.staffEmail);
    const failed = await events("sign_in_address_change_failed");
    expect(failed[0]!.metadata).toMatchObject({ code: "address_taken" });
  });

  test("a sign-in whose address moved some other way in the meantime closes the change without effect", async () => {
    const { sent, transport } = fakeTransport();
    const asked = await ask("front@radiance.test", transport);
    if (asked.status !== "requested") throw new Error("not requested");
    await confirmAddressChange(confirmTokenIn(sent[0]!.message.text), {}, { transport });
    await getMigratorPool().query(
      `update "user" set email = 'elsewhere@radiance.test' where id = $1`,
      [clinic.staffUserId],
    );
    await makeDue(clinic.clinicId, asked.change.id);
    expect(await runAddressChangesJob()).toMatchObject({ applied: 0, failed: 1 });
    expect(await userEmail(clinic.staffUserId)).toBe("elsewhere@radiance.test");
    const failed = await events("sign_in_address_change_failed");
    expect(failed[0]!.metadata).toMatchObject({ code: "sign_in_changed" });
    const { rows } = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from ops_alerts where event = 'address_change_failed'`,
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
  });

  test("an unused link closes after its 72 hours", async () => {
    const { transport } = fakeTransport();
    const asked = await ask("front@radiance.test", transport);
    if (asked.status !== "requested") throw new Error("not requested");
    await inTenant(clinic.clinicId, (c) =>
      c.query(
        `update sign_in_address_changes set confirm_expires_at = now() - interval '1 minute'`,
      ),
    );
    expect(await runAddressChangesJob()).toMatchObject({ expired: 1 });
    expect(await events("sign_in_address_change_expired")).toHaveLength(1);
    // A fresh one may be asked for now.
    expect(await ask("desk@radiance.test", transport)).toMatchObject({ status: "requested" });
  });

  test("from ops: in effect 72 hours on, with O5 to both addresses naming the end of the objection window", async () => {
    const { sent, transport } = fakeTransport();
    const outcome = await operatorChangeClinicEmail(
      {
        clinicId: clinic.clinicId,
        newEmail: "front@radiance.test",
        requestedBy: "ops@healdesk.test",
        actor: { type: "service", serviceName: "ops@healdesk.test" },
      },
      { transport },
    );
    expect(outcome).toMatchObject({ status: "requested", emailed: true });
    if (outcome.status !== "requested") throw new Error("not requested");
    expect(outcome.change).toMatchObject({ status: "pending", source: "operator" });
    expect(sent.map((s) => s.to)).toEqual([clinic.staffEmail, "front@radiance.test"]);
    for (const { message } of sent) {
      expect(message.text).toContain("After a call with");
      expect(message.text).toContain("We're writing to both addresses.");
      expect(message.text).not.toMatch(/\/address-change\//);
    }
    expect(await events("sign_in_address_change_entered")).toHaveLength(1);

    // An objection: the operator stops it.
    expect(
      await stopAddressChange({
        clinicId: clinic.clinicId,
        stoppedBy: "operator",
        label: "ops@healdesk.test",
        actor: { type: "service", serviceName: "ops@healdesk.test" },
      }),
    ).toMatchObject({ status: "stopped" });
    expect(await runAddressChangesJob()).toMatchObject({ applied: 0 });
  });

  test("the operator's change takes effect at 72 hours with no Stripe customer to move", async () => {
    const { transport } = fakeTransport();
    const outcome = await operatorChangeClinicEmail(
      {
        clinicId: clinic.clinicId,
        newEmail: "front@radiance.test",
        requestedBy: "ops@healdesk.test",
        actor: { type: "service", serviceName: "ops@healdesk.test" },
      },
      { transport },
    );
    if (outcome.status !== "requested") throw new Error("not requested");
    expect(await runAddressChangesJob()).toMatchObject({ applied: 0 });
    await makeDue(clinic.clinicId, outcome.change.id);
    expect(await runAddressChangesJob()).toMatchObject({ applied: 1 });
    expect(await userEmail(clinic.staffUserId)).toBe("front@radiance.test");
  });

  test("the database: no delete, no rewritten address, one way only, and one clinic's changes are its own", async () => {
    const { transport } = fakeTransport();
    const asked = await ask("front@radiance.test", transport);
    if (asked.status !== "requested") throw new Error("not requested");
    const other = await seedClinic("addr-tenant");
    await seedPortalUser(other.clinicId, "front_desk");

    const { rows: privileges } = await getMigratorPool().query<{ del: boolean; addr: boolean }>(
      `select has_table_privilege('healdesk_app', 'sign_in_address_changes', 'DELETE') as del,
              has_column_privilege('healdesk_app', 'sign_in_address_changes', 'new_email', 'UPDATE') as addr`,
    );
    expect(privileges[0]).toEqual({ del: false, addr: false });

    await expect(
      inTenant(clinic.clinicId, (c) =>
        c.query(`update sign_in_address_changes set new_email = 'evil@elsewhere.test'`),
      ),
    ).rejects.toThrow(/fixed once asked for/);
    await expect(
      inTenant(clinic.clinicId, (c) =>
        c.query(`update sign_in_address_changes set status = 'applied', resolved_at = now()`),
      ),
    ).rejects.toThrow(/cannot become applied/);

    const seen = await inTenant(other.clinicId, (c) =>
      c.query<{ n: number }>(`select count(*)::int as n from sign_in_address_changes`),
    );
    expect(seen.rows[0]!.n).toBe(0);
  });
});
