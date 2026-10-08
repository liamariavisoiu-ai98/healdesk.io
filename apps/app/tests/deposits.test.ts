import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const alerts = vi.hoisted(
  () => [] as Array<{ clinicId: string; kind: string; ref: Record<string, string> }>,
);
vi.mock("@/lib/notices/booking-alerts", () => ({
  notifyBookingAlert: async (
    tx: { clinicId: string },
    kind: string,
    ref: Record<string, string>,
  ) => {
    alerts.push({ clinicId: tx.clinicId, kind, ref });
  },
}));

import type { AgentService, DepositPolicy } from "@/db/schema";
import {
  clinicDefaultDepositUsd,
  depositDecision,
  DepositSettingsError,
  effectiveDepositUsd,
  findService,
  getDepositSettings,
  hasDepositAmount,
  recordDepositOutcome,
  setDepositSettings,
  type DepositFacts,
} from "@/lib/billing/deposits";
import {
  AgentConfigError,
  updateAgentConfig,
  validateAgentConfig,
} from "@/lib/onboarding/agent-config";
import { runOperation, type Operator } from "@/lib/ops/api";
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
 * Deposits (BD27, R24): the decision as the product spec words it, the
 * per-service amount, and the one writer of the deposit switches.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
/** Several transactions and Stripe round trips a test: generous on a loaded machine. */
const DB_TEST_OPTIONS = { timeout: 30_000 };
const ACTOR = { type: "service", serviceName: "test" } as const;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };

/** A clinic that can take a deposit: deposits on, connected, $50 due. Each row overrides what it tests. */
function facts(over: Partial<DepositFacts>): DepositFacts {
  return {
    channel: "web",
    depositsEnabled: true,
    isConnected: true,
    amountUsd: 50,
    bookVoiceWithoutDeposit: true,
    bookChatWithoutDeposit: false,
    uncollectable: "book_and_flag",
    canCollectNow: true,
    linkLapsed: false,
    ...over,
  };
}

describe("depositDecision, against the spec", () => {
  // docs/v1-product-spec.md, "Booking behaviour and deposit control" (the
  // toggles table, lines 181-183) and the portal's Behaviour table (lines
  // 594-597). Each row names the line it holds the code to.
  const table: Array<[string, Partial<DepositFacts>, string, string]> = [
    // No deposit due at all.
    [
      "Take deposits off: the assistant cannot send a link at all (594)",
      { depositsEnabled: false },
      "book",
      "no_deposit",
    ],
    [
      "Take deposits is off until a gateway is connected (594)",
      { isConnected: false },
      "book",
      "no_deposit",
    ],
    ["a $0 amount means no deposit (BD27)", { amountUsd: 0 }, "book", "no_deposit"],
    ["an unknown amount cannot be asked for (BD27)", { amountUsd: null }, "book", "no_deposit"],
    [
      "voice with nothing due books as usual",
      { channel: "voice", depositsEnabled: false },
      "book",
      "no_deposit",
    ],
    // Voice never collects; its own switch decides, ahead of the general setting.
    [
      "phone On: books and flags the booking as deposit pending (181, 595)",
      { channel: "voice", bookVoiceWithoutDeposit: true },
      "book_and_flag",
      "voice_book_without_deposit",
    ],
    [
      "phone Off: does not book, routes to staff (181, 595)",
      { channel: "voice", bookVoiceWithoutDeposit: false },
      "decline_and_alert",
      "voice_without_deposit_off",
    ],
    [
      "phone Off beats a general Book and flag (595 over 597)",
      { channel: "voice", bookVoiceWithoutDeposit: false, uncollectable: "book_and_flag" },
      "decline_and_alert",
      "voice_without_deposit_off",
    ],
    [
      "phone On beats a general Do not book (595 over 597)",
      { channel: "voice", bookVoiceWithoutDeposit: true, uncollectable: "decline_and_alert" },
      "book_and_flag",
      "voice_book_without_deposit",
    ],
    [
      "voice never collects, even when a link could be sent (spec: voice cannot collect)",
      { channel: "voice", bookVoiceWithoutDeposit: false, canCollectNow: true },
      "decline_and_alert",
      "voice_without_deposit_off",
    ],
    // Chat, website and Meta alike.
    [
      "chat On: books and flags (182, 596)",
      { bookChatWithoutDeposit: true },
      "book_and_flag",
      "chat_book_without_deposit",
    ],
    [
      "chat On on Meta too: same rule for web and Meta (182)",
      { channel: "meta", bookChatWithoutDeposit: true },
      "book_and_flag",
      "chat_book_without_deposit",
    ],
    [
      "chat Off and a link can be sent: take payment in the conversation (182, 596)",
      { canCollectNow: true },
      "collect",
      "chat_collect",
    ],
    [
      "chat Off, cannot collect now: Book and flag (183, 597)",
      { canCollectNow: false, uncollectable: "book_and_flag" },
      "book_and_flag",
      "chat_uncollectable",
    ],
    [
      "chat Off, cannot collect now: Hold and alert staff (183, 597)",
      { canCollectNow: false, uncollectable: "hold_and_alert" },
      "hold_and_alert",
      "chat_uncollectable",
    ],
    [
      "chat Off, cannot collect now: Do not book and alert staff (183, 597)",
      { channel: "meta", canCollectNow: false, uncollectable: "decline_and_alert" },
      "decline_and_alert",
      "chat_uncollectable",
    ],
    [
      "an expired, unpaid link falls to the uncollectable setting, not another link (BD27)",
      { linkLapsed: true, canCollectNow: true, uncollectable: "hold_and_alert" },
      "hold_and_alert",
      "chat_link_lapsed",
    ],
    [
      "a lapsed link with chat On books and flags (182)",
      { linkLapsed: true, bookChatWithoutDeposit: true },
      "book_and_flag",
      "chat_book_without_deposit",
    ],
  ];

  test.each(table)("%s", (_label, over, action, rule) => {
    const outcome = depositDecision(facts(over));
    expect(outcome.action).toBe(action);
    expect(outcome.rule).toBe(rule);
    expect(outcome.isRequired).toBe(action !== "book");
    expect(outcome.amountUsd).toBe(action === "book" ? null : (over.amountUsd ?? 50));
  });
});

