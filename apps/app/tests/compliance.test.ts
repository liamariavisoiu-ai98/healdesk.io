import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  HEALTHCARE_EXEMPTION,
  OUTBOUND_CONTACT_ENABLED,
  canContact,
  isStopRequest,
  recordAttempt,
  suppress,
} from "@/lib/compliance/contact-policy";
import {
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
    // Live transfer is off by default and v1 has no live staff inbox, so the
    // opener may promise a handover to staff within a day, never a person
    // on the line now (decision of 1 October 2026).
    expect(text).toMatch(/get back to you within a day/i);
    expect(text).not.toMatch(/reach a person/i);
    expect(disclosureFor({ clinicName: "Radiance", channel: "web_chat" })).toMatch(
      /get back to you within a day/i,
    );
  });

  test("Meta channels get a warning, not a welcome — and it promises phone, never text", () => {
    const text = disclosureFor({
      clinicName: "Radiance",
      channel: "instagram_dm",
    });
    expect(text).toMatch(/isn't secure/i);
    expect(text).toMatch(/don't share medical details/i);
    // v1 has no SMS anywhere, so the greeting may not offer a text.
    expect(metaChannelGreeting({ clinicName: "Radiance", channel: "whatsapp" })).toMatch(/continue by phone\.$/);
    expect(metaChannelGreeting({ clinicName: "Radiance", channel: "whatsapp" })).not.toMatch(/\btext\b/i);
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
        clinicId: clinic.clinicId,
        phone: PHONE,
        channel: "voice",
        purpose: "reminder",
        // 05:00Z is 01:00 in New York and 22:00 in Los Angeles: the same
        // instant is refused on one coast and refused on the other too, for
        // different reasons; 03:00Z is 23:00 New York, 20:00 Los Angeles.
        recipientTimezone: "America/New_York",
        now: new Date("2026-09-14T03:00:00Z"),
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe("quiet_hours");

    const westCoast = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      canContact(tx.db, {
        policyOnly: true,
        clinicId: clinic.clinicId,
        phone: PHONE,
        channel: "voice",
        purpose: "reminder",
        recipientTimezone: "America/Los_Angeles",
        now: new Date("2026-09-14T03:00:00Z"),
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

describe("inbound-only", () => {
  test("the product-wide switch is off, and the gate refuses before reading anything", async () => {
    expect(OUTBOUND_CONTACT_ENABLED).toBe(false);
    const decision = await canContact(null as never, {
      clinicId: "00000000-0000-0000-0000-000000000000",
      phone: "+14155550100",
      channel: "sms",
      purpose: "transactional",
      recipientTimezone: "America/Los_Angeles",
    });
    expect(decision).toMatchObject({ allowed: false, code: "outbound_disabled" });
  });
});
