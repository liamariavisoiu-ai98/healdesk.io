import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  CALLBACK_DIAL_MARGIN_MINUTES,
  HEALTHCARE_EXEMPTION,
  QUIET_HOURS_START,
  canContact,
  isCallbackStopRequest,
  isStopRequest,
  outboundContactEnabled,
  recordAttempt,
  suppress,
} from "@/lib/compliance/contact-policy";
import {
  callbackDisclosure,
  channelMayCarryPhi,
  disclosureFor,
  metaChannelGreeting,
  voiceDisclosure,
} from "@/lib/compliance/disclosure";
import { consentRecords } from "@/db/schema";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { seedClinic } from "./setup/factories";

/**
 * TCPA and disclosure controls.
 *
 * FCC 24-17 confirmed an AI voice is an "artificial voice" under §227(b)(1),
 * independent of autodialer status — so every outbound call needs consent, and
 * statutory damages are $500–1,500 each with a ready-made class. These tests
 * exist because the cost of being wrong is measured per call.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const PHONE = "+15551230000";
/** 16:00Z = noon in New York (EDT), inside the window on either coast. */
const NOON_NEW_YORK = new Date("2026-09-14T16:00:00Z");

const actor = { type: "service" as const, serviceName: "test" };

describe("stop request detection", () => {
  test("catches the carrier keywords", () => {
    for (const message of ["STOP", "stop", "Unsubscribe", "opt out", "QUIT"]) {
      expect(isStopRequest(message), message).toBe(true);
    }
  });

  test("catches plain English, not just the magic words", () => {
    // The TCPA does not require someone to say STOP. Matching loosely costs a
    // lead; matching narrowly costs $500 a call.
    for (const message of [
      "please don't call me again",
      "stop calling me",
      "take me off your list",
      "no more texts please",
      "Do not contact me",
    ]) {
      expect(isStopRequest(message), message).toBe(true);
    }
  });

  test("does not fire on ordinary replies", () => {
    for (const message of [
      "Yes please book me in",
      "Can you tell me the price?",
      "Thanks!",
    ]) {
      expect(isStopRequest(message), message).toBe(false);
    }
  });
});

