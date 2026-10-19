import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POST as contact } from "@/app/api/widget/v1/[slug]/contact/route";
import { POST as start } from "@/app/api/widget/v1/[slug]/start/route";
import {
  __resetContactLimitsForTests,
  CONTACT_LIMIT_PER_ADDRESS,
  CONTACT_LIMIT_PER_CLINIC,
  CONTACT_TIMES,
  readContactFields,
} from "@/lib/chat/contact-form";
import { webChatClinic } from "@/lib/chat/web-chat";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { readBookingRequestViews } from "@/lib/meta/booking-requests";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { requestWords } from "@/lib/portal/bookings";
import { addRecipient } from "@/lib/reporting/recipients";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  bindAgreementInEffect,
  inTenant,
  queuedNotices,
  seedClinic,
  seedEntitled,
  setWeekdayHours,
  type SeededClinic,
} from "./setup/factories";

/**
 * L20's source (package F): the website's contact form, what the chat widget
 * becomes while AYA is not answering. Three fields (a first name, a number,
 * one of a fixed set of times) and nothing else; kept as a booking request
 * that Bookings shows under Needs you as "left a message while AYA was off";
 * the clinic alerted at once with a pointer; rate-limited per address and
 * per clinic; refused where nothing may be kept. healdesk contacts no one:
 * the person is told the practice will call.
 */

const ORIGIN = "https://app.healdesk.test";
const ACTOR = { type: "service", serviceName: "website-message-test" } as const;
const GOOD = { firstName: "Dana", phone: "415 555 0192", preferredTime: "mornings" };

describe("the form's three fields", () => {
  test("a first name, a number and one of the fixed times, and nothing else", () => {
    expect(readContactFields(GOOD)).toEqual({
      ok: true,
      fields: { firstName: "Dana", phone: "+14155550192", time: "mornings" },
    });
    expect(CONTACT_TIMES.map((t) => t.id)).toEqual([
      "any_time",
      "mornings",
      "afternoons",
      "evenings",
    ]);
  });

  const refused: [string, Record<string, unknown>, string[]][] = [
    ["an email address", { ...GOOD, email: "dana@example.test" }, ["unknown_field"]],
    ["a free-text message", { ...GOOD, message: "I have a rash after my peel" }, ["unknown_field"]],
    ["a typed time", { ...GOOD, preferredTime: "after my chemo on Tuesday" }, ["preferred_time"]],
    ["a name with a condition in it", { ...GOOD, firstName: "Sue HIV" }, ["first_name"]],
    ["a sentence for a name", { ...GOOD, firstName: "Maria with diabetes" }, ["first_name"]],
    ["words for a number", { ...GOOD, phone: "call me tomorrow" }, ["phone"]],
    ["nothing at all", {}, ["first_name", "phone", "preferred_time"]],
  ];
  for (const [what, body, problems] of refused) {
    test(`refuses ${what}, naming the field and never its value`, () => {
      const read = readContactFields(body);
      expect(read).toEqual({ ok: false, problems });
      expect(JSON.stringify(read)).not.toMatch(/rash|chemo|HIV|diabetes|dana@/);
    });
  }

  test("Bookings words a contact-form request as a message left while AYA was off", () => {
    expect(requestWords({ source: "contact_form", channel: "web_chat", platform: null })).toEqual({
      headline: "left a message while AYA was off",
      via: "on your website's contact form",
      timeLabel: "Best time to call",
    });
    expect(requestWords({ source: "assistant", channel: "voice", platform: null })).toEqual({
      headline: "would like to book",
      via: "through a phone call",
      timeLabel: "First choice",
    });
  });
});

const describeDb = hasTestDatabase ? describe : describe.skip;

