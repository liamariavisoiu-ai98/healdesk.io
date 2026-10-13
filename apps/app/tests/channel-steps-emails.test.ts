import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { assertPayloadAllowed } from "@/lib/email/lint";
import { deliverNotice } from "@/lib/email/outbox";
import { readUnsubscribeToken } from "@/lib/email/unsubscribe";
import { queueChannelReady } from "@/lib/notices/channel-ready";
import { sendStepsOn, STEPS_PER_DAY, stepsRecipient } from "@/lib/notices/steps-sent";
import type { DeliveryResult, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * O10 and O11 (Annex X5), phone's variants. O10 is queued through its seam
 * only for a channel ready on our side and still waiting on the clinic's
 * forwarding, once per readiness. O11 sends the forwarding steps to the
 * address the clinic names, at most three a day, never again to an address
 * that used its stop link, and refuses what this build cannot send yet:
 * website chat's line, and any steps before phone is ready.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "channel-steps-test" } as const;
const AYA = "+15125550142";

type Sent = { to: string; message: OutgoingEmail };

function capture(): EmailTransport & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    name: "capture",
    sent,
    async send(recipient, message): Promise<DeliveryResult> {
      sent.push({ to: recipient.to, message });
      return { status: "sent", messageId: `msg-${sent.length}` };
    },
  } as EmailTransport & { sent: Sent[] };
}

let clinic: PortalClinic;

