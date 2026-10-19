import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { assertPayloadAllowed } from "@/lib/email/lint";
import { deliverNotice } from "@/lib/email/outbox";
import { readUnsubscribeToken } from "@/lib/email/unsubscribe";
import { queueChannelReady } from "@/lib/notices/channel-ready";
import { sendStepsOn, STEPS_PER_DAY, stepsRecipient } from "@/lib/notices/steps-sent";
import type { DeliveryResult, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { publicUrl } from "@/lib/public-url";
import { widgetSnippet } from "@/lib/setup/snippet";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * O10 and O11 (Annex X5), phone's and website chat's. O10 is queued through
 * its seam only for a channel ready on our side and still waiting on the
 * clinic's own step (phone's forwarding, website chat's line), once per
 * readiness, and closed unsent if the step is done before it goes. O11 sends
 * the forwarding steps or the website line to the address the clinic names,
 * at most three a day in all, never again to an address that used its stop
 * link, and refuses what it cannot send: any steps before phone is ready, the
 * line before website chat is open, and the Meta channels, whose step is the
 * clinic's own login.
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

  test("O11 refuses what it can't send: website chat's line before the channel is open, steps before phone is ready, the Meta login, and a bad address", async () => {
    const send = (over: Partial<Parameters<typeof sendStepsOn>[0]>) =>
      sendStepsOn({
        clinicId: clinic.clinicId,
        channel: "voice",
        to: "maria@glowspa.test",
        actor: ACTOR,
        ayaNumberE164: AYA,
        ...over,
      });
    // Website chat is not ready on our side here, so there is no line yet.
    expect(await send({ channel: "web", ayaNumberE164: null })).toEqual({
      status: "refused",
      message:
        "Website chat isn't ready yet, so there's no line to send. It appears here when it is.",
    });
    expect(await send({ channel: "meta" })).toMatchObject({ status: "refused" });
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
      // The coverage mode itself (the default here), never call_routing's collapse of it.
      routing: "overflow_after_hours",
      setupUrl: expect.stringMatching(new RegExp(`/c/${clinic.clinicSlug}/setup\\?s=channels$`)),
    });
    expect(() => assertPayloadAllowed(notices[0]!.payload, "channel_ready")).not.toThrow();

    // Website chat not ready on our side gets none, nor does the Meta
    // channel, whose step is a login, and a channel whose step is done
    // (live) gets none.
    for (const channel of ["web", "meta"] as const) {
      expect(
        await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
          queueChannelReady(tx, { channel }),
        ),
        channel,
      ).toBe(false);
    }
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
  test("O11's steps follow the coverage mode: After hours only gets all-call forwarding at closing and *73, never the busy and no-answer codes", async () => {
    await inTenant(clinic.clinicId, (c) =>
      c.query(
        `insert into clinic_settings (clinic_id, coverage_mode) values ($1, 'after_hours_only')
         on conflict (clinic_id) do update set coverage_mode = 'after_hours_only'`,
        [clinic.clinicId],
      ),
    );
    try {
      const transport = capture();
      // A later day on the clinic's calendar, so the three-a-day limit has room.
      const now = new Date(Date.now() + 5 * 86_400_000);
      expect(
        await sendStepsOn(
          {
            clinicId: clinic.clinicId,
            channel: "voice",
            to: "closing@glowspa.test",
            actor: ACTOR,
            ayaNumberE164: AYA,
          },
          { transport, now },
        ),
      ).toMatchObject({ status: "sent" });
      const text = transport.sent[0]!.message.text;
      expect(text).toContain("*725125550142");
      expect(text).toMatch(/when you close/);
      expect(text).toContain("Cancel all-call forwarding: *73");
      // Verizon's busy and no-answer codes: *42 or *41, cancelled with *43,
      // on a home phone, and *71 on a mobile line; and the *90 to *93 family.
      expect(text).not.toMatch(/\*9[0-3]|\*4[1-3]|\*71/);
    } finally {
      await inTenant(clinic.clinicId, (c) =>
        c.query(
          `update clinic_settings set coverage_mode = 'overflow_after_hours' where clinic_id = $1`,
          [clinic.clinicId],
        ),
      );
    }
  });
  test("O11 sends website chat's line once the channel is open, within the same three a day, and its stop link stops both channels' mail", async () => {
    const transport = capture();
    // Days of their own on the clinic's calendar, so the earlier sends don't count.
    const day = new Date(Date.now() + 10 * 86_400_000);
    const nextDay = new Date(day.getTime() + 86_400_000);
    const send = (channel: "voice" | "web", to: string, now = day) =>
      sendStepsOn(
        {
          clinicId: clinic.clinicId,
          channel,
          to,
          actor: ACTOR,
          ayaNumberE164: channel === "voice" ? AYA : null,
        },
        { transport, now },
      );
    const line = `<script src="${publicUrl("/widget/v1.js")}" data-clinic="${clinic.clinicSlug}" async></script>`;

    await inTenant(clinic.clinicId, (c) =>
      c.query(
        `update clinic_channels set ready_at = now(), waiting_on = 'snippet', live_at = null
          where clinic_id = $1 and channel = 'web'`,
        [clinic.clinicId],
      ),
    );
    try {
      expect(await send("web", "Web@Agency.test")).toEqual({ status: "sent", to: "web@agency.test" });
      const [web] = transport.sent;
      expect(web!.message.subject).toBe("Website chat line from steps Med Spa LLC");
      // The line exactly as the wizard and Settings print it, on its own line.
      expect(widgetSnippet(clinic.clinicSlug)).toBe(line);
      expect(web!.message.text.split("\n")).toContain(line);
      expect(web!.message.text).toContain(
        "steps Med Spa LLC asked us to send you this line for its website. Paste it once, just before </body>, on every page of the site",
      );
      expect(web!.message.text).not.toContain("Forward calls to");
      expect(web!.message.text).toContain(
        "You're receiving this because someone at steps Med Spa LLC asked us to send it to this address.",
      );
      const stop = /Stop these emails: (\S+)/.exec(web!.message.text)?.[1];
      expect(stop).toBeDefined();
      expect(web!.message.headers?.["List-Unsubscribe"]).toBe(`<${stop}>`);

      // One limit for the clinic, whichever channel's step goes.
      expect(await send("voice", "office@glowspa.test")).toMatchObject({ status: "sent" });
      expect(await send("voice", "frontdesk@glowspa.test")).toMatchObject({ status: "sent" });
      expect(await send("web", "other@agency.test")).toEqual({
        status: "refused",
        message: expect.stringMatching(new RegExp(`^Steps can be sent on ${STEPS_PER_DAY} times a day`)),
      });
      expect(transport.sent).toHaveLength(STEPS_PER_DAY);

      // The web person stops them: from then on neither the line nor the phone
      // steps reach that address from this clinic, on any day.
      const token = decodeURIComponent(stop!.split("/email/stop/")[1]!);
      const { POST } = await import("@/app/email/stop/[token]/route");
      const stopped = await POST(
        new Request(`https://app.healdesk.test/email/stop/${token}`, {
          method: "POST",
          body: "List-Unsubscribe=One-Click",
        }),
        { params: Promise.resolve({ token }) },
      );
      expect(stopped.status).toBe(200);
      for (const channel of ["web", "voice"] as const) {
        expect(await send(channel, "web@agency.test", nextDay), channel).toEqual({
          status: "refused",
          message: expect.stringMatching(/asked us not to send these/),
        });
      }
      expect(await send("web", "other@agency.test", nextDay)).toMatchObject({ status: "sent" });
      expect(transport.sent).toHaveLength(STEPS_PER_DAY + 1);
    } finally {
      await inTenant(clinic.clinicId, (c) =>
        c.query(
          `update clinic_channels set ready_at = null, waiting_on = null where clinic_id = $1 and channel = 'web'`,
          [clinic.clinicId],
        ),
      );
    }
  });

  test("O10 for website chat: queued once its line is the step left, it carries the line, and goes unsent once the line is seen on the site", async () => {
    const transport = capture();
    // 10:00 in New York, the clinic's time zone: daytime, so the outbox sends.
    const morning = new Date("2030-02-05T15:00:00Z");
    const queue = () =>
      withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        queueChannelReady(tx, { channel: "web" }),
      );
    const ready = async (readyAt: Date, waitingOn: string) =>
      inTenant(clinic.clinicId, (c) =>
        c.query(
          `update clinic_channels set ready_at = $2, waiting_on = $3, live_at = null
            where clinic_id = $1 and channel = 'web'`,
          [clinic.clinicId, readyAt, waitingOn],
        ),
      );
    const noticeFor = async (readyAt: Date) =>
      (
        await inTenant(
          clinic.clinicId,
          async (c) =>
            (
              await c.query<{ id: string; payload: Record<string, unknown> }>(
                `select id, payload from billing_notices where kind = 'channel_ready' and dedupe_key = $1`,
                [`channel_ready:web:${readyAt.toISOString()}`],
              )
            ).rows,
        )
      );

    try {
      // Ready, but setup is still the clinic's step: nothing about the line yet.
      const first = new Date(Date.now() - 2 * 3_600_000);
      await ready(first, "setup");
      expect(await queue()).toBe(false);

      // The line is the step left: one notice, however often asked.
      await ready(first, "snippet");
      expect(await queue()).toBe(true);
      expect(await queue()).toBe(true);
      const [notice] = await noticeFor(first);
      expect(await noticeFor(first)).toHaveLength(1);
      // The line's two parts, never the line itself (Annex X4's allowlist).
      expect(Object.keys(notice!.payload).sort()).toEqual([
        "channel",
        "clinicSlug",
        "helpPhoneE164",
        "scriptUrl",
        "settingsUrl",
      ]);
      expect(notice!.payload).toMatchObject({
        channel: "web",
        scriptUrl: publicUrl("/widget/v1.js"),
        clinicSlug: clinic.clinicSlug,
        settingsUrl: publicUrl(`/c/${clinic.clinicSlug}/settings#website-line`),
      });
      expect(() => assertPayloadAllowed(notice!.payload, "channel_ready")).not.toThrow();
      expect(await deliverNotice(clinic.clinicId, notice!.id, { now: morning, transport })).toBe(
        "sent",
      );
      expect(transport.sent).toHaveLength(1);
      const { message } = transport.sent[0]!;
      expect(message.subject).toBe("Website chat is ready: one step left");
      expect(message.text.split("\n")).toContain(widgetSnippet(clinic.clinicSlug));
      expect(message.text).toContain(`/c/${clinic.clinicSlug}/settings#website-line`);

      // Seen on the site before it could go (an operator's confirmation moves
      // the channel off its line): closed unsent.
      const second = new Date(Date.now() - 3_600_000);
      await ready(second, "snippet");
      expect(await queue()).toBe(true);
      const [late] = await noticeFor(second);
      await inTenant(clinic.clinicId, (c) =>
        c.query(
          `update clinic_channels set waiting_on = null where clinic_id = $1 and channel = 'web'`,
          [clinic.clinicId],
        ),
      );
      expect(await deliverNotice(clinic.clinicId, late!.id, { now: morning, transport })).toBe(
        "superseded",
      );
      expect(transport.sent).toHaveLength(1);
    } finally {
      await inTenant(clinic.clinicId, (c) =>
        c.query(
          `update clinic_channels set ready_at = null, waiting_on = null, live_at = null
            where clinic_id = $1 and channel = 'web'`,
          [clinic.clinicId],
        ),
      );
    }
  });
});