describe("the amount due", () => {
  const policy: DepositPolicy = { required: true, amountUsd: 100, collection: "front_desk" };
  const service = (depositUsd: number | null | undefined): AgentService => ({
    name: "Chemical peel",
    priceFromUsd: null,
    priceToUsd: null,
    durationMinutes: 60,
    ...(depositUsd === undefined ? {} : { depositUsd }),
  });

  test("a service's own deposit wins; 0 means none; blank follows the clinic default", () => {
    expect(effectiveDepositUsd({ service: service(40), policy })).toBe(40);
    expect(effectiveDepositUsd({ service: service(0), policy })).toBe(0);
    expect(effectiveDepositUsd({ service: service(null), policy })).toBe(100);
    expect(effectiveDepositUsd({ service: service(undefined), policy })).toBe(100);
    expect(effectiveDepositUsd({ service: null, policy })).toBe(100);
    expect(effectiveDepositUsd({ service: null, policy: null })).toBeNull();
  });

  test("the clinic default counts only while its policy requires a deposit; collection is ignored", () => {
    expect(
      clinicDefaultDepositUsd({ required: false, amountUsd: 100, collection: "front_desk" }),
    ).toBeNull();
    expect(
      clinicDefaultDepositUsd({ required: true, amountUsd: 100, collection: "stripe_connect" }),
    ).toBe(100);
    expect(
      clinicDefaultDepositUsd({ required: true, amountUsd: null, collection: "front_desk" }),
    ).toBeNull();
    expect(clinicDefaultDepositUsd(null)).toBeNull();
  });

  test("a service is found by its whole name, ignoring case and spacing, never by a guess", () => {
    const services = [service(40), { ...service(10), name: "Consultation" }];
    expect(findService(services, "  chemical   PEEL ")?.depositUsd).toBe(40);
    expect(findService(services, "peel")).toBeNull();
    expect(findService(services, null)).toBeNull();
  });

  test("an amount above $0 exists when a service or the default asks for one", () => {
    expect(hasDepositAmount([service(0)], null)).toBe(false);
    expect(hasDepositAmount([service(25)], null)).toBe(true);
    expect(hasDepositAmount([], policy)).toBe(true);
    expect(hasDepositAmount([], { ...policy, amountUsd: 0 })).toBe(false);
  });

  test("validateAgentConfig accepts a per-service deposit of $0 to $10,000 and refuses anything else", () => {
    const base = { greeting: "Hi", escalationPhone: null, escalationHours: null, notes: null };
    for (const ok of [0, 50, 10_000, null, undefined]) {
      expect(() => validateAgentConfig({ ...base, services: [service(ok)] })).not.toThrow();
    }
    for (const bad of [-1, 10_001, Number.NaN, "50" as unknown as number]) {
      expect(() => validateAgentConfig({ ...base, services: [service(bad)] })).toThrow(
        AgentConfigError,
      );
    }
  });
});

