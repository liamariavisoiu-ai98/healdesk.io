import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  getTransport,
  type DeliveryTarget,
  type OutgoingEmail,
} from "@/lib/reporting/deliver";
import {
  PhiRoutingError,
  ResendTransport,
} from "@/lib/reporting/resend-transport";

/**
 * The routing rule, which is the only thing standing between "Resend does not
 * sign a BAA" and "healdesk sent patient information over a transport with no
 * BAA".
 *
 * Every case here refuses BEFORE any network call — the class gate runs first,
 * and the attachment checks run before the SDK is even imported — so this suite
 * needs no key, no database and no mailbox. That is deliberate: a safety
 * property that can only be tested against a live vendor is a safety property
 * nobody tests.
 */

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

const KEYS = [
  "HEALDESK_EMAIL_TRANSPORT",
  "RESEND_API_KEY",
  "HEALDESK_EMAIL_FROM",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("ResendTransport refuses PHI", () => {
  test("a may-carry-phi message is refused, and not as a delivery failure", async () => {
    // Thrown, not returned. A `failed` result is indistinguishable from a
    // bounce: the ops console would offer a resend, and every resend would put
    // the same message back on the same wire.
    await expect(
      new ResendTransport().send(TARGET, message({ phiClass: "may-carry-phi" })),
    ).rejects.toBeInstanceOf(PhiRoutingError);
  });

  test("a message with no class at all is refused", async () => {
    // What a JavaScript caller, a deserialised payload or a `as never` cast
    // produces. The type says required; this is the half that enforces it, and
    // the default has to be the strict side or the whole thing is decoration.
    const undeclared = { ...message(), phiClass: undefined } as unknown;

    await expect(
      new ResendTransport().send(TARGET, undeclared as OutgoingEmail),
    ).rejects.toBeInstanceOf(PhiRoutingError);
  });

  test("the refusal does not depend on configuration being present", async () => {
    // No API key, no From address: the class is checked first, so the reason an
    // operator reads is the routing rule rather than whichever variable
    // happened to be unset that day.
    const thrown = await new ResendTransport()
      .send(TARGET, message({ phiClass: "may-carry-phi" }))
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(PhiRoutingError);
    expect((thrown as Error).message).toContain("business associate agreement");
    expect((thrown as Error).message).not.toContain("RESEND_API_KEY");
  });

  test("a message classed none is accepted as far as the configuration", async () => {
    // Past the gate, and stopped by the missing key — which is what proves the
    // gate is a gate and not a blanket refusal. The error names the variable.
    await expect(
      new ResendTransport().send(TARGET, message()),
    ).rejects.toThrow(/RESEND_API_KEY/);
  });
});

describe("getTransport routes by class first", () => {
  test("resend plus a PHI-bearing message is an error, not a downgrade", () => {
    process.env.HEALDESK_EMAIL_TRANSPORT = "resend";
    expect(() => getTransport("may-carry-phi")).toThrow(PhiRoutingError);
  });

  test("resend carries a message classed none", () => {
    process.env.HEALDESK_EMAIL_TRANSPORT = "resend";
    expect(getTransport("none").name).toBe("resend");
  });

  test("ses carries either class", () => {
    process.env.HEALDESK_EMAIL_TRANSPORT = "ses";
    expect(getTransport("none").name).toBe("ses");
    expect(getTransport("may-carry-phi").name).toBe("ses");
  });

  test("unset still falls to the console stub, for both classes", () => {
    // Unchanged behaviour, asserted so that adding a transport did not quietly
    // change what an unconfigured development machine does.
    expect(getTransport("none").name).toBe("console");
    expect(getTransport("may-carry-phi").name).toBe("console");
  });
});

describe("attachments Resend cannot carry", () => {
  beforeEach(() => {
    // Enough configuration to get past the environment checks. Nothing below
    // reaches the network: every case is refused while assembling the payload.
    process.env.RESEND_API_KEY = "re_not_a_real_key";
    process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
  });

  test("over the 40MB ceiling is refused before anything is encoded", async () => {
    // 31 MB of bytes is about 41.3 MB once base64 has added its third — over
    // the limit, and refused without ever building that string.
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
    expect(result.status === "failed" && result.reason).toContain("base64");
  });

  test("an empty attachment is refused rather than announced", async () => {
    const result = await new ResendTransport().send(
      TARGET,
      message({
        attachments: [
          {
            filename: "agreement.pdf",
            contentType: "application/pdf",
            content: new Uint8Array(0),
          },
        ],
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.reason).toContain("is empty");
  });

  test("a filename carrying a line break is refused", async () => {
    const result = await new ResendTransport().send(
      TARGET,
      message({
        attachments: [
          {
            filename: "agreement.pdf\r\nBcc: someone@elsewhere.test",
            contentType: "application/pdf",
            content: new Uint8Array([1, 2, 3]),
          },
        ],
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.reason).toContain("line break");
  });
});

describe("header values Resend must not be handed", () => {
  beforeEach(() => {
    // Enough configuration that a failure here cannot be the missing key.
    process.env.RESEND_API_KEY = "re_not_a_real_key";
    process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
  });

  test("a subject carrying a line break is refused", async () => {
    // Not hypothetical. The agreement copy's subject is built by interpolating
    // clinicLegalName — 200 characters off the self-serve checkout form, length
    // -checked at signature and never checked for line breaks — and Resend
    // writes it into a Subject header inside code we cannot read. The SES path
    // already refused this via encodeHeaderValue(); until this check existed,
    // the transport that actually sends did not.
    const result = await new ResendTransport().send(
      TARGET,
      message({
        subject:
          "Your signed business associate agreement for Radiance\r\nBcc: someone@elsewhere.test",
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.reason).toContain("line break");
  });

  test("a recipient carrying a line break is refused", async () => {
    const result = await new ResendTransport().send(
      { ...TARGET, to: "owner@clinic.test\r\nBcc: someone@elsewhere.test" },
      message(),
    );

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.reason).toContain("line break");
  });

  test("the class gate still runs first", async () => {
    // Ordering, asserted: a PHI-bearing message with an unusable subject is a
    // routing bug that throws, never a failed result an operator would retry.
    await expect(
      new ResendTransport().send(
        TARGET,
        message({ phiClass: "may-carry-phi", subject: "Bad\r\nBcc: x@y.test" }),
      ),
    ).rejects.toBeInstanceOf(PhiRoutingError);
  });
});
