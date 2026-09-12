import { getPlan } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { seedEntitlements } from "@/lib/billing/entitlements";
import { clinicIdForStripe } from "@/lib/billing/resolve";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * Entitlements isolation.
 *
 * No PHI in these tables, but the same two locks apply and for a reason that
 * is easy to underrate: a webhook that reads or writes the wrong clinic's row
 * suspends a paying customer or activates one who never paid. So the tests
 * assume the application forgot its clinic filter and check the database
 * refuses anyway — the same posture as tests/tenant-isolation.test.ts.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

const chatVoice = getPlan("chat-voice")!;
const voiceOnly = getPlan("voice")!;

describeDb("entitlements", () => {
  let clinicA: string;
  let clinicB: string;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();

    clinicA = (await seedClinic("enta")).clinicId;
    clinicB = (await seedClinic("entb")).clinicId;

    // Seeded the way provisioning does it: as the runtime role, inside a
    // declared tenant, so the insert itself proves the WITH CHECK half.
    await withTenant({ clinicId: clinicA, actor: { type: "system" } }, (tx) =>
      seedEntitlements(tx.db, clinicA, {
        plan: chatVoice,
        interval: "month",
        chatChannelChoice: "meta",
        stripeCustomerId: "cus_enta",
        stripeSubscriptionId: "sub_enta",
      }),
    );
    await withTenant({ clinicId: clinicB, actor: { type: "system" } }, (tx) =>
      seedEntitlements(tx.db, clinicB, {
        plan: voiceOnly,
        interval: "year",
        stripeCustomerId: "cus_entb",
        stripeSubscriptionId: "sub_entb",
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("seeds allowances and channels from the package, honouring the chat choice", async () => {
    const rows = await inTenant(clinicA, (client) =>
      client.query<{
        status: string;
        plan_code: string;
        billing_interval: string;
        chat_channel_choice: string | null;
        channels_enabled: { web: boolean; meta: boolean; voice: boolean };
        included_voice_minutes: number;
        included_chat_conversations: number;
      }>(`select * from entitlements where clinic_id = $1`, [clinicA]),
    );
    const row = rows.rows[0]!;

    // A subscription to wait on, so provisioning until the first invoice.
    expect(row.status).toBe("provisioning");
    expect(row.plan_code).toBe("chat-voice");
    expect(row.billing_interval).toBe("month");
    // "Web OR Meta": the catalog lists both, the buyer picked one.
    expect(row.chat_channel_choice).toBe("meta");
    expect(row.channels_enabled).toEqual({ web: false, meta: true, voice: true });
    expect(row.included_voice_minutes).toBe(chatVoice.includedVoiceMinutes);
    expect(row.included_chat_conversations).toBe(
      chatVoice.includedChatConversations,
    );

    // The one transition row with no `from`.
    const history = await inTenant(clinicA, (client) =>
      client.query<{ from_status: string | null; to_status: string; reason: string }>(
        `select from_status, to_status, reason from billing_transitions where clinic_id = $1`,
        [clinicA],
      ),
    );
    expect(history.rows).toEqual([
      { from_status: null, to_status: "provisioning", reason: "provisioned" },
    ]);
  });

  test("a package without the choice ignores it and enables what it sells", async () => {
    const rows = await inTenant(clinicB, (client) =>
      client.query<{
        chat_channel_choice: string | null;
        channels_enabled: { web: boolean; meta: boolean; voice: boolean };
        included_chat_conversations: number;
      }>(`select * from entitlements where clinic_id = $1`, [clinicB]),
    );
    const row = rows.rows[0]!;
    expect(row.chat_channel_choice).toBeNull();
    expect(row.channels_enabled).toEqual({ web: false, meta: false, voice: true });
    // Zero, not missing: a fact the UI can render.
    expect(row.included_chat_conversations).toBe(0);
  });

  test("clinic A's tenant transaction cannot read clinic B's row", async () => {
    const seen = await withTenant(
      { clinicId: clinicA, actor: { type: "system" } },
      async (tx) => {
        const byKey = await tx.db.execute<{ clinic_id: string }>(
          `select clinic_id from entitlements where clinic_id = '${clinicB}'`,
        );
        const all = await tx.db.execute<{ clinic_id: string }>(
          `select clinic_id from entitlements`,
        );
        return { byKey: byKey.rows, all: all.rows };
      },
    );

    // Not an error — zero rows, exactly as if B did not exist.
    expect(seen.byKey).toHaveLength(0);
    expect(seen.all.map((r) => r.clinic_id)).toEqual([clinicA]);
  });

  test("clinic A's tenant transaction cannot write clinic B's row", async () => {
    await withTenant(
      { clinicId: clinicA, actor: { type: "system" } },
      async (tx) => {
        // UPDATE filtered by the USING half: zero rows, silently.
        const updated = await tx.db.execute(
          `update entitlements set plan_code = 'complete' where clinic_id = '${clinicB}' returning clinic_id`,
        );
        expect(updated.rows).toHaveLength(0);

        // INSERT refused by the WITH CHECK half: 42501, loudly.
        await expect(
          tx.db.execute(
            `insert into billing_transitions (clinic_id, to_status, actor, reason)
             values ('${clinicB}', 'active', 'support', 'forged')`,
          ),
        ).rejects.toMatchObject({ cause: { code: "42501" } });
      },
    ).catch((error: unknown) => {
      // The failed insert aborted the transaction; withTenant rethrows the
      // expectation-free rollback. Only a 42501 may reach here.
      if (!/42501|aborted/.test(String(error))) throw error;
    });

    const plan = await inTenant(clinicB, (client) =>
      client.query<{ plan_code: string }>(
        `select plan_code from entitlements where clinic_id = $1`,
        [clinicB],
      ),
    );
    expect(plan.rows[0]!.plan_code).toBe("voice");
  });

  test("with no tenant set, the runtime role sees nothing at all", async () => {
    const { rows } = await getAppPool().query(`select clinic_id from entitlements`);
    expect(rows).toHaveLength(0);
  });

  test("the runtime role cannot DELETE entitlements or rewrite the history", async () => {
    const app = getAppPool();
    await expect(app.query(`delete from entitlements`)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      app.query(`update billing_transitions set reason = 'edited'`),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      app.query(`delete from billing_transitions`),
    ).rejects.toMatchObject({ code: "42501" });
  });

  test("resolves a clinic from Stripe ids without a tenant, subscription first", async () => {
    // The runtime role, no tenant declared: the definer function is the only
    // way this can answer, and it must answer with an id and nothing else.
    expect(await clinicIdForStripe("cus_enta", null)).toBe(clinicA);
    expect(await clinicIdForStripe(null, "sub_entb")).toBe(clinicB);
    // Conflicting ids: the subscription is the precise one and wins.
    expect(await clinicIdForStripe("cus_enta", "sub_entb")).toBe(clinicB);
    expect(await clinicIdForStripe("cus_nobody", "sub_nobody")).toBeNull();
    expect(await clinicIdForStripe(null, null)).toBeNull();
  });

  test("two clinics cannot claim the same subscription", async () => {
    const clinicC = (await seedClinic("entc")).clinicId;
    await expect(
      withTenant({ clinicId: clinicC, actor: { type: "system" } }, (tx) =>
        seedEntitlements(tx.db, clinicC, {
          plan: voiceOnly,
          interval: "month",
          stripeCustomerId: "cus_entc",
          stripeSubscriptionId: "sub_enta",
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });
});
