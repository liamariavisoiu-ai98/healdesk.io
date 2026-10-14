import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  MAX_TRANSCRIPT_CHARACTERS,
  renderTranscriptEmail,
  sendTranscriptEmail,
  TRANSCRIPT_SUBJECT,
  TranscriptEmailError,
  type TranscriptEmailInput,
} from "@/lib/conversations/transcript-email";
import type { DeliveryResult, DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";

/**
 * The emailed transcript (the owner's decision of 13 October 2026): the words
 * of a conversation go to the clinic once, through SES, and healdesk keeps
 * none of them. These tests hold the parts that make that safe: the class it
 * declares, the route it can and cannot take, a subject about nobody, escaped
 * HTML, and failure reported by ids alone. No database, no network.
 */

const INPUT: TranscriptEmailInput = {
  conversationId: "6b0f8a52-3f7e-4d2a-9a51-2a0c1f0e9d11",
  clinic: { id: "c0ffee00-0000-4000-8000-000000000001", name: "Radiance Med Spa", timeZone: "America/New_York" },
  channel: "voice",
  startedAt: new Date("2026-10-13T20:05:00Z"),
  turns: [
    { speaker: "assistant", text: "Hi, I'm Radiance's AI assistant, and this call is transcribed. How can I help?" },
    { speaker: "person", text: "Hi, it's Dana Okonkwo, 415 555 0192. I'd like a Botox consult on Thursday." },
    { speaker: "assistant", text: "Thursday at 3 PM is open. Shall I book it?" },
  ],
};

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  constructor(private readonly answer: (to: string) => DeliveryResult = () => ({ status: "sent", messageId: "m-1" })) {}
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    this.sent.push({ target, message });
    return this.answer(target.to);
  }
}

const KEYS = ["HEALDESK_EMAIL_TRANSPORT", "HEALDESK_SES_CONFIGURATION_SET", "RESEND_API_KEY"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const key of KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("renderTranscriptEmail", () => {
  test("the subject is fixed and about nobody", () => {
    const email = renderTranscriptEmail(INPUT);
    expect(email.subject).toBe(TRANSCRIPT_SUBJECT);
    expect(email.subject).not.toMatch(/Dana|Okonkwo|Botox|Thursday|415/);
  });

  test("every turn is there, labelled, with the time in the clinic's zone and the reference", () => {
    const email = renderTranscriptEmail(INPUT);
    expect(email.text).toContain("Assistant: Hi, I'm Radiance's AI assistant");
    expect(email.text).toContain("Caller: Hi, it's Dana Okonkwo");
    expect(email.text).toContain("Tuesday, October 13, 2026 at 4:05 PM EDT");
    expect(email.text).toContain(`Reference: ${INPUT.conversationId}`);
    // The owner's decision of 14 October 2026: the copy goes once delivery is confirmed.
    expect(email.text).toMatch(
      /deletes its own encrypted copy as soon as your mail server confirms it has received this email/,
    );
    expect(email.text).not.toMatch(/seven days/);
    expect(email.text).toMatch(/Please don't reply/);
  });

  test("a web chat's person is a visitor", () => {
    const email = renderTranscriptEmail({ ...INPUT, channel: "web_chat" });
    expect(email.text).toContain("Visitor: Hi, it's Dana");
    expect(email.text).toContain("transcript of a web chat");
  });

  test("what a person said is escaped in the HTML, so it cannot become markup or a link we made", () => {
    const email = renderTranscriptEmail({
      ...INPUT,
      turns: [{ speaker: "person", text: '<script>alert(1)</script> <a href="https://evil.test">click</a>' }],
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain('<a href="https://evil.test">');
    expect(email.html).toContain("&lt;script&gt;");
  });

  test("control characters go, line breaks stay", () => {
    const email = renderTranscriptEmail({
      ...INPUT,
      turns: [{ speaker: "person", text: "line one\r\nline two\u0007" }],
    });
    expect(email.text).toContain("Caller: line one\nline two");
    expect(email.text).not.toContain("\u0007");
    expect(email.html).toContain("line one<br>line two");
  });

  test("a transcript longer than the email can carry is cut, and says so", () => {
    const long = "a".repeat(MAX_TRANSCRIPT_CHARACTERS);
    const email = renderTranscriptEmail({
      ...INPUT,
      turns: [
        { speaker: "person", text: long },
        { speaker: "assistant", text: "never reached" },
      ],
    });
    expect(email.text).toContain("is cut here");
    expect(email.text).not.toContain("never reached");
    expect(renderTranscriptEmail(INPUT).text).not.toContain("is cut here");
  });

  test("Meta channels are refused: healdesk keeps no Meta message", () => {
    expect(() => renderTranscriptEmail({ ...INPUT, channel: "instagram_dm" as never })).toThrow(TranscriptEmailError);
    expect(() => renderTranscriptEmail({ ...INPUT, channel: "whatsapp" as never })).toThrow(/Meta/);
  });

  test("an empty transcript is refused", () => {
    expect(() => renderTranscriptEmail({ ...INPUT, turns: [{ speaker: "person", text: "  \u0007 " }] })).toThrow(/empty/);
  });
});

describe("sendTranscriptEmail", () => {
  const TARGET = { to: "owner@radiance.test", clinicId: INPUT.clinic.id, clinicName: "Radiance Med Spa" };

  test("it declares the PHI class, so getTransport can only ever pick SES for it", async () => {
    const transport = new FakeTransport();
    const result = await sendTranscriptEmail(renderTranscriptEmail(INPUT), TARGET, { transport });
    expect(result.status).toBe("sent");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.message.phiClass).toBe("may-carry-phi");
    // The clinic's address and nothing else: no copy rides along (the owner's
    // decision of 14 October 2026 removed the archive copy).
    expect(transport.sent[0]!.target).toEqual(TARGET);
  });

  test("a transport that throws is a failed result, not an exception", async () => {
    const transport: EmailTransport = {
      name: "throws",
      send: async () => {
        throw new Error("SES timed out");
      },
    };
    const result = await sendTranscriptEmail(renderTranscriptEmail(INPUT), TARGET, { transport });
    expect(result).toMatchObject({ status: "failed", reason: "SES timed out" });
  });

  test("with Resend configured and no SES, nothing is sent anywhere", async () => {
    process.env.HEALDESK_EMAIL_TRANSPORT = "resend";
    process.env.RESEND_API_KEY = "re_test";
    const result = await sendTranscriptEmail(renderTranscriptEmail(INPUT), TARGET);
    expect(result).toMatchObject({ status: "failed", reason: expect.stringMatching(/no SES configuration set/) });
  });
});
