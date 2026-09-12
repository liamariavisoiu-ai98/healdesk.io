import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { DeliveryTarget, OutgoingEmail } from "@/lib/reporting/deliver";
import { ResendTransport } from "@/lib/reporting/resend-transport";

/**
 * What Resend is actually handed, and what we conclude from what it answers.
 *
 * resend-routing.test.ts proves the refusals, and every case there stops before
 * the SDK is imported — which is what makes it cheap, and also what it cannot
 * cover. Nothing there proves that a message classed "none" REACHES the wire,
 * what is written on it when it does, or that a failure comes back as a
 * failure. Its "none is accepted" case gets as far as the missing API key and
 * stops.
 *
 * That gap is the dangerous half. `resend.emails.send` resolves for a rejected
 * message exactly as it does for an accepted one — errors are `{ data: null,
 * error }`, never throws — so a transport that only try/catches around it
 * reports "sent" for a bad key, an unverified domain, a rate limit and a
 * network failure alike, and the record says a month of contracts went out that
 * never did. Reading the code is not enough to know it does not; the send has
 * to be exercised and the outcome observed.
 *
 * So the SDK is stubbed and the stub IS the wire: `emails.send` is a spy, and
 * every assertion below is about what it received or whether it was called at
 * all, rather than about the wording of an error. Stubbing the vendor rather
 * than calling it is the only way this suite runs on a laptop with no key — and
 * the shapes it returns are copied from resend's own fetchRequest(), which is
 * where the `{ data, error }` contract is implemented.
 */

const send = vi.fn();

vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
    constructor(key: string) {
      if (!key) throw new Error("Missing API key.");
    }
  },
}));

const TARGET: DeliveryTarget = {
  to: "owner@clinic.test",
  clinicId: "c1",
  clinicName: "Radiance Med Spa",
};

function message(overrides: Partial<OutgoingEmail> = {}): OutgoingEmail {
  return {
    subject: "Your signed business associate agreement",
    text: "Attached.",
    html: "<p>Attached.</p>",
    phiClass: "none",
    ...overrides,
  };
}

/** The payload the transport handed the SDK on its first (only) call. */
function sent(): Record<string, unknown> {
  expect(send).toHaveBeenCalledTimes(1);
  return send.mock.calls[0]![0] as Record<string, unknown>;
}

const ACCEPTED = { data: { id: "msg_stub_0001" }, error: null, headers: {} };

/**
 * A fresh API key per test, because the client is memoised by key at module
 * scope — a shared one would let the first test's stub answer the last one's
 * question.
 */
let keys = 0;

const SAVED: Record<string, string | undefined> = {};
const KEYS = ["RESEND_API_KEY", "HEALDESK_EMAIL_FROM"] as const;

beforeEach(() => {
  for (const key of KEYS) SAVED[key] = process.env[key];
  send.mockReset();
  send.mockResolvedValue(ACCEPTED);
  process.env.RESEND_API_KEY = `re_stub_${keys++}`;
  process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
});

