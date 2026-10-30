import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { printRef, readRef, SUPPORT_REF_ALPHABET } from "@/lib/support/case-vocab";
import { renderSupportReceived,SUPPORT_RECEIVED_ENTRY } from "@/lib/email/templates/support_received";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { stringToSign, type SnsMessage } from "@/lib/email/ses-events";
import { classifyEmail, ownLines } from "@/lib/support/inbound/classify";
import { isInboundKey } from "@/lib/support/inbound/config";
import { attachmentSummary, cappedCount, matchingAddress, messageFields, screenCounts, senderRef } from "@/lib/support/inbound/facts";
import { alignedDkimPass, authenticate, isAuthenticated, noticeVerdictsPass, sesAuthenticationResults } from "@/lib/support/inbound/auth";
import { bareAddress, dropReason, isProviderConfirmation } from "@/lib/support/inbound/guards";
import { idForms, refsInSubject } from "@/lib/support/inbound/match";
import { inboundNoticeFrom } from "@/lib/support/inbound/notice";
import { MAX_INBOUND_BYTES } from "@/lib/support/inbound/config";
import { MAX_WORDS_CHARS, MailParseError, messageIds, parseMail, textOfHtml } from "@/lib/support/inbound/parse";
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
  const values = { FROM: "owner@example-clinic.test", DOMAIN: "example-clinic.test", FROM_PLUS: "owner+support@example-clinic.test", REF: "7F3KQ", THREAD: "<t-1@mail.example-clinic.test>", ...fill };
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{{${key}}}`, value);
  return new TextEncoder().encode(text);
}

const PASS = { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" } as const;
const UNKNOWN = { spam: "UNKNOWN", virus: "UNKNOWN", spf: "UNKNOWN", dkim: "UNKNOWN", dmarc: "UNKNOWN" } as const;

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

  test("only message ids of one strict shape are kept: never a link, a quote, a space or an over-long id", () => {
    expect(messageIds("<CAB+x=y_z@mail.gmail.com> <0100018f-ab@email.amazonses.com>")).toEqual([
      "<CAB+x=y_z@mail.gmail.com>",
      "<0100018f-ab@email.amazonses.com>",
    ]);
    expect(messageIds("<https://x.example/y>")).toEqual([]);
    expect(messageIds("<a:b@x.test> <a/b@x.test> <a\"b@x.test> <no-at-sign>")).toEqual([]);
    expect(messageIds(`<${"a".repeat(200)}@${"b".repeat(60)}.test>`)).toEqual([]);
  });

  test("an HTML-only body is read as words", () => {
    expect(textOfHtml("<p>Calls <b>ring</b> out</p><script>x()</script>")).toMatch(/Calls\s+ring\s+out/);
    expect(textOfHtml("<style>p{}</style>hi")).not.toContain("p{}");
  });

  test("the HTML stripper is linear: an unclosed script, a run of '<' and nested tags", () => {
    expect(textOfHtml("a<script>never closed")).toBe("a");
    expect(textOfHtml("a<b")).toBe("a");
    expect(textOfHtml("x<SCRIPT type=x>y</Script >z<br/>w</P>v &amp; &lt;b&gt;")).toBe("x z\nw\nv & <b>");
    const started = performance.now();
    textOfHtml("<script>".repeat(128 * 1024));
    textOfHtml("<".repeat(1024 * 1024));
    textOfHtml("<style>".repeat(64 * 1024) + "</style>".repeat(64 * 1024));
    // Linear: a few milliseconds each on a quiet machine; the bound only catches the old square.
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test("1 MB of '<script>' and 1 MB of plain text are read, screened and classified within a fixed bound, from at most 64 K characters", async () => {
    const head = "From: a@b.test\r\nTo: hello@healdesk.io\r\nSubject: Calls ring out\r\nMessage-ID: <x@b.test>\r\nMIME-Version: 1.0\r\n";
    const inputs = [
      `${head}Content-Type: text/html\r\n\r\n${"<script>".repeat(128 * 1024)}`,
      `${head}Content-Type: text/plain\r\n\r\n${"call 555 123 4567 about botox ".repeat(35_000)}`,
    ];
    for (const raw of inputs) {
      const bytes = new TextEncoder().encode(raw);
      expect(bytes.byteLength).toBeGreaterThan(1024 * 1024);
      expect(bytes.byteLength).toBeLessThan(MAX_INBOUND_BYTES);
      const started = performance.now();
      const mail = await parseMail(bytes);
      expect(mail.subject.length + mail.body.length).toBeLessThanOrEqual(MAX_WORDS_CHARS);
      screenCounts(mail.subject, mail.body, { numbers: [], emails: [] });
      classifyEmail(mail.subject, mail.body);
      // Under a quarter of a second unloaded; generous for a loaded machine, far below the old 19 s.
      expect(performance.now() - started).toBeLessThan(10_000);
    }
  }, 60_000);

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

  test("Gmail's forwarding confirmation is recognised only when google.com's DKIM passed at SES", async () => {
    const signed = await parseMail(eml("gmail-confirmation-signed.eml"));
    expect(isProviderConfirmation(signed, authenticate(signed, { verdicts: UNKNOWN }))).toBe(true);
    // The same From with no signature SES vouched for: an ordinary email.
    const unsigned = await parseMail(eml("gmail-confirmation.eml"));
    expect(isProviderConfirmation(unsigned, authenticate(unsigned, { verdicts: PASS }))).toBe(false);
    const clinic = await parseMail(eml("ses-aligned-pass.eml"));
    expect(isProviderConfirmation(clinic, authenticate(clinic, { verdicts: UNKNOWN }))).toBe(false);
  });

  test("bareAddress reads the address out of a From-style value", () => {
    expect(bareAddress("healdesk <Hello@Healdesk.io>")).toBe("hello@healdesk.io");
    expect(bareAddress("a@b.test")).toBe("a@b.test");
    expect(bareAddress("no address")).toBeNull();
  });
});

describe("authentication: whether the From domain is the sender's (SES's own headers, topmost only)", () => {
  const FROM = "owner@example-clinic.test";
  async function judged(file: string, verdicts: Parameters<typeof authenticate>[1]["verdicts"] = UNKNOWN) {
    const mail = await parseMail(eml(file));
    const auth = authenticate(mail, { verdicts });
    return { auth, ok: isAuthenticated(auth, mail.from) };
  }

  test("unsigned mail is not authenticated", async () => {
    const { auth, ok } = await judged("ses-unsigned.eml");
    expect(ok).toBe(false);
    expect(auth.verdicts).toMatchObject({ spam: "PASS", virus: "PASS", dkim: "GRAY", dmarc: "GRAY", spf: "GRAY" });
  });

  test("a DKIM failure is not authenticated", async () => {
    const { auth, ok } = await judged("ses-dkim-fail.eml");
    expect(ok).toBe(false);
    expect(auth.verdicts.dkim).toBe("FAIL");
    // Nor when SES's notice says FAIL, whatever DMARC says.
    expect((await judged("ses-aligned-pass.eml", { ...PASS, dkim: "FAIL" })).ok).toBe(false);
  });

  test("an aligned DKIM pass is authenticated: the From domain, or a parent or subdomain of it", async () => {
    const { auth, ok } = await judged("ses-aligned-pass.eml");
    expect(ok).toBe(true);
    expect(auth.dkimPassDomains).toEqual(["example-clinic.test"]);
    expect(isAuthenticated(auth, "front@mail.example-clinic.test")).toBe(true);
    expect(alignedDkimPass({ ...auth, dkimPassDomains: ["mail.example-clinic.test"] }, "example-clinic.test")).toBe(true);
    expect(alignedDkimPass({ ...auth, dkimPassDomains: ["other-clinic.test"] }, "example-clinic.test")).toBe(false);
  });

  test("a DKIM pass by some other domain is not aligned, so not authenticated", async () => {
    const { auth, ok } = await judged("ses-unaligned-pass.eml");
    expect(auth.verdicts.dkim).toBe("PASS");
    expect(ok).toBe(false);
  });

  test("an Authentication-Results the sender wrote below SES's is never read", async () => {
    const mail = await parseMail(eml("ses-forged-results.eml"));
    expect(sesAuthenticationResults(mail)).toMatchObject({ dkim: "GRAY", dmarc: "GRAY", dkimPassDomains: [] });
    expect(isAuthenticated(authenticate(mail, { verdicts: UNKNOWN }), FROM)).toBe(false);
  });

  test("a DMARC pass is enough; the notice's verdicts win over the headers", async () => {
    expect((await judged("ses-unsigned.eml", { ...UNKNOWN, dmarc: "PASS" })).ok).toBe(true);
    expect((await judged("ses-unsigned.eml", { ...PASS, dkim: "GRAY", dmarc: "FAIL" })).ok).toBe(false);
  });

  test("a DIRECT change needs SES's notice itself: DKIM PASS, and SPF and DMARC PASS where the notice has them; headers never stand in", async () => {
    expect(noticeVerdictsPass({ verdicts: PASS })).toBe(true);
    expect(noticeVerdictsPass({ verdicts: { ...UNKNOWN, dkim: "PASS" } })).toBe(true);
    expect(noticeVerdictsPass({ verdicts: UNKNOWN })).toBe(false);
    for (const dkim of ["FAIL", "GRAY", "PROCESSING_FAILED", "DISABLED"] as const) expect(noticeVerdictsPass({ verdicts: { ...PASS, dkim } })).toBe(false);
    expect(noticeVerdictsPass({ verdicts: { ...PASS, spf: "FAIL" } })).toBe(false);
    expect(noticeVerdictsPass({ verdicts: { ...PASS, dmarc: "GRAY" } })).toBe(false);
    // The stored message's own SES header says pass, the notice says nothing: authenticated, but not by the notice.
    const mail = await parseMail(eml("ses-aligned-pass.eml"));
    expect(isAuthenticated(authenticate(mail, { verdicts: UNKNOWN }), mail.from)).toBe(true);
    expect(noticeVerdictsPass({ verdicts: UNKNOWN })).toBe(false);
  });

  test("a sender-written amazonses.com Authentication-Results lower in the list, with an aligned DKIM pass, is ignored: SES's topmost decides", async () => {
    const mail = await parseMail(eml("ses-forged-results.eml"));
    // The forged header is in the message, below SES's own.
    expect(mail.headers.get("authentication-results")).toHaveLength(2);
    expect(mail.headers.get("authentication-results")![1]).toMatch(/dkim=pass header\.i=@/);
    const auth = authenticate(mail, { verdicts: UNKNOWN });
    expect(auth.dkimPassDomains).toEqual([]);
    expect(auth.verdicts).toMatchObject({ dkim: "GRAY", dmarc: "GRAY", spf: "GRAY" });
    expect(isAuthenticated(auth, mail.from)).toBe(false);
  });

  test("no SES header at all: nothing is authenticated but by the notice's DMARC", async () => {
    expect((await judged("clinic-normal.eml")).ok).toBe(false);
    expect((await judged("clinic-normal.eml", PASS)).ok).toBe(true);
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
      authenticated: true,
      fromClinic: true,
      noticeVerified: false,
    });
    expect(fields.noticeVerified).toBe("no");
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

  test("a ref that itself begins with HD (1 in 1,024 of them) is read back whole, not stripped as a prefix", () => {
    // newSupportRef draws from an alphabet holding H and D, so "HD7F3" is a
    // real ref, printed "HD-HD7F3". Read as a prefix, it became "7F3", no ref
    // at all, and the clinic's reply opened a second case (CI run 41022562042).
    expect(refsInSubject("Re: We've got your email (ref HD-HD7F3)")).toEqual(["HD7F3"]);
    expect(refsInSubject("about HD-HDHD1")).toEqual(["HDHD1"]);
    expect(readRef("HD7F3")).toBe("HD7F3");
    expect(readRef("HD-HD7F3")).toBe("HD7F3");
    expect(readRef("hdhd7f3")).toBe("HD7F3");
    expect(readRef("HDHD1")).toBe("HDHD1");
    // Every ref the generator can make survives printing and reading back.
    for (const a of SUPPORT_REF_ALPHABET) {
      for (const b of SUPPORT_REF_ALPHABET) {
        const ref = `${a}${b}7F3`;
        expect(readRef(printRef(ref))).toBe(ref);
        expect(readRef(ref)).toBe(ref);
        expect(refsInSubject(`Re: x (ref ${printRef(ref)})`)).toEqual([ref]);
      }
    }
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
    // It goes to the owners and billing contacts, not necessarily the address that wrote: it promises no address.
    expect(r.text).not.toMatch(/this address/);
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

  test("the topic set but no bucket: a configuration error, 503 so SNS retries, nothing read", async () => {
    vi.stubEnv("HEALDESK_INBOUND_MAIL_TOPIC_ARN", TOPIC);
    vi.stubEnv("HEALDESK_INBOUND_MAIL_BUCKET", "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const receipt = JSON.stringify({
      notificationType: "Received",
      mail: { messageId: "o3k1ses0002", timestamp: "2026-10-26T14:00:00.000Z" },
      receipt: { timestamp: "2026-10-26T14:00:01.000Z", action: { type: "S3", bucketName: "inbound-bucket", objectKey: "mail/o3k1ses0002" } },
    });
    const store = { get: vi.fn(), delete: vi.fn(), list: vi.fn() };
    expect((await post(notification({ Message: receipt }), { store })).status).toBe(503);
    expect(store.get).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
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