describe("disclosure", () => {
  test("the voice opener states AI, transcription, and that no audio is kept", () => {
    const text = voiceDisclosure({ clinicName: "Radiance", channel: "voice" });

    expect(text).toMatch(/not a human/i);
    // No audio is kept (21 September 2026): the opener must say so and must
    // not claim the call is recorded.
    expect(text).toMatch(/no audio recording is kept/i);
    expect(text).not.toMatch(/is recorded/i);
    // Transcription specifically: the CIPA exposure in Ambriz is about a third
    // party intercepting call CONTENTS, which disclosing "recording" alone
    // does not describe.
    expect(text).toMatch(/transcribed/i);
    expect(text).toMatch(/representative/i);
  });

  test("Meta channels get a warning, not a welcome — and it promises phone, never text", () => {
    const text = disclosureFor({
      clinicName: "Radiance",
      channel: "instagram_dm",
    });
    expect(text).toMatch(/isn't secure/i);
    expect(text).toMatch(/don't share medical details/i);
    // §G.4: healdesk sends no texts, so the greeting may not offer one.
    expect(metaChannelGreeting({ clinicName: "Radiance", channel: "whatsapp" })).toMatch(/continue by phone\.$/);
    expect(metaChannelGreeting({ clinicName: "Radiance", channel: "whatsapp" })).not.toMatch(/\btext\b/i);
  });

  test("the callback greeting says AI, why we are calling, the practice's number, and how to stop — first and verbatim (§F.7)", () => {
    const text = callbackDisclosure({ clinicName: "Radiance", clinicPhoneSpoken: "four one five — five five five — oh one nine nine" });
    expect(text).toBe(
      "Hi, this is the automated AI assistant for Radiance — not a human — calling back about the booking request you made with us. " +
        "This call is transcribed by an automated system; no audio recording is kept. " +
        "If you'd rather we didn't call, say 'stop' or press 1 at any time and we won't call again; you can also tell the practice on four one five — five five five — oh one nine nine. " +
        "Say 'representative' or press 0 to reach a person. Is now an okay time?",
    );
    // §64.1200(b): the number is spoken, never the E.164 string, and the
    // opt-out is stated at the outset; no time, service or practitioner.
    expect(text).not.toMatch(/\+1|\d{3}/);
    expect(text).not.toMatch(/\b\d{1,2}(:\d{2})?\s?(am|pm)\b|botox|consult|dr\b/i);
    expect(text.split(/\s+/).length).toBeLessThan(90);
  });

  test("Meta channels are marked as unable to carry PHI", () => {
    // Meta states in its own Cloud API terms that it is not a Business
    // Associate. No configuration changes that.
    expect(channelMayCarryPhi("instagram_dm")).toBe(false);
    expect(channelMayCarryPhi("whatsapp")).toBe(false);
    expect(channelMayCarryPhi("voice")).toBe(true);
    expect(channelMayCarryPhi("sms")).toBe(true);
  });
});

describeDb("contact policy", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  async function grantConsent(
    clinicId: string,
    type: "express" | "express_written",
    phone = PHONE,
  ) {
    await withTenant({ clinicId, actor }, async (tx) => {
      await tx.db.insert(consentRecords).values({
        clinicId,
        phone,
        channel: "voice",
        consentType: type,
        source: "web_form",
        exactWording: "I agree to be contacted about my appointment.",
      });
    });
  }

  test("refuses without consent on file", async () => {
    const clinic = await seedClinic("tcpa-a");

    const decision = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      canContact(tx.db, {
        policyOnly: true,
        clinicEnabled: true,
        clinicId: clinic.clinicId,
        phone: PHONE,
        channel: "voice",
        purpose: "reminder",
        recipientTimezone: "America/New_York",
        now: NOON_NEW_YORK,
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe("no_consent");
  });

  test("allows a reminder with express consent", async () => {
    const clinic = await seedClinic("tcpa-b");
    await grantConsent(clinic.clinicId, "express");

    const decision = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      canContact(tx.db, {
        policyOnly: true,
        clinicEnabled: true,
        clinicId: clinic.clinicId,
        phone: PHONE,
        channel: "voice",
        purpose: "reminder",
        recipientTimezone: "America/New_York",
        now: NOON_NEW_YORK,
      }),
    );

    expect(decision.allowed).toBe(true);
  });

  test("refuses reactivation without WRITTEN consent", async () => {
    // "We miss you, book again" is marketing however warmly it's phrased, and
    // marketing needs prior express written consent.
    const clinic = await seedClinic("tcpa-c");
    await grantConsent(clinic.clinicId, "express");

    const decision = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      canContact(tx.db, {
        policyOnly: true,
        clinicEnabled: true,
        clinicId: clinic.clinicId,
        phone: PHONE,
        channel: "voice",
        purpose: "reactivation",
        recipientTimezone: "America/New_York",
        now: NOON_NEW_YORK,
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe(
      "needs_written_consent",
    );
  });

  test("allows reactivation once written consent exists", async () => {
    const clinic = await seedClinic("tcpa-d");
    await grantConsent(clinic.clinicId, "express_written");

    const decision = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      canContact(tx.db, {
        policyOnly: true,
        clinicEnabled: true,
        clinicId: clinic.clinicId,
        phone: PHONE,
        channel: "voice",
        purpose: "reactivation",
        recipientTimezone: "America/New_York",
        now: NOON_NEW_YORK,
      }),
    );

    expect(decision.allowed).toBe(true);
  });

  test("suppression outranks consent", async () => {
    const clinic = await seedClinic("tcpa-e");
    await grantConsent(clinic.clinicId, "express_written");

    await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      suppress(tx.db, {
        clinicId: clinic.clinicId,
        phone: PHONE,
        reason: "stop_reply",
      }),
    );

    const decision = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      canContact(tx.db, {
        policyOnly: true,
        clinicEnabled: true,
        clinicId: clinic.clinicId,
        phone: PHONE,
        channel: "voice",
        purpose: "reminder",
        recipientTimezone: "America/New_York",
        now: NOON_NEW_YORK,
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe("suppressed");
  });

  test("a stop request on one channel suppresses every channel", async () => {
    // Someone who says "stop calling me" has not invited a text instead.
    const clinic = await seedClinic("tcpa-f");
    await grantConsent(clinic.clinicId, "express");
    await withTenant({ clinicId: clinic.clinicId, actor }, async (tx) => {
      await tx.db.insert(consentRecords).values({
        clinicId: clinic.clinicId,
        phone: PHONE,
        channel: "sms",
        consentType: "express",
        source: "web_form",
        exactWording: "Text me about my appointment.",
      });
      await suppress(tx.db, {
        clinicId: clinic.clinicId,
        phone: PHONE,
        reason: "verbal_request",
      });
    });

    for (const channel of ["voice", "sms"] as const) {
      const decision = await withTenant(
        { clinicId: clinic.clinicId, actor },
        (tx) =>
          canContact(tx.db, {
        policyOnly: true,
        clinicEnabled: true,
            clinicId: clinic.clinicId,
            phone: PHONE,
            channel,
            purpose: "reminder",
            recipientTimezone: "America/New_York",
            now: NOON_NEW_YORK,
          }),
      );
      expect(decision.allowed, channel).toBe(false);
    }
  });

  test("enforces the one-per-day cap", async () => {
    // A condition of the healthcare exemption, not guidance: exceed it and the
    // exemption does not apply at all.
    const clinic = await seedClinic("tcpa-g");
    await grantConsent(clinic.clinicId, "express");

    await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      recordAttempt(tx.db, {
        clinicId: clinic.clinicId,
        phone: PHONE,
        channel: "voice",
        purpose: "reminder",
      }),
    );

    const decision = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      canContact(tx.db, {
        policyOnly: true,
        clinicEnabled: true,
        clinicId: clinic.clinicId,
        phone: PHONE,
        channel: "voice",
        purpose: "reminder",
        recipientTimezone: "America/New_York",
        now: NOON_NEW_YORK,
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe("daily_cap");
  });

  test("exempts patient-initiated replies from the caps", async () => {
    // Replying to someone's own message is not an unsolicited call.
    const clinic = await seedClinic("tcpa-h");
    await grantConsent(clinic.clinicId, "express");

    await withTenant({ clinicId: clinic.clinicId, actor }, async (tx) => {
      for (let i = 0; i < 5; i += 1) {
        await recordAttempt(tx.db, {
          clinicId: clinic.clinicId,
          phone: PHONE,
          channel: "voice",
          purpose: "transactional",
        });
      }
    });

    const decision = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      canContact(tx.db, {
        policyOnly: true,
        clinicEnabled: true,
        clinicId: clinic.clinicId,
        phone: PHONE,
        channel: "voice",
        purpose: "transactional",
        recipientTimezone: "America/New_York",
        now: NOON_NEW_YORK,
      }),
    );

    expect(decision.allowed).toBe(true);
  });

  test("refuses outside quiet hours, in the recipient's local time", async () => {
    const clinic = await seedClinic("tcpa-i");
    await grantConsent(clinic.clinicId, "express");

    const decision = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      canContact(tx.db, {
        policyOnly: true,
        clinicEnabled: true,
        clinicId: clinic.clinicId,
        phone: PHONE,
        channel: "voice",
        purpose: "reminder",
        // 02:30Z on Tuesday 15 September is 22:30 Monday in New York —
        // refused — and 19:30 Monday in Los Angeles, inside the window
        // that now closes at 20:00 (a reminder has no dialling margin).
        recipientTimezone: "America/New_York",
        now: new Date("2026-09-15T02:30:00Z"),
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe("quiet_hours");

    const westCoast = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      canContact(tx.db, {
        policyOnly: true,
        clinicEnabled: true,
        clinicId: clinic.clinicId,
        phone: PHONE,
        channel: "voice",
        purpose: "reminder",
        recipientTimezone: "America/Los_Angeles",
        now: new Date("2026-09-15T02:30:00Z"),
      }),
    );
    expect(westCoast.allowed).toBe(true);
  });

  test("an unknown timezone is refused, not assumed — the check fails closed", async () => {
    const clinic = await seedClinic("tcpa-tz");
    await grantConsent(clinic.clinicId, "express");

    for (const timezone of [null, "Not/AZone"]) {
      const decision = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
        canContact(tx.db, {
        policyOnly: true,
        clinicEnabled: true,
          clinicId: clinic.clinicId,
          phone: PHONE,
          channel: "voice",
          purpose: "reminder",
          recipientTimezone: timezone,
          now: NOON_NEW_YORK,
        }),
      );
      expect(decision.allowed, String(timezone)).toBe(false);
      expect(decision.allowed === false && decision.code).toBe("quiet_hours");
      expect(decision.allowed === false && decision.reason).toMatch(/timezone is unknown/);
    }
  });

  test("the healthcare exemption's caller-side conditions are stated as constants", () => {
    expect(HEALTHCARE_EXEMPTION.maxVoiceReminderSeconds).toBe(60);
    expect(HEALTHCARE_EXEMPTION.maxSmsReminderChars).toBe(160);
    expect(HEALTHCARE_EXEMPTION.mustIdentifyProviderAtOutset).toBe(true);
  });

  test("one clinic's consent does not authorise another's call", async () => {
    const a = await seedClinic("tcpa-j");
    const b = await seedClinic("tcpa-k");
    await grantConsent(a.clinicId, "express_written");

    const decision = await withTenant({ clinicId: b.clinicId, actor }, (tx) =>
      canContact(tx.db, {
        policyOnly: true,
        clinicEnabled: true,
        clinicId: b.clinicId,
        phone: PHONE,
        channel: "voice",
        purpose: "reminder",
        recipientTimezone: "America/New_York",
        now: NOON_NEW_YORK,
      }),
    );

    expect(decision.allowed).toBe(false);
  });

  test("the runtime role cannot erase a suppression", async () => {
    // Re-consent is a new consent record, never the deletion of someone having
    // asked us to stop.
    const clinic = await seedClinic("tcpa-l");
    await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      suppress(tx.db, {
        clinicId: clinic.clinicId,
        phone: PHONE,
        reason: "complaint",
      }),
    );

    const { Pool } = await import("pg");
    const app = new Pool({ connectionString: process.env.TEST_APP_URL });
    try {
      await expect(app.query(`delete from suppressions`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        app.query(`update suppressions set reason = 'oops'`),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end();
    }
  });
});

/**
 * The two switches (design of 23 September 2026, §F.1 and §J). The
 * environment variable and the clinic's own flag are two keys, and neither
 * turns alone: both refusals happen before a single row is read, which is
 * why the database handle can be null here.
 */
describe("the outbound switches", () => {
  const base = {
    clinicId: "00000000-0000-0000-0000-000000000000",
    phone: "+14155550100",
    channel: "voice" as const,
    purpose: "callback" as const,
    recipientTimezone: "America/Los_Angeles",
  };

  afterEach(() => {
    delete process.env.HEALDESK_OUTBOUND_CALLBACKS_ENABLED;
  });

  test("env unset: outbound_disabled, before reading anything", async () => {
    delete process.env.HEALDESK_OUTBOUND_CALLBACKS_ENABLED;
    expect(outboundContactEnabled()).toBe(false);
    expect(await canContact(null as never, { ...base, clinicEnabled: true })).toMatchObject({ allowed: false, code: "outbound_disabled" });
    // Anything but the literal "true" is off.
    process.env.HEALDESK_OUTBOUND_CALLBACKS_ENABLED = "1";
    expect(outboundContactEnabled()).toBe(false);
  });

  test("env on, clinic off: outbound_disabled, before reading anything", async () => {
    process.env.HEALDESK_OUTBOUND_CALLBACKS_ENABLED = "true";
    expect(outboundContactEnabled()).toBe(true);
    expect(await canContact(null as never, { ...base, clinicEnabled: false })).toMatchObject({ allowed: false, code: "outbound_disabled" });
  });

  test("the window ends at 20:00 and a callback stops thirty minutes before it", () => {
    expect(QUIET_HOURS_START).toBe(20);
    expect(CALLBACK_DIAL_MARGIN_MINUTES).toBe(30);
  });
});

describeDb("the callback gate, both switches on (§J)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    process.env.HEALDESK_OUTBOUND_CALLBACKS_ENABLED = "true";
  }, 60_000);

  afterAll(async () => {
    delete process.env.HEALDESK_OUTBOUND_CALLBACKS_ENABLED;
    await closePools();
  });

  const gate = (clinicId: string, over: Partial<Parameters<typeof canContact>[1]> = {}) =>
    withTenant({ clinicId, actor }, (tx) =>
      canContact(tx.db, {
        clinicId,
        phone: PHONE,
        channel: "voice",
        purpose: "callback",
        recipientTimezone: "America/New_York",
        clinicEnabled: true,
        now: NOON_NEW_YORK,
        ...over,
      }),
    );

  async function consent(clinicId: string) {
    await withTenant({ clinicId, actor }, (tx) =>
      tx.db.insert(consentRecords).values({
        clinicId,
        phone: PHONE,
        channel: "voice",
        consentType: "express",
        source: "inbound_call",
        exactWording: "Is it alright if the practice's automated assistant calls you back on this number about this booking request? — answered: \"yes\"",
        wordingVersion: "callback-v2",
      }),
    );
  }

  test("both on, no consent → no_consent; with consent → allowed, and a callback is exempt from the reminder caps", async () => {
    const clinic = await seedClinic("cb-consent");
    expect(await gate(clinic.clinicId)).toMatchObject({ allowed: false, code: "no_consent" });
    await consent(clinic.clinicId);
    expect((await gate(clinic.clinicId)).allowed).toBe(true);
    await withTenant({ clinicId: clinic.clinicId, actor }, async (tx) => {
      for (let i = 0; i < 3; i += 1) await recordAttempt(tx.db, { clinicId: clinic.clinicId, phone: PHONE, channel: "voice", purpose: "callback" });
    });
    // The dialer's own two-per-request and four-per-number caps apply on top (§F.5).
    expect((await gate(clinic.clinicId)).allowed).toBe(true);
  });

  test("19:45 recipient-local → quiet_hours for a callback; 19:29 is inside; a reminder still has until 20:00", async () => {
    const clinic = await seedClinic("cb-1945");
    await consent(clinic.clinicId);
    // 2026-09-14 is a Monday. 23:45Z is 19:45 in New York (EDT).
    expect(await gate(clinic.clinicId, { now: new Date("2026-09-14T23:45:00Z") })).toMatchObject({ allowed: false, code: "quiet_hours" });
    expect(await gate(clinic.clinicId, { now: new Date("2026-09-14T23:30:00Z") })).toMatchObject({ allowed: false, code: "quiet_hours" });
    expect((await gate(clinic.clinicId, { now: new Date("2026-09-14T23:29:00Z") })).allowed).toBe(true);
    expect((await gate(clinic.clinicId, { now: new Date("2026-09-14T23:45:00Z"), purpose: "reminder" })).allowed).toBe(true);
    expect(await gate(clinic.clinicId, { now: new Date("2026-09-15T00:00:00Z"), purpose: "reminder" })).toMatchObject({ allowed: false, code: "quiet_hours" });
    // Before eight in the morning, whatever the purpose.
    expect(await gate(clinic.clinicId, { now: new Date("2026-09-14T11:59:00Z") })).toMatchObject({ allowed: false, code: "quiet_hours" });
    expect((await gate(clinic.clinicId, { now: new Date("2026-09-14T12:00:00Z") })).allowed).toBe(true);
  });

  test("Sunday 11:00 → quiet_hours, in the recipient's clock", async () => {
    const clinic = await seedClinic("cb-sunday");
    await consent(clinic.clinicId);
    // 2026-09-13 is a Sunday. 15:00Z is 11:00 in New York.
    const sunday = await gate(clinic.clinicId, { now: new Date("2026-09-13T15:00:00Z") });
    expect(sunday).toMatchObject({ allowed: false, code: "quiet_hours" });
    expect(sunday.allowed === false && sunday.reason).toMatch(/Sunday/);
    // The same instant is still Saturday evening in Honolulu — and inside the window there.
    expect((await gate(clinic.clinicId, { now: new Date("2026-09-13T05:00:00Z"), recipientTimezone: "Pacific/Honolulu" })).allowed).toBe(true);
  });

  test("an unknown timezone is refused", async () => {
    const clinic = await seedClinic("cb-tz");
    await consent(clinic.clinicId);
    for (const timezone of [null, "Mars/Olympus"]) {
      expect(await gate(clinic.clinicId, { recipientTimezone: timezone }), String(timezone)).toMatchObject({ allowed: false, code: "quiet_hours" });
    }
  });

  test("suppression outranks consent", async () => {
    const clinic = await seedClinic("cb-suppressed");
    await consent(clinic.clinicId);
    expect((await gate(clinic.clinicId)).allowed).toBe(true);
    await withTenant({ clinicId: clinic.clinicId, actor }, (tx) => suppress(tx.db, { clinicId: clinic.clinicId, phone: PHONE, reason: "stop_request" }));
    expect(await gate(clinic.clinicId)).toMatchObject({ allowed: false, code: "suppressed" });
  });
});

describe("the two stop matchers", () => {
  test("the inbound-message matcher never treats a cancellation as a stop; the reply matcher still does", () => {
    expect(isCallbackStopRequest("I need to cancel my appointment")).toBe(false);
    expect(isCallbackStopRequest("please stop calling me")).toBe(true);
    expect(isStopRequest("I need to cancel my appointment")).toBe(true);
  });
});