afterEach(() => {
  for (const key of KEYS) {
    const value = SAVED[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("a message classed none reaches the wire", () => {
  test("it is sent once, and the id comes back from the API", async () => {
    const result = await new ResendTransport().send(TARGET, message());

    expect(result).toEqual({ status: "sent", messageId: "msg_stub_0001" });
    expect(sent().to).toBe("owner@clinic.test");
  });

  test("an empty html alternative is omitted rather than sent blank", async () => {
    // A blank text/html part is what the clients that prefer HTML render, which
    // is how a report becomes "healdesk sent me nothing".
    await new ResendTransport().send(TARGET, message({ html: "" }));

    expect("html" in sent()).toBe(false);
    expect(sent().text).toBe("Attached.");
  });
});

describe("errors come back as values, and are not read as success", () => {
  /**
   * Each shape below is one resend's own fetchRequest() produces: a parsed API
   * error for a non-2xx, and a synthesised `application_error` with a null
   * status code when fetch itself rejects. None of them throws.
   */
  const REJECTIONS = [
    {
      what: "an invalid API key (401)",
      error: {
        name: "validation_error",
        message: "API key is invalid",
        statusCode: 401,
      },
    },
    {
      what: "a rate limit (429)",
      error: {
        name: "rate_limit_exceeded",
        message: "Too many requests",
        statusCode: 429,
      },
    },
    {
      what: "an unverified sending domain (403)",
      error: {
        name: "validation_error",
        message: "The healdesk.io domain is not verified",
        statusCode: 403,
      },
    },
    {
      what: "a network failure, which the SDK reports rather than throws",
      error: {
        name: "application_error",
        message: "Unable to fetch data. The request could not be resolved.",
        statusCode: null,
      },
    },
  ] as const;

  for (const { what, error } of REJECTIONS) {
    test(`${what} is a failure`, async () => {
      send.mockResolvedValue({ data: null, error, headers: null });

      const result = await new ResendTransport().send(TARGET, message());

      expect(result.status).toBe("failed");
      expect(result.status === "failed" && result.reason).toContain(
        error.message,
      );
    });
  }

  test("a response with neither an error nor an id is a failure", async () => {
    // Nothing can be said about this message afterwards, so it is not recorded
    // as delivered — the one outcome where "sent" would be a guess.
    send.mockResolvedValue({ data: {}, error: null, headers: {} });

    const result = await new ResendTransport().send(TARGET, message());

    expect(result.status).toBe("failed");
  });

  test("a thrown error is a failure, not an escape", async () => {
    send.mockRejectedValue(new Error("socket hang up"));

    const result = await new ResendTransport().send(TARGET, message());

    expect(result).toEqual({ status: "failed", reason: "socket hang up" });
  });
});

describe("the attachment is bytes, and it is bytes we sent", () => {
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

  test("base64 content, and no path for anything to fetch", async () => {
    // `path` is a URL Resend would go and GET. Using it would mean hosting a
    // signed business associate agreement at a fetchable address — the exact
    // artefact agreement-copy.ts refused to create when it chose to mail a file
    // instead of a link.
    await new ResendTransport().send(
      TARGET,
      message({
        attachments: [
          {
            filename: "healdesk-baa-0.0.0-draft-2026-09-07.pdf",
            contentType: "application/pdf",
            content: PDF,
          },
        ],
      }),
    );

    const attachments = sent().attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.content).toBe(Buffer.from(PDF).toString("base64"));
    expect(attachments[0]!.contentType).toBe("application/pdf");
    expect("path" in attachments[0]!).toBe(false);
  });

  test("over the size ceiling, nothing is uploaded at all", async () => {
    // The point of checking locally is that the refusal costs no bandwidth and
    // no memory: the base64 string that would have been a third larger again is
    // never built, and the SDK is never called.
    const result = await new ResendTransport().send(
      TARGET,
      message({
        attachments: [
          {
            filename: "much-too-large.pdf",
            contentType: "application/pdf",
            content: new Uint8Array(31 * 1024 * 1024),
          },
        ],
      }),
    );

    expect(result.status).toBe("failed");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the recipient goes out in the form that can be delivered", () => {
  test("an internationalised domain is punycoded before it is sent", async () => {
    // The half that a line-break check does not cover. isSendableAddress() —
    // which agreements.ts calls isEmail, and which decides whether a signature
    // is accepted at all — returns true for this address ONLY because
    // normaliseRecipient converts the domain. If the transport then sent the
    // typed form, the signature-time question and the send-time behaviour would
    // be different questions, and the answer would arrive as a copy that never
    // came.
    await new ResendTransport().send(
      { ...TARGET, to: "gunter@klinik-münchen.test" },
      message(),
    );

    expect(sent().to).toBe("gunter@xn--klinik-mnchen-3ob.test");
  });

  test("a non-ASCII mailbox name is refused here, not by the API", async () => {
    // There is no ASCII form of a mailbox name to convert to: RFC 2047 does not
    // apply inside an address and transliterating one names a DIFFERENT
    // mailbox. So it is refused, with a reason an operator can act on.
    const result = await new ResendTransport().send(
      { ...TARGET, to: "günter@klinik.test" },
      message(),
    );

    expect(result.status).toBe("failed");
    expect(send).not.toHaveBeenCalled();
  });

  test("a display name or a second address is refused", async () => {
    // `to` takes one bare address. A comma-separated pair here would be either
    // a silently dropped recipient or a silently added one, and the second is
    // how a signed contract reaches somebody it was not addressed to.
    const result = await new ResendTransport().send(
      { ...TARGET, to: "Gunter <g@klinik.test>, someone@elsewhere.test" },
      message(),
    );

    expect(result.status).toBe("failed");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("nothing that may carry patient information reaches the wire", () => {
  // The routing rule, asserted as an OUTCOME rather than as an error message:
  // the spy is the wire, so "never called" is the property that matters.
  test("a may-carry-phi message, attachment and all, is never sent", async () => {
    await expect(
      new ResendTransport().send(
        TARGET,
        message({
          phiClass: "may-carry-phi",
          attachments: [
            {
              filename: "agreement.pdf",
              contentType: "application/pdf",
              content: new Uint8Array([1, 2, 3]),
            },
          ],
        }),
      ),
    ).rejects.toThrow();

    expect(send).not.toHaveBeenCalled();
  });

  test("a message whose class field is absent is never sent", async () => {
    const undeclared = message();
    delete (undeclared as Partial<OutgoingEmail>).phiClass;

    await expect(
      new ResendTransport().send(TARGET, undeclared),
    ).rejects.toThrow();

    expect(send).not.toHaveBeenCalled();
  });

  test("a class no version of PhiClass has ever contained is never sent", async () => {
    await expect(
      new ResendTransport().send(TARGET, {
        ...message(),
        phiClass: "probably-fine" as unknown as OutgoingEmail["phiClass"],
      }),
    ).rejects.toThrow();

    expect(send).not.toHaveBeenCalled();
  });
});

describe("a send that never answers", () => {
  test("is reported as failed rather than held open forever", async () => {
    // The SDK gives no timeout and fetch has no default deadline, so a socket
    // that connects and goes quiet would block the signing request until the
    // platform killed it — and a buyer told their agreement was not recorded
    // signs it again.
    vi.useFakeTimers();
    try {
      send.mockImplementation(() => new Promise(() => {}));

      const pending = new ResendTransport().send(TARGET, message());
      await vi.advanceTimersByTimeAsync(10_001);

      const result = await pending;
      expect(result.status).toBe("failed");
      // Said plainly, because it decides what an operator does next: the
      // message may have gone out, so this is not automatically a resend.
      expect(result.status === "failed" && result.reason).toContain(
        "may still",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
