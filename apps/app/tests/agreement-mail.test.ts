import { describe, expect, test } from "vitest";

import {
  renderAgreementCopy,
  sendAgreementCopy,
} from "@/lib/email/agreement-copy";
import {
  buildRawMessage,
  MailFormatError,
  type DeliveryResult,
  type DeliveryTarget,
  type EmailTransport,
  type OutgoingEmail,
} from "@/lib/reporting/deliver";

/**
 * The message that carries the counterparty's copy.
 *
 * This is the piece with no second chance in it. A PDF that renders wrongly is
 * visibly wrong; a MIME message that is subtly malformed is ACCEPTED by SES and
 * then rendered as garbage — or silently dropped — by one mail client out of
 * five, which is discovered months later by a clinic that cannot produce its
 * agreement. So the assertions here are about the wire format rather than about
 * the words: boundaries, base64, line lengths, header encoding, and the three
 * refusals that stop a hostile value reaching a header.
 *
 * The message is parsed back rather than string-matched wherever the parse is
 * the point. A test that greps for `Content-Type: application/pdf` passes on a
 * message whose attachment is truncated.
 */

/** Bytes that are not text: a real PDF preamble plus control characters. */
const PDF = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3,
  0xcf, 0xd3, 0x0d, 0x0a, 0x00, 0x01, 0x02, 0xff, 0xfe, 0x0a,
]);

type RawInput = Parameters<typeof buildRawMessage>[0];

function raw(over: Partial<RawInput> = {}): string {
  return Buffer.from(
    buildRawMessage({
      from: "healdesk <hello@healdesk.io>",
      to: "owner@clinic.test",
      subject: "Your signed business associate agreement for Radiance Med Spa",
      text: "line one\nline two",
      html: "<p>line one</p>\n<p>line two</p>",
      attachments: [
        {
          filename: "healdesk-baa-0.1.0-draft-2026-08-18.pdf",
          contentType: "application/pdf",
          content: PDF,
        },
      ],
      now: new Date("2026-08-18T14:03:11.000Z"),
      ...over,
    }),
  ).toString("utf8");
}

/** The boundary the top-level Content-Type declares, not one guessed at. */
function mixedBoundary(message: string): string {
  const found = /^Content-Type: multipart\/mixed; boundary="([^"]+)"$/m.exec(
    message,
  );
  expect(found).not.toBeNull();
  return found![1]!;
}

/** Split a multipart body on its own boundary, headers and body separated. */
function parts(
  message: string,
  boundary: string,
): { headers: string; body: string }[] {
  const [, ...rest] = message.split(`\r\n--${boundary}`);
  return rest
    .filter((chunk) => !chunk.startsWith("--"))
    .map((chunk) => {
      const at = chunk.indexOf("\r\n\r\n");
      return {
        headers: chunk.slice(0, at).replace(/^\r\n/, ""),
        body: chunk.slice(at + 4),
      };
    });
}

function decodeBase64Body(body: string): Buffer {
  const lines = body.split("\r\n");
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(76);
  }
  return Buffer.from(lines.join(""), "base64");
}

