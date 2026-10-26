import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { renderSupportReceived, SUPPORT_RECEIVED_ENTRY } from "@/lib/email/templates/support_received";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { stringToSign, type SnsMessage } from "@/lib/email/ses-events";
import { classifyEmail, ownLines } from "@/lib/support/inbound/classify";
import { isInboundKey } from "@/lib/support/inbound/config";
import { attachmentSummary, cappedCount, matchingAddress, messageFields, screenCounts, senderRef } from "@/lib/support/inbound/facts";
import { bareAddress, dropReason, isProviderConfirmation } from "@/lib/support/inbound/guards";
import { idForms, refsInSubject } from "@/lib/support/inbound/match";
import { inboundNoticeFrom } from "@/lib/support/inbound/notice";
import { MailParseError, parseMail, textOfHtml } from "@/lib/support/inbound/parse";
import { headersFrom } from "@/lib/support/inbound/threading";
import { inboundMailWebhook } from "@/lib/support/inbound/webhook";

/**
 * Inbound support mail, the parts that need no database (ops automation lane
 * P7g): reading a message in memory, the loop guards, the keyword triage,
 * the facts it becomes, SES's notice, the reply's threading headers, the
 * acknowledgement's template, and the webhook's door (404 while off, SNS's
 * signature checked with the SES events' own verifier, another topic
 * refused, a subscription confirmed only for the trusted topic).
 *
 * The .eml fixtures are synthetic; {{FROM}} and the like are filled in here.
 */