describeDb("the deposit switches, against the database", DB_TEST_OPTIONS, () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    alerts.length = 0;
  });

  afterAll(async () => {
    await closePools();
  });

  async function connect(clinicId: string): Promise<void> {
    await getMigratorPool().query(
      `update clinics set stripe_connect_account_id = 'acct_1Deposits', stripe_connect_connected_at = now() where id = $1`,
      [clinicId],
    );
  }

  async function services(
    clinicId: string,
    list: AgentService[],
    policy: DepositPolicy | null = null,
  ) {
    await withTenant({ clinicId, actor: ACTOR }, (tx) =>
      updateAgentConfig(tx, {
        greeting: "Hi",
        services: list,
        escalationPhone: null,
        escalationHours: null,
        notes: null,
        depositPolicy: policy,
      }),
    );
  }

  const set = (clinicId: string, patch: Parameters<typeof setDepositSettings>[1]) =>
    withTenant({ clinicId, actor: ACTOR }, (tx) => setDepositSettings(tx, patch, "Front desk Mac"));

  test("turning deposits on is refused until the clinic is connected and has an amount above $0", async () => {
    const c = await seedClinic("deposit-switch");
    await expect(set(c.clinicId, { depositsEnabled: true })).rejects.toMatchObject({
      name: "DepositSettingsError",
      field: "depositsEnabled",
      code: "not_connected",
    });
    await connect(c.clinicId);
    await services(c.clinicId, [
      { name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30, depositUsd: 0 },
    ]);
    await expect(set(c.clinicId, { depositsEnabled: true })).rejects.toMatchObject({
      code: "no_amount",
    });
    expect(
      (await withTenant({ clinicId: c.clinicId, actor: ACTOR }, getDepositSettings))
        .depositsEnabled,
    ).toBe(false);

    await services(c.clinicId, [
      { name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30, depositUsd: 25 },
    ]);
    const on = await set(c.clinicId, { depositsEnabled: true, bookVoiceWithoutDeposit: false });
    expect(on).toMatchObject({
      depositsEnabled: true,
      bookVoiceWithoutDeposit: false,
      isConnected: true,
      hasDepositAmount: true,
      canEnable: true,
    });

    // Audited by field, with values that cannot carry a person; the switch itself is a security event.
    const audit = await inTenant(c.clinicId, (client) =>
      client.query<{ metadata: Record<string, unknown>; actor_label: string }>(
        `select metadata, actor_label from audit_log where resource_type = 'clinic_settings' order by occurred_at`,
      ),
    );
    expect(audit.rows.at(-1)!.metadata).toEqual({
      fields: ["bookVoiceWithoutDeposit", "depositsEnabled"],
      bookVoiceWithoutDeposit: false,
      depositsEnabled: true,
    });
    const events = await getMigratorPool().query<{
      event: string;
      actor_label: string;
      metadata: Record<string, unknown>;
    }>(
      `select event, actor_label, metadata from security_events where event like 'deposits_switched_%'`,
    );
    expect(events.rows).toEqual([
      {
        event: "deposits_switched_on",
        actor_label: "Front desk Mac",
        metadata: { clinicId: c.clinicId },
      },
    ]);

    // Re-saving the same values writes nothing more.
    await set(c.clinicId, { depositsEnabled: true, bookVoiceWithoutDeposit: false });
    const again = await inTenant(c.clinicId, (client) =>
      client.query(`select 1 from audit_log where resource_type = 'clinic_settings'`),
    );
    expect(again.rows).toHaveLength(audit.rows.length);
  });

  test("the clinic default counts as an amount, and turning deposits off needs nothing", async () => {
    const c = await seedClinic("deposit-default");
    await connect(c.clinicId);
    await services(c.clinicId, [], { required: true, amountUsd: 80, collection: "front_desk" });
    const settings = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, getDepositSettings);
    expect(settings).toMatchObject({
      defaultAmountUsd: 80,
      hasDepositAmount: true,
      canEnable: true,
      depositsEnabled: false,
    });
    expect((await set(c.clinicId, { depositsEnabled: true })).depositsEnabled).toBe(true);
    await getMigratorPool().query(
      `update clinics set stripe_connect_account_id = null where id = $1`,
      [c.clinicId],
    );
    expect((await set(c.clinicId, { depositsEnabled: false })).depositsEnabled).toBe(false);
  });

  test("the hold and the uncollectable choice are validated with words a person can act on", async () => {
    const c = await seedClinic("deposit-validate");
    for (const minutes of [29, 1441, 45.5, "60" as unknown as number]) {
      await expect(set(c.clinicId, { depositHoldMinutes: minutes })).rejects.toMatchObject({
        field: "depositHoldMinutes",
        code: "invalid",
      });
    }
    await expect(
      set(c.clinicId, { depositUncollectable: "ignore" as never }),
    ).rejects.toBeInstanceOf(DepositSettingsError);
    await expect(set(c.clinicId, { bookChatWithoutDeposit: "yes" as never })).rejects.toMatchObject(
      { field: "bookChatWithoutDeposit" },
    );
    const saved = await set(c.clinicId, {
      depositHoldMinutes: 30,
      depositUncollectable: "hold_and_alert",
    });
    expect(saved).toMatchObject({ depositHoldMinutes: 30, depositUncollectable: "hold_and_alert" });
    expect((await set(c.clinicId, { depositHoldMinutes: 1440 })).depositHoldMinutes).toBe(1440);
  });

  test("a chat decision's record: flagged and held appointments owe the desk, a decline alerts on the request instead", async () => {
    const c = await seedClinic("deposit-outcome");
    let phone = 1000;
    const appointment = () =>
      inTenant(c.clinicId, async (client) => {
        phone += 1;
        const contact = (
          await client.query<{ id: string }>(
            `insert into contacts (clinic_id, phone) values ($1, $2) returning id`,
            [c.clinicId, `+1555040${phone}`],
          )
        ).rows[0]!.id;
        return (
          await client.query<{ id: string }>(
            `insert into appointments (clinic_id, contact_id, scheduled_for) values ($1, $2, now() + interval '1 day') returning id`,
            [c.clinicId, contact],
          )
        ).rows[0]!.id;
      });
    const read = (id: string) =>
      inTenant(
        c.clinicId,
        async (client) =>
          (
            await client.query<{ deposit_status: string; deposit_usd: string | null }>(
              `select deposit_status, deposit_usd from appointments where id = $1`,
              [id],
            )
          ).rows[0]!,
      );
    const record = (over: Partial<DepositFacts>, ref: Parameters<typeof recordDepositOutcome>[2]) =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        recordDepositOutcome(tx, depositDecision(facts(over)), ref),
      );

    const flagged = await appointment();
    const conversationId = randomUUID();
    await record(
      { bookChatWithoutDeposit: true, amountUsd: 40 },
      { appointmentId: flagged, conversationId },
    );
    expect(await read(flagged)).toEqual({
      deposit_status: "pending_front_desk",
      deposit_usd: "40.00",
    });
    const held = await appointment();
    await record(
      { canCollectNow: false, uncollectable: "hold_and_alert" },
      { appointmentId: held },
    );
    expect(await read(held)).toEqual({
      deposit_status: "pending_front_desk",
      deposit_usd: "50.00",
    });
    const requestId = randomUUID();
    await record(
      { canCollectNow: false, uncollectable: "decline_and_alert" },
      { bookingRequestId: requestId, conversationId },
    );
    const untouched = await appointment();
    await record({ canCollectNow: true }, { appointmentId: untouched });
    await record({ depositsEnabled: false }, { appointmentId: untouched });
    expect(await read(untouched)).toEqual({ deposit_status: "none", deposit_usd: null });
    expect(alerts).toEqual([
      {
        clinicId: c.clinicId,
        kind: "deposit_to_collect",
        ref: { appointmentId: flagged, conversationId },
      },
      { clinicId: c.clinicId, kind: "deposit_to_collect", ref: { appointmentId: held } },
      {
        clinicId: c.clinicId,
        kind: "deposit_to_collect",
        ref: { bookingRequestId: requestId, conversationId },
      },
    ]);
  });

  test("an operator's save of the script carries each service's deposit instead of wiping it", async () => {
    const c = await seedClinic("deposit-ops");
    const outcome = await runOperation(
      "updateAgentConfig",
      {
        clinicId: c.clinicId,
        greeting: "Thanks for calling.",
        services: [
          {
            name: "Chemical peel",
            priceFromUsd: 150,
            priceToUsd: 250,
            durationMinutes: 60,
            depositUsd: 40,
          },
          { name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 },
        ],
        depositPolicy: null,
      },
      OPERATOR,
    );
    expect((outcome.body as { data: { status: string } }).data.status).toBe("updated");
    const stored = await inTenant(c.clinicId, (client) =>
      client.query<{ services: AgentService[] }>(`select services from agent_configs`),
    );
    // With the price kind each one's prices say, and no unit, which
    // updateAgentConfig stores for a service sent without them (0056).
    expect(stored.rows[0]!.services).toEqual([
      {
        name: "Chemical peel",
        priceKind: "range",
        priceFromUsd: 150,
        priceToUsd: 250,
        unit: null,
        durationMinutes: 60,
        depositUsd: 40,
      },
      {
        name: "Consultation",
        priceKind: "exact",
        priceFromUsd: 0,
        priceToUsd: 0,
        unit: null,
        durationMinutes: 30,
      },
    ]);
    // And a deposit out of range is refused, not stored.
    const refused = await runOperation(
      "updateAgentConfig",
      {
        clinicId: c.clinicId,
        greeting: "Hi",
        services: [{ name: "Peel", depositUsd: 20_000 }],
        depositPolicy: null,
      },
      OPERATOR,
    );
    expect((refused.body as { data: { status: string; message: string } }).data).toMatchObject({
      status: "error",
      message: expect.stringMatching(/deposit must be between/),
    });
  });
});