describe("buildRawMessage", () => {
  test("nests one multipart/alternative and one attachment under multipart/mixed", () => {
    const message = raw();
    const mixed = mixedBoundary(message);
    const top = parts(message, mixed);

    expect(top).toHaveLength(2);
    expect(top[0]!.headers).toContain("Content-Type: multipart/alternative");
    expect(top[1]!.headers).toContain(
      'Content-Type: application/pdf; name="healdesk-baa-0.1.0-draft-2026-08-18.pdf"',
    );
    expect(top[1]!.headers).toContain(
      'Content-Disposition: attachment; filename="healdesk-baa-0.1.0-draft-2026-08-18.pdf"',
    );

    // The alternative's boundary is its own, and the outer boundary does not
    // occur anywhere inside a part — the failure that truncates a message.
    const alternative = /boundary="([^"]+)"/.exec(top[0]!.headers)![1]!;
    expect(alternative).not.toBe(mixed);
    expect(top[0]!.body).not.toContain(mixed);
    expect(top[1]!.body).not.toContain(mixed);

    const inner = parts(`\r\n${top[0]!.body}`, alternative);
    expect(inner).toHaveLength(2);
    expect(inner[0]!.headers).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(inner[1]!.headers).toContain("Content-Type: text/html; charset=UTF-8");
  });

  test("round-trips the attachment's bytes exactly", () => {
    const message = raw();
    const [, attachment] = parts(message, mixedBoundary(message));

    expect(decodeBase64Body(attachment!.body.replace(/\r\n$/, "")).equals(
      Buffer.from(PDF),
    )).toBe(true);
  });

  test("encodes the text parts in the CRLF canonical form RFC 2045 requires", () => {
    const message = raw();
    const [alternativePart] = parts(message, mixedBoundary(message));
    const alternative = /boundary="([^"]+)"/.exec(alternativePart!.headers)![1]!;
    const inner = parts(`\r\n${alternativePart!.body}`, alternative);

    // Bare LF survives base64 intact and decodes to a body no client is
    // required to lay out — on the agreement copy, a paragraph of legal
    // wording with its structure removed.
    expect(decodeBase64Body(inner[0]!.body).toString("utf8")).toBe(
      "line one\r\nline two",
    );
    expect(decodeBase64Body(inner[1]!.body).toString("utf8")).toBe(
      "<p>line one</p>\r\n<p>line two</p>",
    );
  });

  test("gives every message its own boundaries", () => {
    expect(mixedBoundary(raw())).not.toBe(mixedBoundary(raw()));
  });

  test("keeps every line inside the RFC 5322 limit, with no bare newline", () => {
    const message = raw({
      // Long enough that base64 has to wrap, and binary enough that a naive
      // encoder would emit an 8-bit octet.
      attachments: [
        {
          filename: "healdesk-baa.pdf",
          contentType: "application/pdf",
          content: new Uint8Array(20_000).map((_, i) => (i * 7) % 256),
        },
      ],
    });

    expect(/[^\r]\n/.test(message)).toBe(false);
    for (const line of message.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
  });

  describe("headers", () => {
    test("encodes a non-ASCII subject as RFC 2047 words that decode back", () => {
      const subject =
        "Your signed business associate agreement for Café Ärzte Zentrum für Größe";
      const message = raw({ subject });

      const header = /^Subject: ((?:.|\r\n[ \t])*)$/m.exec(message)![1]!;
      const words = header.split("\r\n ");

      expect(words.length).toBeGreaterThan(1);
      for (const word of words) {
        // The limit an encoded-word must not exceed, delimiters included.
        expect(word.length).toBeLessThanOrEqual(75);
        expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/);
      }

      // Reassembled, the bytes are the subject — which is only true if no split
      // landed inside a UTF-8 sequence.
      const decoded = Buffer.concat(
        words.map((word) =>
          Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(word)![1]!, "base64"),
        ),
      ).toString("utf8");
      expect(decoded).toBe(subject);
    });

    test("leaves a plain ASCII subject alone", () => {
      expect(raw({ subject: "Your agreement" })).toContain(
        "\r\nSubject: Your agreement\r\n",
      );
    });

    test("reduces a non-ASCII filename to something a header can carry", () => {
      const message = raw({
        attachments: [
          {
            filename: "béatrice's agreement.pdf",
            contentType: "application/pdf",
            content: PDF,
          },
        ],
      });

      const name = /filename="([^"]+)"/.exec(message)![1]!;
      expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(name.endsWith(".pdf")).toBe(true);
    });

    test("spends the length budget on the stem, never on the extension", () => {
      // The cap used to be a slice on the finished string, so a 150-character
      // name came back as 100 characters of stem and no extension at all: an
      // attachment the recipient's machine does not know how to open, arriving
      // under a note saying their signed agreement is attached.
      const message = raw({
        attachments: [
          {
            filename: `${"x".repeat(150)}.pdf`,
            contentType: "application/pdf",
            content: PDF,
          },
        ],
      });

      const name = /filename="([^"]+)"/.exec(message)![1]!;
      expect(name).toBe(`${"x".repeat(96)}.pdf`);
      expect(name.length).toBe(100);
    });

    test("keeps the whole extension when the stem only just overflows", () => {
      // 98 characters plus ".pdf" is 102, and the old cut at 100 left ".p" —
      // worse than losing the extension outright, because it is a plausible
      // one: the file opens with the wrong application instead of prompting.
      const message = raw({
        attachments: [
          {
            filename: `${"x".repeat(98)}.pdf`,
            contentType: "application/pdf",
            content: PDF,
          },
        ],
      });

      const name = /filename="([^"]+)"/.exec(message)![1]!;
      expect(name.endsWith(".pdf")).toBe(true);
      expect(name).not.toMatch(/\.p$/);
      expect(name.length).toBeLessThanOrEqual(100);
    });

    test("declares the same name in both headers after truncation", () => {
      // Content-Type's `name` and Content-Disposition's `filename` are produced
      // from one call for exactly this reason; a client that reads the first
      // and a client that reads the second must save the same file.
      const message = raw({
        attachments: [
          {
            filename: `${"x".repeat(150)}.pdf`,
            contentType: "application/pdf",
            content: PDF,
          },
        ],
      });

      const declared = [...message.matchAll(/name="([^"]+)"/g)]
        .map((m) => m[1]!)
        .filter((n) => n.startsWith("x"));
      expect(declared).toHaveLength(2);
      expect(declared[0]).toBe(declared[1]);
    });

    test("refuses a line break in any value that reaches a header", () => {
      for (const over of [
        { to: "owner@clinic.test\r\nBcc: elsewhere@evil.test" },
        { from: "healdesk <hello@healdesk.io>\nBcc: elsewhere@evil.test" },
        { subject: "Your agreement\r\nBcc: elsewhere@evil.test" },
        {
          attachments: [
            {
              filename: 'a.pdf"\r\nContent-Type: text/html',
              contentType: "application/pdf",
              content: PDF,
            },
          ],
        },
      ] satisfies Partial<RawInput>[]) {
        expect(() => raw(over)).toThrow(MailFormatError);
      }
    });

    test("refuses anything but a single plain address, and does not echo it", () => {
      for (const to of [
        "healdesk <owner@clinic.test>",
        "owner@clinic.test, second@clinic.test",
        "owner@clinic.test>",
        "not-an-address",
        "",
      ]) {
        let thrown: unknown;
        try {
          raw({ to });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(MailFormatError);
        // The address is the one personal datum here and this message is logged.
        expect((thrown as Error).message).not.toContain("clinic.test");
      }
    });

    test("carries an internationalised domain as its punycode A-label", () => {
      // The address validator was written as negated character classes, so an
      // internationalised address satisfied its SHAPE and `To:` was then
      // written as raw 8-bit UTF-8 — the malformed message that is hardest to
      // see, because SES may take it and a receiving MTA that has not
      // negotiated SMTPUTF8 decides from there what becomes of a contract.
      //
      // The domain half has a standard ASCII form, so refusing it would be
      // refusing an address we know perfectly well how to reach. It is
      // converted instead, and what goes on the wire is 7-bit.
      const message = raw({ to: "gunter@klinik-münchen.test" });

      expect(message).toContain(
        "\r\nTo: gunter@xn--klinik-mnchen-3ob.test\r\n",
      );
      expect(message).not.toContain("münchen");

      // The assertion that actually matters is about the whole header block,
      // not the one line: nothing before the first blank line is 8-bit.
      const headers = message.slice(0, message.indexOf("\r\n\r\n"));
      expect(/^[\x20-\x7e\r\n\t]*$/.test(headers)).toBe(true);
    });

    test("refuses a non-ASCII mailbox name rather than emitting an 8-bit header", () => {
      // The local part has no A-label to be converted into. Carrying one needs
      // SMTPUTF8, negotiated per hop and not spoken here; RFC 2047 does not
      // apply inside an address, and transliterating one names a different
      // mailbox — which on this message means delivering a signed contract
      // somewhere else. So it is refused, and the refusal still says nothing
      // about the address, because these strings reach a log.
      for (const over of [
        { to: "günter@clinic.test" },
        { from: "healdesk Ärzte <hello@healdesk.io>" },
      ] satisfies Partial<RawInput>[]) {
        let thrown: unknown;
        try {
          raw(over);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(MailFormatError);
        expect((thrown as Error).message).not.toContain("nter@");
        expect((thrown as Error).message).not.toContain("Ärzte");
      }
    });

    test("refuses a content type that is not one", () => {
      expect(() =>
        raw({
          attachments: [
            {
              filename: "a.pdf",
              contentType: 'application/pdf; name="../../etc/passwd"',
              content: PDF,
            },
          ],
        }),
      ).toThrow(MailFormatError);
    });
  });

  test("refuses an empty attachment rather than announcing a document with none", () => {
    expect(() =>
      raw({
        attachments: [
          {
            filename: "a.pdf",
            contentType: "application/pdf",
            content: new Uint8Array(0),
          },
        ],
      }),
    ).toThrow(MailFormatError);
  });

  test("refuses an oversized attachment before it is encoded", () => {
    expect(() =>
      raw({
        attachments: [
          {
            filename: "a.pdf",
            contentType: "application/pdf",
            // Never allocated as base64: the estimate rejects it first.
            content: new Uint8Array(40 * 1024 * 1024),
          },
        ],
      }),
    ).toThrow(MailFormatError);
  });

  test("refuses to be used as the no-attachment path", () => {
    expect(() => raw({ attachments: [] })).toThrow(MailFormatError);
  });
});