const FIXTURES = join(__dirname, "fixtures", "inbound");
export function eml(name: string, fill: Record<string, string> = {}): Uint8Array {
  let text = readFileSync(join(FIXTURES, name), "utf8");
  const values = { FROM: "owner@example-clinic.test", FROM_PLUS: "owner+support@example-clinic.test", REF: "7F3KQ", THREAD: "<t-1@mail.example-clinic.test>", ...fill };
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{{${key}}}`, value);
  return new TextEncoder().encode(text);
}

const PASS = { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" } as const;

describe("reading a message in memory", () => {
  test("a clinic's plain email: the sender, the subject, the ids and the body, and no attachment", async () => {
    const mail = await parseMail(eml("clinic-normal.eml"));
    expect(mail.from).toBe("owner@example-clinic.test");
    expect(mail.subject).toBe("Calls ring out since this morning");
    expect(mail.messageId).toBe("<normal-1@mail.example-clinic.test>");
    expect(mail.inReplyTo).toBeNull();
    expect(mail.body).toContain("ring out");
    expect(mail.attachments).toEqual([]);
  });

  test("attachments are counted by class and size, never by name, and never opened", async () => {
    const mail = await parseMail(eml("phi.eml"));
    expect(mail.attachments.map((a) => a.kind).sort()).toEqual(["image", "pdf"]);
    expect(JSON.stringify(mail.attachments)).not.toMatch(/ZEBRA/i);
    const summary = attachmentSummary(mail.attachments);
    expect(summary).toEqual({ count: 2, image: 1, pdf: 1, other: 0, size: "under_1mb" });
    expect(JSON.stringify(summary)).toMatch(/^[a-z0-9_{}":, ]*$/);
  });

  test("In-Reply-To and References are kept as opaque ids", async () => {
    const mail = await parseMail(eml("in-reply-to.eml"));
    expect(mail.inReplyTo).toBe("<t-1@mail.example-clinic.test>");
    expect(mail.references).toEqual(["<older@mail.example-clinic.test>", "<t-1@mail.example-clinic.test>"]);
  });

  test("an HTML-only body is read as words", () => {
    expect(textOfHtml("<p>Calls <b>ring</b> out</p><script>x()</script>")).toMatch(/Calls\s+ring\s+out/);
    expect(textOfHtml("<style>p{}</style>hi")).not.toContain("p{}");
  });

  test("a message over the header limit cannot be parsed: MailParseError", async () => {
    const huge = `From: a@b.test\r\nX-Pad: ${"x".repeat(600 * 1024)}\r\nSubject: s\r\n\r\nbody`;
    await expect(parseMail(new TextEncoder().encode(huge))).rejects.toBeInstanceOf(MailParseError);
  });
});

describe("the loop guards", () => {
  test.each([
    ["auto-submitted.eml", "auto_submitted"],
    ["precedence-bulk.eml", "precedence"],
    ["x-autoreply.eml", "autoreply"],
    ["x-auto-response-suppress.eml", "autoreply"],
    ["list.eml", "list"],
    ["dsn.eml", "report"],
    ["own-address.eml", "own_address"],
  ])("%s is dropped as %s", async (file, reason) => {
    expect(dropReason(await parseMail(eml(file)), { verdicts: PASS })).toBe(reason);
  });

  test("a clinic's email, a prospect's and a security worry pass", async () => {
    for (const file of ["clinic-normal.eml", "prospect.eml", "security.eml", "phi.eml", "plus-addressed.eml"]) {
      expect(dropReason(await parseMail(eml(file)), { verdicts: PASS }), file).toBeNull();
    }
  });

  test("SES's spam or virus verdict drops it; a DKIM failure does not (it only stops the acknowledgement)", async () => {
    const mail = await parseMail(eml("clinic-normal.eml"));
    expect(dropReason(mail, { verdicts: { ...PASS, spam: "FAIL" } })).toBe("spam");
    expect(dropReason(mail, { verdicts: { ...PASS, virus: "FAIL" } })).toBe("virus");
    expect(dropReason(mail, { verdicts: { ...PASS, dkim: "FAIL" } })).toBeNull();
  });

  test("our own sending address, from HEALDESK_EMAIL_FROM, is ours", async () => {
    vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <notices@healdesk.io>");
    try {
      const mail = await parseMail(eml("clinic-normal.eml", { FROM: "notices@healdesk.io" }));
      expect(dropReason(mail, { verdicts: PASS })).toBe("own_address");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("Gmail's forwarding confirmation is recognised, and only it", async () => {
    expect(isProviderConfirmation(await parseMail(eml("gmail-confirmation.eml")))).toBe(true);
    expect(isProviderConfirmation(await parseMail(eml("clinic-normal.eml")))).toBe(false);
  });

  test("bareAddress reads the address out of a From-style value", () => {
    expect(bareAddress("healdesk <Hello@Healdesk.io>")).toBe("hello@healdesk.io");
    expect(bareAddress("a@b.test")).toBe("a@b.test");
    expect(bareAddress("no address")).toBeNull();
  });
});

describe("the keyword triage", () => {
  test.each([
    ["Calls ring out since this morning", "", "forwarding", "calls_ring_out", "now"],
    ["Question about our invoice", "we have a question about the invoice", "billing", "invoice_question", "today"],
    ["I think our account was hacked", "Someone else signed in to our portal", "sign_in", "other", "now"],
    ["Instagram won't connect", "", "channel", "meta_wont_connect", "today"],
    ["Google calendar disconnected", "", "calendar", "disconnected", "today"],
    ["We want to upgrade", "more minutes please", "plan", "move_up_a_step", "this_week"],
    ["A transcript never arrived", "", "transcript", "not_received", "today"],
    ["Hello", "Just saying hi", "other", "other", "this_week"],
    ["We were charged twice", "", "billing", "invoice_question", "now"],
  ])("%s / %s: %s %s %s", (subject, body, topic, symptom, urgency) => {
    const c = classifyEmail(subject, body);
    expect([c.topic, c.symptom, c.urgency]).toEqual([topic, symptom, urgency]);
  });

  test("the same mail always reads the same way, and a quoted earlier email does not count", () => {
    const body = "Thanks, sorted.\n\nOn Mon, 26 Oct 2026, healdesk wrote:\n> invoice billing refund charge";
    expect(ownLines(body)).not.toContain("invoice");
    expect(classifyEmail("Re: thanks", body)).toEqual(classifyEmail("Re: thanks", body));
    expect(classifyEmail("Re: thanks", body).topic).toBe("other");
  });
});

describe("the facts an email becomes", () => {
  test("the screen counts what looked like a patient's details, and keeps none of it", async () => {
    const mail = await parseMail(eml("phi.eml"));
    const counts = screenCounts(mail.subject, mail.body, { numbers: [], emails: ["owner@example-clinic.test"] });
    expect(counts.numbers).toBeGreaterThanOrEqual(2);
    expect(counts.emails).toBe(1);
    expect(counts.treatments).toBeGreaterThanOrEqual(2);
    expect(counts.clinical).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(counts)).not.toMatch(/ZEBRA|415|Elm|Botox/i);
  });

  test("the clinic's own number is not a stranger's", () => {
    const counts = screenCounts("Call us", "Our line is 415-555-0100", { numbers: ["+14155550100"], emails: [] });
    expect(counts.numbers).toBe(0);
  });

  test("the message's fields are fixed words and capped counts: no '@', never three digits in a row", () => {
    const fields = messageFields({
      classification: { topic: "forwarding", symptom: "calls_ring_out", urgency: "now", security: false },
      matchedBy: "address",
      counts: { numbers: 250, emails: 3, treatments: 0, clinical: 1 },
      verdicts: { ...PASS, dkim: "PROCESSING_FAILED" },
      oversize: false,
      acknowledged: "queued",
      senderMatchesCase: null,
    });
    const text = JSON.stringify(fields);
    expect(text).not.toContain("@");
    expect(text).not.toMatch(/[0-9]{3,}/);
    expect(fields.hiddenNumbers).toBe("99+");
    expect(cappedCount(7)).toBe("7");
  });

  test("the sender's reference is an HMAC of the address, a plus-tag and case aside, and says nothing of it", () => {
    expect(matchingAddress("Owner+Support@Example-Clinic.test")).toBe("owner@example-clinic.test");
    const a = senderRef("owner+support@example-clinic.test");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(senderRef("OWNER@example-clinic.test"));
    expect(a).not.toBe(senderRef("other@example-clinic.test"));
  });
});

describe("matching helpers", () => {
  test("refs in a subject, printed or bare, normalised", () => {
    expect(refsInSubject("Re: We've got your email (ref HD-7F3KQ)")).toEqual(["7F3KQ"]);
    expect(refsInSubject("about hd-7f3kq and HD-ABCDE")).toEqual(["7F3KQ", "ABCDE"]);
    expect(refsInSubject("no ref here")).toEqual([]);
  });

  test("an id is matched as written, without brackets, and by Resend's id before the @", () => {
    const forms = idForms(["<0b6a1f8e-1111-4222-8333-944455556666@email.amazonses.com>"]);
    expect(forms).toContain("0b6a1f8e-1111-4222-8333-944455556666");
    expect(forms).toContain("<0b6a1f8e-1111-4222-8333-944455556666@email.amazonses.com>");
  });

  test("only keys SES wrote under mail/ are read", () => {
    expect(isInboundKey("mail/0100018f3ab1c2d3-abc")).toBe(true);
    expect(isInboundKey("mail/../exports/x")).toBe(false);
    expect(isInboundKey("other/abc")).toBe(false);
  });
});

describe("SES's notice", () => {
  const notice = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      notificationType: "Received",
      mail: { messageId: "o3k1ses0001", timestamp: "2026-10-26T14:00:00.000Z", commonHeaders: { subject: "ZEBRASENTINEL", from: ["x@y.test"] } },
      receipt: {
        timestamp: "2026-10-26T14:00:01.000Z",
        action: { type: "S3", bucketName: "inbound-bucket", objectKey: "mail/o3k1ses0001", topicArn: "arn" },
        spamVerdict: { status: "PASS" },
        virusVerdict: { status: "PASS" },
        spfVerdict: { status: "FAIL" },
        dkimVerdict: { status: "PASS" },
        dmarcVerdict: { status: "GRAY" },
      },
      ...over,
    });

  test("reads SES's id, where the message is and the verdicts, and nothing of the message", () => {
    const n = inboundNoticeFrom(notice(), new Date("2026-10-26T15:00:00Z"));
    expect(n).toEqual({
      sesMessageId: "o3k1ses0001",
      bucket: "inbound-bucket",
      key: "mail/o3k1ses0001",
      receivedAt: new Date("2026-10-26T14:00:01.000Z"),
      verdicts: { spam: "PASS", virus: "PASS", spf: "FAIL", dkim: "PASS", dmarc: "GRAY" },
    });
    expect(JSON.stringify(n)).not.toContain("ZEBRA");
  });

  test("anything but an S3 receipt is not a notice", () => {
    const now = new Date();
    expect(inboundNoticeFrom(notice({ notificationType: "AmazonSnsSubscriptionSucceeded" }), now)).toBeNull();
    expect(inboundNoticeFrom("not json", now)).toBeNull();
  });
});

describe("the reply's threading", () => {
  test("In-Reply-To names the clinic's email, References carries what it replied to", () => {
    expect(headersFrom("<b@x.test>", "<a@x.test>")).toEqual({ "In-Reply-To": "<b@x.test>", References: "<a@x.test> <b@x.test>" });
    expect(headersFrom("<b@x.test>", null)).toEqual({ "In-Reply-To": "<b@x.test>", References: "<b@x.test>" });
  });

  test("nothing that is not one bracketed id, so no line break can ride in a header", () => {
    expect(headersFrom(null, null)).toBeNull();
    expect(headersFrom("<b@x.test>\r\nBcc: someone@x.test", null)).toBeNull();
    expect(headersFrom("b@x.test", null)).toBeNull();
  });
});

describe("the acknowledgement, L38", () => {
  const ctx = { clinicName: "Glow Clinic", audience: "patients" as const, reason: "You get this email because your practice wrote to healdesk support.", raisedAt: new Date("2026-10-26T14:00:00Z"), timeZone: "America/New_York" };

  test("fixed words, the case's ref in the subject and the body, the reply-by day; nothing of the email", () => {
    const r = renderSupportReceived({ ...SUPPORT_RECEIVED_ENTRY.fixture, hasPatientDetails: false }, ctx);
    expect(r.subject).toBe("We've got your email (ref HD-7F3KQ)");
    expect(r.text).toContain("HD-7F3KQ");
    expect(r.text).toContain("keep the reference in the subject");
    expect(r.text).not.toMatch(/looked like it might include|Conversations and Bookings/);
  });

  test("when the screen found what looked like patient details: one fixed sentence pointing to the portal", () => {
    const r = renderSupportReceived(SUPPORT_RECEIVED_ENTRY.fixture, ctx);
    expect(r.text).toContain("patient details");
    expect(r.text).toContain("Conversations and Bookings");
    const clients = renderSupportReceived(SUPPORT_RECEIVED_ENTRY.fixture, { ...ctx, audience: "clients" });
    expect(clients.text).toContain("client details");
  });

  test("its payload passes the allow-list: ids, a ref, a date and a flag", () => {
    expect(() => assertPayloadAllowed(SUPPORT_RECEIVED_ENTRY.fixture, "support_received")).not.toThrow();
    expect(() => assertPayloadAllowed({ ...SUPPORT_RECEIVED_ENTRY.fixture, subject: "words" }, "support_received")).toThrow();
  });
});

describe("the webhook's door", () => {
  const TOPIC = "arn:aws:sns:us-east-1:865780386982:healdesk-production-inbound-mail";
  const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0000000000.pem";
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const getKey = async () => publicKey;
  function signed(fields: Omit<SnsMessage, "Signature" | "SignatureVersion" | "SigningCertURL"> & Partial<SnsMessage>): SnsMessage {
    const m: SnsMessage = { SignatureVersion: "2", SigningCertURL: CERT_URL, Signature: "", ...fields };
    m.Signature = sign("RSA-SHA256", Buffer.from(stringToSign(m)), privateKey).toString("base64");
    return m;
  }
  const post = (body: unknown, deps = {}) =>
    inboundMailWebhook(new Request("https://app.healdesk.test/api/webhooks/inbound-mail", { method: "POST", body: JSON.stringify(body) }), { getKey, ...deps });
  const notification = (over: Partial<SnsMessage> = {}) =>
    signed({ Type: "Notification", MessageId: "sns-1", TopicArn: TOPIC, Message: JSON.stringify({ notificationType: "Other" }), Timestamp: "2026-10-26T14:00:00.000Z", ...over });

  afterEach(() => vi.unstubAllEnvs());

  test("404 while HEALDESK_INBOUND_MAIL_TOPIC_ARN is unset: the feature is off", async () => {
    vi.stubEnv("HEALDESK_INBOUND_MAIL_TOPIC_ARN", "");
    expect((await post(notification())).status).toBe(404);
  });

  test("a signed notice for the trusted topic is taken (200); one that is not a receipt changes nothing", async () => {
    vi.stubEnv("HEALDESK_INBOUND_MAIL_TOPIC_ARN", TOPIC);
    expect((await post(notification())).status).toBe(200);
  });

  test("a signature that does not verify is refused (403)", async () => {
    vi.stubEnv("HEALDESK_INBOUND_MAIL_TOPIC_ARN", TOPIC);
    const forged = { ...notification(), Message: JSON.stringify({ notificationType: "Received" }) };
    expect((await post(forged)).status).toBe(403);
  });

  test("another topic is refused (403), even signed", async () => {
    vi.stubEnv("HEALDESK_INBOUND_MAIL_TOPIC_ARN", TOPIC);
    expect((await post(notification({ TopicArn: "arn:aws:sns:us-east-1:865780386982:healdesk-production-ses-events" }))).status).toBe(403);
  });

  test("not an SNS message (400)", async () => {
    vi.stubEnv("HEALDESK_INBOUND_MAIL_TOPIC_ARN", TOPIC);
    expect((await post({ hello: "world" })).status).toBe(400);
  });

  test("a subscription is confirmed for the trusted topic, at SNS's own host only", async () => {
    vi.stubEnv("HEALDESK_INBOUND_MAIL_TOPIC_ARN", TOPIC);
    const visited: string[] = [];
    const confirm = async (url: string) => {
      visited.push(url);
      return { ok: true, status: 200 };
    };
    const ok = signed({ Type: "SubscriptionConfirmation", MessageId: "sns-2", TopicArn: TOPIC, Message: "confirm", Timestamp: "2026-10-26T14:00:00.000Z", Token: "t", SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t" });
    expect((await post(ok, { confirm })).status).toBe(200);
    const elsewhere = signed({ Type: "SubscriptionConfirmation", MessageId: "sns-3", TopicArn: TOPIC, Message: "confirm", Timestamp: "2026-10-26T14:00:00.000Z", Token: "t", SubscribeURL: "https://evil.example.test/confirm" });
    expect((await post(elsewhere, { confirm })).status).toBe(502);
    expect(visited).toEqual(["https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t"]);
  });
});
