import { URGENT_TEAM_TOLD_LINE } from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { assistantFacts } from "@/lib/assistant/facts";
import { answerTurn } from "@/lib/assistant/turn";
import { emailTransportConfigured, urgentAlertReadiness } from "@/lib/notices/urgent-readiness";
import type { DeliveryResult, EmailTransport } from "@/lib/reporting/deliver";
import { JOB_BILLING_NOTICES, setJobEnabled } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, type SeededClinic } from "./setup/factories";

/**
 * ALERT-01: "I've told the team" is said only while an urgent alert raised
 * now would reach the clinic: the sender's switch on, an email transport
 * configured and an address the outbox would send L12 to. Each missing
 * condition on its own is enough to withhold the line. Nothing is sent: the
 * transport is a fake that is never called, and the environment is passed
 * in rather than set, so no test here can reach Resend.
 */

const RESEND_ENV = {
  HEALDESK_EMAIL_TRANSPORT: "resend",
  RESEND_API_KEY: "re_placeholder_for_presence_only",
  HEALDESK_EMAIL_FROM: "healdesk <hello@example.test>",
};

describe("emailTransportConfigured", () => {
  test("only Resend with its key and its sender present", () => {
    expect(emailTransportConfigured(RESEND_ENV)).toBe(true);
    expect(emailTransportConfigured({})).toBe(false);
    expect(emailTransportConfigured({ ...RESEND_ENV, HEALDESK_EMAIL_TRANSPORT: "console" })).toBe(false);
    expect(emailTransportConfigured({ ...RESEND_ENV, HEALDESK_EMAIL_TRANSPORT: undefined })).toBe(false);
    expect(emailTransportConfigured({ ...RESEND_ENV, RESEND_API_KEY: undefined })).toBe(false);
    expect(emailTransportConfigured({ ...RESEND_ENV, RESEND_API_KEY: "  " })).toBe(false);
    // The host's placeholder for a parameter nobody has pasted yet.
    expect(emailTransportConfigured({ ...RESEND_ENV, RESEND_API_KEY: "__unset__" })).toBe(false);
    expect(emailTransportConfigured({ ...RESEND_ENV, HEALDESK_EMAIL_FROM: undefined })).toBe(false);
  });
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "urgent-readiness-test" } as const;

class NeverCalled implements EmailTransport {
  readonly name = "never-called";
  async send(): Promise<DeliveryResult> {
    throw new Error("readiness must never send");
  }
}

describeDb("urgentAlertReadiness, against the real tables", () => {
  let c: SeededClinic;

  beforeAll(async () => {
    await runMigrations();
  }, 180_000);

  beforeEach(async () => {
    await truncateAll();
    c = await seedClinic("urgent-ready");
  });

  afterAll(async () => {
    await closePools();
  });

  const read = (options: { transport?: EmailTransport; environment?: Record<string, string | undefined> }) =>
    withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => urgentAlertReadiness(tx, options));

  async function noAddress(): Promise<void> {
    // clinic_memberships is forced: the tenant is declared first.
    await inTenant(c.clinicId, (client) =>
      client.query(`update clinic_memberships set revoked_at = now() where clinic_id = $1`, [c.clinicId]),
    );
  }

  test("ready only when the sender is on, a transport is configured and the clinic has an address", async () => {
    await setJobEnabled(JOB_BILLING_NOTICES, true, c.staffUserId);
    expect(await read({ environment: RESEND_ENV })).toEqual({ ready: true, missing: [] });
    // A transport handed to the outbox counts as configured, whatever the environment.
    expect(await read({ transport: new NeverCalled(), environment: {} })).toEqual({ ready: true, missing: [] });
  });

  test("the sender's switch off: not ready", async () => {
    await setJobEnabled(JOB_BILLING_NOTICES, false, c.staffUserId);
    expect(await read({ environment: RESEND_ENV })).toEqual({ ready: false, missing: ["sender_off"] });
  });

  test("no transport: not ready", async () => {
    await setJobEnabled(JOB_BILLING_NOTICES, true, c.staffUserId);
    expect(await read({ environment: { ...RESEND_ENV, RESEND_API_KEY: undefined } })).toEqual({
      ready: false,
      missing: ["no_transport"],
    });
    expect(await read({ environment: {} })).toEqual({ ready: false, missing: ["no_transport"] });
  });

  test("no address the outbox would send L12 to: not ready", async () => {
    await setJobEnabled(JOB_BILLING_NOTICES, true, c.staffUserId);
    await noAddress();
    expect(await read({ environment: RESEND_ENV })).toEqual({ ready: false, missing: ["no_recipient"] });
  });

  test("all three missing are all reported, and the caller's transaction survives the reads", async () => {
    await noAddress();
    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      const readiness = await urgentAlertReadiness(tx, { environment: {} });
      // Still usable after the savepoint.
      const facts = await assistantFacts(tx);
      return { readiness, facts };
    });
    expect(result.readiness).toEqual({ ready: false, missing: ["sender_off", "no_transport", "no_recipient"] });
    expect(result.facts?.urgentAlertsReady).toBe(false);
  });

  test("the facts carry it, and the fixed urgent reply says the team was told only when it is true", async () => {
    const reply = async () => {
      const facts = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        assistantFacts(tx, { alertTransport: new NeverCalled() }),
      );
      const turn = await answerTurn({ facts: facts!, channel: "web_chat", history: [], text: "it won't stop bleeding", responder: null });
      return turn.reply;
    };
    await setJobEnabled(JOB_BILLING_NOTICES, true, c.staffUserId);
    expect(await reply()).toContain(URGENT_TEAM_TOLD_LINE);

    await setJobEnabled(JOB_BILLING_NOTICES, false, c.staffUserId);
    const senderOff = await reply();
    expect(senderOff).not.toContain(URGENT_TEAM_TOLD_LINE);
    expect(senderOff).toMatch(/call 911/);

    await setJobEnabled(JOB_BILLING_NOTICES, true, c.staffUserId);
    await noAddress();
    const noRecipient = await reply();
    expect(noRecipient).not.toContain(URGENT_TEAM_TOLD_LINE);
    expect(noRecipient).toMatch(/call 911/);
  });

  test("with no transport handed in, the process environment decides", async () => {
    await setJobEnabled(JOB_BILLING_NOTICES, true, c.staffUserId);
    const saved = process.env.HEALDESK_EMAIL_TRANSPORT;
    delete process.env.HEALDESK_EMAIL_TRANSPORT;
    try {
      const facts = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => assistantFacts(tx));
      expect(facts?.urgentAlertsReady).toBe(false);
    } finally {
      if (saved !== undefined) process.env.HEALDESK_EMAIL_TRANSPORT = saved;
    }
  });
});