describeDb("the channel step emails", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    clinic = await provisionPortalClinic("steps", { plan: "voice-webchat-1000-1000" });
    await inTenant(clinic.clinicId, async (c) => {
      await c.query(
        `update clinics set carrier = 'verizon', phone_system_type = 'landline' where id = $1`,
        [clinic.clinicId],
      );
    });
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("O11 refuses what this build can't send: website chat's line, steps before phone is ready, and a bad address", async () => {
    const send = (over: Partial<Parameters<typeof sendStepsOn>[0]>) =>
      sendStepsOn({
        clinicId: clinic.clinicId,
        channel: "voice",
        to: "maria@glowspa.test",
        actor: ACTOR,
        ayaNumberE164: AYA,
        ...over,
      });
    expect(await send({ channel: "web" })).toMatchObject({ status: "refused" });
    expect(await send({ ayaNumberE164: null })).toEqual({
      status: "refused",
      message: "Phone isn't ready for call forwarding yet, so there are no steps to send.",
    });
    expect(await send({ to: "maria at glowspa" })).toMatchObject({ status: "refused" });
    expect(stepsRecipient("  Maria@GlowSpa.test ")).toBe("maria@glowspa.test");
    expect(stepsRecipient("a@b")).toBeNull();
  });

  test("O11 sends the forwarding steps for the clinic's carrier, with who asked and the stop link, three a day", async () => {
    const transport = capture();
    const now = new Date();
    const send = (to: string) =>
      sendStepsOn(
        { clinicId: clinic.clinicId, channel: "voice", to, actor: ACTOR, ayaNumberE164: AYA },
        { transport, now },
      );

    expect(await send("Maria@GlowSpa.test")).toEqual({ status: "sent", to: "maria@glowspa.test" });
    const [first] = transport.sent;
    expect(first!.to).toBe("maria@glowspa.test");
    expect(first!.message.subject).toBe("Call forwarding steps from steps Med Spa LLC");
    expect(first!.message.text).toContain("Forward calls to: (512) 555-0142");
    expect(first!.message.text).toContain("The steps for Verizon:");
    expect(first!.message.text).toContain("To undo it at any time:");
    expect(first!.message.text).toContain(
      "You're receiving this because someone at steps Med Spa LLC asked us to send it to this address.",
    );
    const stop = /Stop these emails: (\S+)/.exec(first!.message.text)?.[1];
    expect(stop).toBeDefined();
    expect(first!.message.headers?.["List-Unsubscribe"]).toBe(`<${stop}>`);

    expect(await send("office@glowspa.test")).toMatchObject({ status: "sent" });
    expect(await send("frontdesk@glowspa.test")).toMatchObject({ status: "sent" });
    expect(await send("fourth@glowspa.test")).toEqual({
      status: "refused",
      message: expect.stringMatching(
        new RegExp(`^Steps can be sent on ${STEPS_PER_DAY} times a day`),
      ),
    });
    expect(transport.sent).toHaveLength(STEPS_PER_DAY);
    const rows = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query<{ recipient: string; status: string }>(
            `select recipient, status from report_deliveries where kind = 'steps_sent' order by period_key`,
          )
        ).rows,
    );
    expect(rows.map((r) => r.status)).toEqual(["sent", "sent", "sent"]);

    // The stop link: the address that used it gets no more, from this clinic.
    const token = decodeURIComponent(stop!.split("/email/stop/")[1]!);
    expect(readUnsubscribeToken(token)).toMatchObject({
      clinicId: clinic.clinicId,
      scope: "steps",
    });
    const { POST } = await import("@/app/email/stop/[token]/route");
    const stopped = await POST(
      new Request(`https://app.healdesk.test/email/stop/${token}`, {
        method: "POST",
        body: "List-Unsubscribe=One-Click",
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(stopped.status).toBe(200);
    // Tomorrow, on the clinic's calendar, the limit has room again, but not for her.
    const tomorrow = new Date(now.getTime() + 36 * 3_600_000);
    const later = (to: string) =>
      sendStepsOn(
        { clinicId: clinic.clinicId, channel: "voice", to, actor: ACTOR, ayaNumberE164: AYA },
        { transport, now: tomorrow },
      );
    expect(await later("maria@glowspa.test")).toEqual({
      status: "refused",
      message: expect.stringMatching(/asked us not to send these/),
    });
    expect(await later("office@glowspa.test")).toMatchObject({ status: "sent" });
  });

  test("O10 is queued only for phone waiting on forwarding, once per readiness, with a payload the allowlist passes", async () => {
    const queue = () =>
      withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        queueChannelReady(tx, { channel: "voice", ayaNumberE164: AYA }),
      );
    // Not ready on our side: nothing to say.
    expect(await queue()).toBe(false);
    const readyAt = new Date(Date.now() - 2 * 3_600_000);
    await inTenant(clinic.clinicId, async (c) => {
      await c.query(
        `update clinic_channels set ready_at = $2, waiting_on = 'forwarding' where clinic_id = $1 and channel = 'voice'`,
        [clinic.clinicId, readyAt],
      );
    });
    expect(await queue()).toBe(true);
    expect(await queue()).toBe(true);
    const notices = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query<{ dedupe_key: string; payload: Record<string, unknown> }>(
            `select dedupe_key, payload from billing_notices where kind = 'channel_ready'`,
          )
        ).rows,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.dedupe_key).toBe(`channel_ready:voice:${readyAt.toISOString()}`);
    expect(notices[0]!.payload).toMatchObject({
      channel: "voice",
      ayaNumberE164: AYA,
      carrier: "verizon",
      phoneSystem: "landline",
      routing: "conditional",
      setupUrl: expect.stringMatching(new RegExp(`/c/${clinic.clinicSlug}/setup\\?s=channels$`)),
    });
    expect(() => assertPayloadAllowed(notices[0]!.payload, "channel_ready")).not.toThrow();

    // Website chat has no ready email until its line exists, and a channel
    // whose step is done (live) gets none.
    expect(
      await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        queueChannelReady(tx, { channel: "web", ayaNumberE164: AYA }),
      ),
    ).toBe(false);
    await inTenant(clinic.clinicId, async (c) => {
      await c.query(
        `update clinic_channels set ready_at = now(), live_at = now() where clinic_id = $1 and channel = 'voice'`,
        [clinic.clinicId],
      );
    });
    expect(await queue()).toBe(false);
  });

  test("O10 waits for daytime, and is closed unsent if the clinic finished the step overnight", async () => {
    const transport = capture();
    // 22:00 and 07:30 the next morning, New York (the clinic's time zone).
    const evening = new Date("2030-01-15T03:00:00Z");
    const morning = new Date("2030-01-15T12:30:00Z");
    const ready = async (readyAt: Date) => {
      await inTenant(clinic.clinicId, async (c) => {
        await c.query(
          `update clinic_channels set ready_at = $2, waiting_on = 'forwarding', live_at = null
            where clinic_id = $1 and channel = 'voice'`,
          [clinic.clinicId, readyAt],
        );
      });
      expect(
        await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
          queueChannelReady(tx, { channel: "voice", ayaNumberE164: AYA }),
        ),
      ).toBe(true);
      return (
        await inTenant(
          clinic.clinicId,
          async (c) =>
            (
              await c.query<{ id: string }>(
                `select id from billing_notices where kind = 'channel_ready' and dedupe_key = $1`,
                [`channel_ready:voice:${readyAt.toISOString()}`],
              )
            ).rows,
        )
      )[0]!.id;
    };
    const notice = async (id: string) =>
      (
        await inTenant(
          clinic.clinicId,
          async (c) =>
            (
              await c.query<{ sent: boolean; recipients_count: number; last_error: string | null }>(
                `select sent_at is not null as sent, recipients_count, last_error
                   from billing_notices where id = $1`,
                [id],
              )
            ).rows,
        )
      )[0]!;

    // Still waiting in the morning: it goes.
    const waiting = await ready(new Date(Date.now() - 3 * 3_600_000));
    expect(await deliverNotice(clinic.clinicId, waiting, { now: evening, transport })).toBe(
      "waiting",
    );
    expect(await deliverNotice(clinic.clinicId, waiting, { now: morning, transport })).toBe("sent");
    expect(transport.sent).toHaveLength(1);

    // Forwarded overnight: by morning phone is live, and nothing is sent.
    const done = await ready(new Date(Date.now() - 2 * 3_600_000));
    expect(await deliverNotice(clinic.clinicId, done, { now: evening, transport })).toBe(
      "waiting",
    );
    await inTenant(clinic.clinicId, async (c) => {
      await c.query(
        `update clinic_channels set live_at = now(), waiting_on = null
          where clinic_id = $1 and channel = 'voice'`,
        [clinic.clinicId],
      );
    });
    expect(await deliverNotice(clinic.clinicId, done, { now: morning, transport })).toBe(
      "superseded",
    );
    expect(transport.sent).toHaveLength(1);
    expect(await notice(done)).toEqual({
      sent: true,
      recipients_count: 0,
      last_error: "not sent: the channel's last step was done before it could go",
    });
  });
});