describeDb("a message left on the website", () => {
  beforeAll(async () => {
    await runMigrations();
    process.env.BETTER_AUTH_URL = ORIGIN;
  }, 180_000);

  beforeEach(async () => {
    await truncateAll();
    __resetContactLimitsForTests();
  });

  afterAll(async () => {
    await closePools();
  });

  /** A production clinic whose website chat has been live, under an agreement. */
  async function liveWeb(
    label: string,
    opts: { agreement?: boolean; liveAt?: Date | null } = {},
  ): Promise<SeededClinic> {
    const c = await seedClinic(label);
    if (opts.agreement !== false) await bindAgreementInEffect(c.clinicId);
    await setWeekdayHours(c.clinicId);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now(), website = null where id = $1`,
      [c.clinicId],
    );
    const started = new Date("2026-10-01T00:00:00Z");
    const liveAt = opts.liveAt === undefined ? started : opts.liveAt;
    await seedEntitled(c.clinicId, {
      planId: "webchat-1000",
      planStartedAt: started,
      channelRows: [{ channel: "web", liveAt }],
    });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550199" });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [
          { name: "Consultation", priceFromUsd: 150, priceToUsd: 150, durationMinutes: 30 },
        ],
        escalationPhone: null,
        escalationHours: "Weekdays 9 to 5",
        notes: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
      await addRecipient(tx, { email: "desk@website-message.test", addedBy: "test" });
    });
    return c;
  }

  async function pause(c: SeededClinic): Promise<void> {
    await inTenant(c.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, ai_paused_at) values ($1, now())
         on conflict (clinic_id) do update set ai_paused_at = now(), ai_paused_until = null`,
        [c.clinicId],
      ),
    );
  }

  function post(
    route: typeof contact,
    slug: string,
    path: string,
    body: unknown,
    ip = "203.0.113.7",
  ) {
    return route(
      new Request(`${ORIGIN}/api/widget/v1/${slug}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug }) },
    );
  }

  async function requests(c: SeededClinic) {
    return (
      await inTenant(c.clinicId, (client) =>
        client.query<{
          id: string;
          source: string;
          channel: string;
          preferred_window: string;
          conversation_id: string | null;
          status: string;
          full_name: string;
          phone: string;
        }>(
          `select r.id, r.source, r.channel, r.preferred_window, r.conversation_id, r.status, k.full_name, k.phone
             from booking_requests r join contacts k on k.id = r.contact_id order by r.created_at`,
        ),
      )
    ).rows;
  }

  test("paused: the widget offers the form; a message is kept as a request under Needs you, and the clinic gets L20, a pointer", async () => {
    const c = await liveWeb("msg-paused");
    await pause(c);
    const opened = await (await post(start, c.slug, "start", {})).json();
    expect(opened).toEqual({
      mode: "contact_form",
      reason: "ai_paused",
      form: { takesMessages: true, times: CONTACT_TIMES },
    });

    const res = await post(contact, c.slug, "contact", GOOD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mode: "received",
      reply: `Thanks. Your message is with msg-paused Clinic, and they'll call you back on the number you gave. If it's urgent, call the practice directly.`,
    });

    const rows = await requests(c);
    expect(rows).toEqual([
      expect.objectContaining({
        source: "contact_form",
        channel: "web_chat",
        preferred_window: "Mornings",
        conversation_id: null,
        status: "requested",
        full_name: "Dana",
        phone: "+14155550192",
      }),
    ]);

    // L20, queued with the request: one, a pointer into Bookings, nothing about Dana.
    const alerts = await queuedNotices(c.clinicId);
    expect(alerts.map((a) => [a.kind, a.dedupe_key])).toEqual([
      ["website_message", `website_message:request:${rows[0]!.id}`],
    ]);
    expect(alerts[0]!.payload).toMatchObject({
      channel: "web",
      portalUrl: `${ORIGIN}/c/${c.slug}/bookings`,
      bookingRequestId: rows[0]!.id,
    });
    expect(() => assertPayloadAllowed(alerts[0]!.payload, "website_message")).not.toThrow();
    expect(JSON.stringify(alerts)).not.toMatch(/Dana|0192|Mornings/);

    // Bookings' Needs you lists it, as a message left while AYA was off.
    const open = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      readBookingRequestViews(tx, { kind: "open" }),
    );
    expect(open.map((r) => [r.source, r.firstName, r.preferredWindow])).toEqual([
      ["contact_form", "Dana", "Mornings"],
    ]);
    expect(requestWords(open[0]!).headline).toBe("left a message while AYA was off");
  });

  test("switched Off, or answering when the widget's chat failed: the form takes a message too", async () => {
    const off = await liveWeb("msg-off");
    await inTenant(off.clinicId, (client) =>
      client.query(
        `update clinic_channels set enabled = false where clinic_id = $1 and channel = 'web'`,
        [off.clinicId],
      ),
    );
    expect((await (await post(start, off.slug, "start", {})).json()).form).toEqual({
      takesMessages: true,
      times: CONTACT_TIMES,
    });
    expect((await post(contact, off.slug, "contact", GOOD)).status).toBe(200);

    const answering = await liveWeb("msg-answering");
    expect((await (await post(start, answering.slug, "start", {})).json()).mode).toBe("chat");
    expect(
      (await post(contact, answering.slug, "contact", { ...GOOD, preferredTime: "evenings" }))
        .status,
    ).toBe(200);
    expect((await requests(answering)).map((r) => [r.source, r.preferred_window])).toEqual([
      ["contact_form", "Evenings"],
    ]);
  });

  test("a field the form does not have, or a typed time, keeps nothing and alerts nobody", async () => {
    const c = await liveWeb("msg-invalid");
    await pause(c);
    for (const body of [
      { ...GOOD, email: "dana@example.test" },
      { ...GOOD, message: "It's about my rash" },
      { ...GOOD, preferredTime: "Tuesday after my biopsy" },
      { ...GOOD, firstName: "Cancer Patient" },
    ]) {
      const res = await post(
        contact,
        c.slug,
        "contact",
        body,
        `198.51.100.${Math.floor(Math.random() * 200)}`,
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).not.toMatch(/rash|biopsy|Cancer|dana@/);
    }
    expect(await requests(c)).toEqual([]);
    expect(await queuedNotices(c.clinicId)).toEqual([]);
  });

  test("nothing is kept where nothing may be: no agreement, website chat never live, or a clinic that has left", async () => {
    const unsigned = await liveWeb("msg-unsigned", { agreement: false });
    const notLive = await liveWeb("msg-not-live", { liveAt: null });
    const left = await liveWeb("msg-left");
    await getMigratorPool().query(
      `update clinics set offboarding_started_at = now() where id = $1`,
      [left.clinicId],
    );

    // A clinic that has left is not served at all: the widget's lookup
    // (app_web_chat_clinic) no longer finds it, so neither route reaches it.
    expect((await post(start, left.slug, "start", {})).status).toBe(404);
    expect((await post(contact, left.slug, "contact", GOOD)).status).toBe(404);
    expect(await requests(left)).toEqual([]);

    for (const c of [unsigned, notLive]) {
      const opened = await (await post(start, c.slug, "start", {})).json();
      expect(opened.mode, c.slug).toBe("contact_form");
      expect(opened.form, c.slug).toEqual({ takesMessages: false, times: CONTACT_TIMES });
      const res = await post(contact, c.slug, "contact", GOOD);
      expect(res.status, c.slug).toBe(409);
      expect(await res.json()).toEqual({ mode: "closed" });
      expect(await requests(c)).toEqual([]);
      expect(await queuedNotices(c.clinicId)).toEqual([]);
    }
  });

  test("rate-limited per address and clinic, and per clinic across addresses", async () => {
    const c = await liveWeb("msg-limits");
    await pause(c);
    for (let i = 0; i < CONTACT_LIMIT_PER_ADDRESS; i += 1) {
      expect((await post(contact, c.slug, "contact", GOOD, "203.0.113.50")).status).toBe(200);
    }
    expect((await post(contact, c.slug, "contact", GOOD, "203.0.113.50")).status).toBe(429);

    // Across addresses, the clinic's own hourly count, read from its requests.
    let n = CONTACT_LIMIT_PER_ADDRESS;
    for (let i = 0; n < CONTACT_LIMIT_PER_CLINIC; i += 1, n += 1) {
      expect((await post(contact, c.slug, "contact", GOOD, `198.51.100.${i + 1}`)).status).toBe(
        200,
      );
    }
    const over = await post(contact, c.slug, "contact", GOOD, "192.0.2.200");
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect(await requests(c)).toHaveLength(CONTACT_LIMIT_PER_CLINIC);
  });

  test("how a request was taken never changes: the runtime role cannot write it, and the trigger refuses the owner", async () => {
    const c = await liveWeb("msg-frozen");
    await pause(c);
    expect((await post(contact, c.slug, "contact", GOOD)).status).toBe(200);
    const [row] = await requests(c);
    const { rows } = await getMigratorPool().query<{ ok: boolean }>(
      `select has_column_privilege('healdesk_app', 'booking_requests'::regclass, 'source', 'UPDATE') as ok`,
    );
    expect(rows[0]!.ok).toBe(false);
    await expect(
      inTenant(c.clinicId, (client) =>
        client.query(`update booking_requests set source = 'assistant' where id = $1`, [row!.id]),
      ),
    ).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(/only the decision columns may change/),
    });
    // A contact-form request is web chat's, with no conversation (CHECK).
    const app = await getAppPool().connect();
    try {
      await app.query("begin");
      await app.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      await expect(
        app.query(
          `insert into booking_requests (clinic_id, contact_id, channel, preferred_window, token_hash, expires_at, source)
           select clinic_id, contact_id, 'voice', 'Mornings', decode(repeat('ab', 32), 'hex'), now() + interval '7 days', 'contact_form'
             from booking_requests where id = $1`,
          [row!.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await app.query("rollback");
      app.release();
    }
  });

  test("no one is contacted: nothing is emailed at all when a message is left, the alert waits for the sender", async () => {
    const c = await liveWeb("msg-quiet");
    await pause(c);
    expect((await post(contact, c.slug, "contact", GOOD)).status).toBe(200);
    // L20 is normal priority: queued, unsent until the minute sender runs, and
    // then only to the clinic's one address. There is no field the person's
    // own address could even arrive in.
    expect((await queuedNotices(c.clinicId)).map((a) => [a.kind, a.sent_at])).toEqual([
      ["website_message", null],
    ]);
    const clinic = await webChatClinic(c.slug);
    expect(clinic?.clinicId).toBe(c.clinicId);
  });
});