// -----------------------------------------------------------------------------

class StubTransport implements EmailTransport {
  readonly name = "stub";
  sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];

  constructor(private readonly result: DeliveryResult | Error) {}

  async send(
    target: DeliveryTarget,
    message: OutgoingEmail,
  ): Promise<DeliveryResult> {
    this.sent.push({ target, message });
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

const ACCEPTANCE = {
  agreementId: "3b7e1c2a-5d4f-4a6b-9c8d-7e6f5a4b3c2d",
  to: "owner@radiance.test",
  signatoryName: "Alex Chen",
  clinicName: "Radiance Med Spa",
  version: "0.1.0-draft",
  documentHash: "a".repeat(64),
  acceptedAt: new Date("2026-08-18T14:03:11.000Z"),
  pdf: PDF,
  filename: "healdesk-baa-0.1.0-draft-2026-08-18.pdf",
};

describe("sendAgreementCopy", () => {
  test("hands the transport the exact bytes it was given, as one PDF", async () => {
    const transport = new StubTransport({ status: "sent", messageId: "m-1" });
    const result = await sendAgreementCopy(ACCEPTANCE, { transport });

    expect(result).toEqual({ sent: true, status: "sent" });

    const [attachment] = transport.sent[0]!.message.attachments!;
    expect(attachment!.content).toBe(PDF);
    expect(attachment!.contentType).toBe("application/pdf");
    expect(attachment!.filename).toBe(ACCEPTANCE.filename);
  });

  /**
   * The operator's resend used to call a transport directly: no tags, no
   * idempotency key, no link scan, and Resend's events for it, untagged,
   * were handled by apps/web as its own marketing mail.
   */
  test("goes through the email platform, as the direct kind P6, keyed by the acceptance and the minute", async () => {
    const transport = new StubTransport({ status: "sent", messageId: "m-1" });
    const now = new Date("2026-10-19T12:00:30Z");
    await sendAgreementCopy(ACCEPTANCE, { transport, now });
    const { message } = transport.sent[0]!;
    expect(message.tags).toEqual([
      { name: "app", value: "app" },
      { name: "kind", value: "agreement_copy" },
      { name: "delivery", value: ACCEPTANCE.agreementId },
    ]);
    expect(message.idempotencyKey).toBe(
      `hd-agreement_copy-${ACCEPTANCE.agreementId}-1-${Math.floor(now.getTime() / 60_000)}`,
    );
    expect(message.replyTo).toBe("hello@healdesk.io");
    expect(message.text).toContain("Replies reach the healdesk team. Please leave out patient details.");
    expect(message.text).not.toContain("is a service of");
    expect(message.text).toContain("Wilmington, DE 19801");
    // The id finds the row; it is never in the words.
    expect(message.text).not.toContain(ACCEPTANCE.agreementId);
    expect(message.html).not.toMatch(/href=/);
  });

  test("a name the allowlist would refuse is left out of the words, and the copy still goes", async () => {
    const transport = new StubTransport({ status: "sent", messageId: "m-1" });
    const result = await sendAgreementCopy(
      {
        ...ACCEPTANCE,
        signatoryName: "Call 5125550100 to claim",
        clinicName: `Radiance ${"Aesthetic and Wellness ".repeat(8)}Med Spa LLC`,
      },
      { transport },
    );
    expect(result.sent).toBe(true);
    const { message } = transport.sent[0]!;
    expect(message.text).not.toContain("5125550100");
    expect(message.text).toContain("Signed on 18 August 2026");
    expect(message.subject).toBe("Your signed business associate agreement for your practice");
    expect(message.attachments).toHaveLength(1);
  });

  test("never throws, whatever the transport does", async () => {
    const transport = new StubTransport(new Error("connect ETIMEDOUT"));
    const result = await sendAgreementCopy(ACCEPTANCE, { transport });

    expect(result.sent).toBe(false);
    expect(result.status).toBe("failed");
  });

  test("keeps the signer's address out of the reason it hands back", async () => {
    const transport = new StubTransport({
      status: "failed",
      reason: `550 5.1.1 <${ACCEPTANCE.to}>: user unknown`,
    });
    const result = await sendAgreementCopy(ACCEPTANCE, { transport });

    expect(result.sent).toBe(false);
    expect(result.status === "failed" && result.reason).not.toContain(
      ACCEPTANCE.to,
    );
  });

  test("keeps it out even when the bounce quotes it back in another case", async () => {
    // The address is stored lowercased at signature; a receiving server quotes
    // back whatever form it likes. An exact substring match misses this one,
    // and the reason goes to console.error — a place with none of the
    // protections the acceptance row has.
    const transport = new StubTransport({
      status: "failed",
      reason: `550 5.1.1 <${ACCEPTANCE.to.toUpperCase()}>: user unknown (relayed via postmaster@mx.radiance.test)`,
    });
    const result = await sendAgreementCopy(ACCEPTANCE, { transport });

    expect(result.sent).toBe(false);
    const reason = result.status === "failed" ? result.reason : "";
    expect(reason).not.toContain("RADIANCE.TEST");
    expect(reason).not.toContain("postmaster@mx.radiance.test");
    // Still an explanation, not a redaction of the whole line.
    expect(reason).toContain("550 5.1.1");
  });

  test("refuses an empty document before a transport is reached", async () => {
    const transport = new StubTransport({ status: "sent", messageId: "m-1" });
    const result = await sendAgreementCopy(
      { ...ACCEPTANCE, pdf: new Uint8Array(0) },
      { transport },
    );

    expect(result.sent).toBe(false);
    // A message announcing an attached agreement with nothing attached leaves
    // the recipient believing they hold a copy.
    expect(transport.sent).toHaveLength(0);
  });

  test("refuses a signature with no usable date rather than mailing NaN", async () => {
    const transport = new StubTransport({ status: "sent", messageId: "m-1" });
    const result = await sendAgreementCopy(
      { ...ACCEPTANCE, acceptedAt: new Date("nonsense") },
      { transport },
    );

    expect(result.sent).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });
});

describe("renderAgreementCopy", () => {
  test("states the four facts and no database key", () => {
    const copy = renderAgreementCopy(ACCEPTANCE);

    expect(copy.subject).toContain("Radiance Med Spa");
    for (const body of [copy.text, copy.html]) {
      expect(body).toContain("Alex Chen");
      expect(body).toContain("18 August 2026");
      expect(body).toContain("0.1.0-draft");
      expect(body).toContain(ACCEPTANCE.documentHash);
    }
  });

  test("escapes a clinic name into the HTML rather than injecting it", () => {
    const copy = renderAgreementCopy({
      ...ACCEPTANCE,
      clinicName: '<img src=x onerror="alert(1)">',
    });

    expect(copy.html).not.toContain("<img src=x");
    expect(copy.html).toContain("&lt;img");
    // The one image is the healdesk logo the branded shell carries.
    expect([...copy.html.matchAll(/<img\b/g)]).toHaveLength(1);
  });

  /**
   * Worded by the kind the stored version carries (plan Annex X, P6). A BAA's
   * copy says what it has always said, word for word; a Data Protection
   * Agreement's names its own document and never calls a client a patient.
   */
  test("a BAA's copy is worded as it always was", () => {
    const copy = renderAgreementCopy({ ...ACCEPTANCE, version: "1.2.1" });
    expect(copy.subject).toBe("Your signed business associate agreement for Radiance Med Spa");
    expect(copy.text.split("\n").slice(0, 3)).toEqual([
      "Attached, as a PDF, is the business associate agreement you signed for",
      "Radiance Med Spa. It is the document we recorded at signature, word for",
      "word — the same text that was on your screen.",
    ]);
    expect(copy.text).toContain(
      [
        "Please keep it. This is a contract with two parties to it, and healdesk",
        "should not be the only one holding a copy — if your practice is ever asked",
        "to produce its business associate agreements, this is the file.",
      ].join("\n"),
    );
    expect(copy.html).toContain(
      ">Attached, as a PDF, is the business associate agreement you signed for <strong>Radiance Med Spa</strong>.",
    );
    expect(copy.html).toContain(
      "ever asked to produce its business associate agreements, this is the file.</p>",
    );
  });

  test("a DPA's copy names the Data Protection Agreement, and no patient", () => {
    const copy = renderAgreementCopy({
      ...ACCEPTANCE,
      clinicName: "Golden Paws Veterinary LLC",
      version: "dpa/1.0.0",
    });
    expect(copy.subject).toBe(
      "Your signed data protection agreement for Golden Paws Veterinary LLC",
    );
    expect(copy.text).toContain("Attached, as a PDF, is the data protection agreement you signed for");
    expect(copy.text).toContain("Agreement version dpa/1.0.0.");
    expect(copy.html).toContain("is the data protection agreement you signed for");
    for (const part of [copy.subject, copy.text, copy.html]) {
      expect(part).not.toMatch(/business associate|\bpatients?\b|\bPHI\b/i);
    }
    // Still the four facts.
    for (const body of [copy.text, copy.html]) {
      expect(body).toContain("Alex Chen");
      expect(body).toContain("18 August 2026");
      expect(body).toContain(ACCEPTANCE.documentHash);
    }
  });

  test("a DPA's file is named for it when the renderer gives no name", async () => {
    const transport = new StubTransport({ status: "sent", messageId: "m-dpa" });
    await sendAgreementCopy(
      { ...ACCEPTANCE, version: "dpa/1.0.0", filename: undefined },
      { transport },
    );
    const [attachment] = transport.sent[0]!.message.attachments!;
    expect(attachment!.filename).toBe("healdesk-data-protection-agreement-1.0.0-2026-08-18.pdf");

    const baa = new StubTransport({ status: "sent", messageId: "m-baa" });
    await sendAgreementCopy({ ...ACCEPTANCE, filename: undefined }, { transport: baa });
    expect(baa.sent[0]!.message.attachments![0]!.filename).toBe(
      "healdesk-business-associate-agreement-0.1.0-draft-2026-08-18.pdf",
    );
  });
});
