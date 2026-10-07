import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { SESv2ClientConfig } from "@aws-sdk/client-sesv2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import type { DeliveryTarget, OutgoingEmail } from "@/lib/reporting/deliver";

/**
 * What SES is actually handed, and what SesTransport refuses before it hands
 * over anything.
 *
 * Until 6 October 2026 none of this could run in production: the SDK import
 * was compiled into `throw MODULE_NOT_FOUND` (crypto/kms.ts has the account),
 * so the transport failed before its guards were reached. Now the SDK loads,
 * and the guard that keeps the business associate agreement's promise — mail
 * that may carry patient information never goes over a channel that cannot
 * negotiate encryption — runs on real mail. resend-routing.test.ts checks only
 * that getTransport() picks "ses", and aws-sdk-clients.test.ts sends through a
 * stub that always answers REQUIRE: neither reaches a refusal, or the SDK's
 * own wire.
 *
 * So SESv2's REST API is served from this process, and the real SDK is pointed
 * at it the way an operator points it anywhere: AWS_ENDPOINT_URL_SESV2, with
 * AWS's documentation placeholder for credentials, signed for an endpoint that
 * never checks them. The assertions are about which requests arrived, so a
 * refusal is proven by what was NOT sent. deliver.ts keeps its client and the
 * set it has verified at module scope, so every test imports a fresh copy.
 */

type SesRequest = { method: string; path: string; body: Record<string, unknown> };

async function localSes() {
  const requests: SesRequest[] = [];
  let deliveryOptions: { TlsPolicy?: string } | undefined;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const path = decodeURIComponent(new URL(req.url ?? "/", "http://ses.local").pathname);
      requests.push({
        method: req.method ?? "",
        path,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      });

      const answer = (status: number, payload: object, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };

      const set = /^\/v2\/email\/configuration-sets\/([^/]+)$/.exec(path);
      if (req.method === "GET" && set) {
        answer(200, {
          ConfigurationSetName: set[1],
          ...(deliveryOptions ? { DeliveryOptions: deliveryOptions } : {}),
        });
      } else if (req.method === "POST" && path === "/v2/email/outbound-emails") {
        answer(200, { MessageId: `local-message-${requests.length}` });
      } else {
        answer(400, { message: "not served here" }, { "x-amzn-errortype": "BadRequestException" });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    /** What GetConfigurationSet answers for DeliveryOptions; undefined omits it. */
    setDeliveryOptions(value: { TlsPolicy?: string } | undefined) {
      deliveryOptions = value;
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

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

const AGREEMENT = {
  filename: "healdesk-baa.pdf",
  contentType: "application/pdf",
  content: new Uint8Array(Buffer.from("%PDF-1.7 synthetic")),
};

const SET = "healdesk-phi";
const READ_SET = ["GET", `/v2/email/configuration-sets/${SET}`];
const SEND = ["POST", "/v2/email/outbound-emails"];

const ENV = [
  "HEALDESK_SES_CONFIGURATION_SET",
  "HEALDESK_EMAIL_FROM",
  "HEALDESK_EMAIL_TRANSPORT",
  "AWS_REGION",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_SESV2",
  "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;

let ses: Awaited<ReturnType<typeof localSes>>;
let saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  ses = await localSes();
});

afterAll(() => ses.close());

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];

  process.env.HEALDESK_SES_CONFIGURATION_SET = SET;
  process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
  process.env.HEALDESK_EMAIL_TRANSPORT = "ses";
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ENDPOINT_URL_SESV2 = ses.url;
  process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
  process.env.AWS_SECRET_ACCESS_KEY = "test-only-not-a-secret";

  ses.requests.length = 0;
  ses.setDeliveryOptions({ TlsPolicy: "REQUIRE" });
  vi.resetModules();
});

afterEach(() => {
  for (const name of ENV) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.doUnmock("@aws-sdk/client-sesv2");
  vi.resetModules();
});

/** deliver.ts as a new process would load it: no client, no verified set. */
const freshDeliver = () => import("@/lib/reporting/deliver");

const wire = () => ses.requests.map((request) => [request.method, request.path]);

describe("SesTransport refuses before anything is sent", () => {
  test("no configuration set: refused, and SES is never asked", async () => {
    delete process.env.HEALDESK_SES_CONFIGURATION_SET;
    const { SesTransport } = await freshDeliver();

    await expect(new SesTransport().send(TARGET, message())).rejects.toThrow(
      /HEALDESK_SES_CONFIGURATION_SET is not set/,
    );
    expect(ses.requests).toEqual([]);
  });

  test.each([
    ["OPTIONAL", { TlsPolicy: "OPTIONAL" }, /TlsPolicy=OPTIONAL, not REQUIRE/],
    ["absent", undefined, /TlsPolicy=unset, not REQUIRE/],
  ] as const)(
    "a set whose TLS policy is %s: the set is read, the message is refused, nothing is sent",
    async (_label, options, refusal) => {
      ses.setDeliveryOptions(options);
      const { getTransport } = await freshDeliver();

      // The route mail that may carry patient information takes.
      const transport = getTransport("may-carry-phi");
      expect(transport.name).toBe("ses");

      await expect(transport.send(TARGET, message({ phiClass: "may-carry-phi" }))).rejects.toThrow(
        refusal,
      );
      // An attachment changes the shape of the content, never the guard above it.
      await expect(
        transport.send(TARGET, message({ phiClass: "may-carry-phi", attachments: [AGREEMENT] })),
      ).rejects.toThrow(refusal);

      // Read each time, because a refusal is never remembered as a pass.
      expect(wire()).toEqual([READ_SET, READ_SET]);
    },
  );

  test("a set put right after a refusal is read again, and then used", async () => {
    ses.setDeliveryOptions({ TlsPolicy: "OPTIONAL" });
    const { SesTransport } = await freshDeliver();
    await expect(new SesTransport().send(TARGET, message())).rejects.toThrow(/not REQUIRE/);

    ses.setDeliveryOptions({ TlsPolicy: "REQUIRE" });
    expect(await new SesTransport().send(TARGET, message())).toMatchObject({ status: "sent" });
    expect(wire()).toEqual([READ_SET, READ_SET, SEND]);
  });
});

describe("SesTransport with TlsPolicy=REQUIRE", () => {
  test("reads the set once, then sends naming it", async () => {
    const { SesTransport } = await freshDeliver();

    const result = await new SesTransport().send(TARGET, message({ phiClass: "may-carry-phi" }));

    expect(result).toEqual({ status: "sent", messageId: "local-message-2" });
    expect(wire()).toEqual([READ_SET, SEND]);
    expect(ses.requests[1]!.body).toEqual({
      FromEmailAddress: "healdesk <hello@healdesk.io>",
      Destination: { ToAddresses: ["owner@clinic.test"] },
      ConfigurationSetName: SET,
      Content: {
        Simple: {
          Subject: { Data: "Your signed business associate agreement", Charset: "UTF-8" },
          Body: {
            Text: { Data: "Attached.", Charset: "UTF-8" },
            Html: { Data: "<p>Attached.</p>", Charset: "UTF-8" },
          },
        },
      },
    });
  });

  test("the raw form, for an attachment, names the same set", async () => {
    const { SesTransport } = await freshDeliver();

    await new SesTransport().send(TARGET, message({ attachments: [AGREEMENT] }));

    expect(wire()).toEqual([READ_SET, SEND]);
    const body = ses.requests[1]!.body as {
      ConfigurationSetName?: string;
      Content?: { Raw?: { Data?: string } };
    };
    expect(body.ConfigurationSetName).toBe(SET);
    const mime = Buffer.from(body.Content?.Raw?.Data ?? "", "base64").toString("utf8");
    expect(mime).toContain("To: owner@clinic.test");
    expect(mime).toContain('Content-Disposition: attachment; filename="healdesk-baa.pdf"');
  });

  test("a second message, from a second transport, does not read the set again", async () => {
    const { SesTransport } = await freshDeliver();

    // getTransport() hands back a new SesTransport per message, so the memo
    // has to outlive the instance to be one.
    await new SesTransport().send(TARGET, message());
    await new SesTransport().send(TARGET, message());
    expect(wire()).toEqual([READ_SET, SEND, SEND]);

    // Keyed by name: a different set is read before it is trusted.
    process.env.HEALDESK_SES_CONFIGURATION_SET = "healdesk-phi-2";
    await new SesTransport().send(TARGET, message());
    expect(wire()).toEqual([
      READ_SET,
      SEND,
      SEND,
      ["GET", "/v2/email/configuration-sets/healdesk-phi-2"],
      SEND,
    ]);
    expect(ses.requests.at(-1)!.body.ConfigurationSetName).toBe("healdesk-phi-2");
  });

  /**
   * The construction site, not only sesClientConfig()'s return value: every
   * send above would work just the same from `new SESv2Client({})`, because
   * the environment supplies the region and the endpoint and this endpoint
   * answers at once. What the client was constructed with is where the time
   * limits either are or are not. AWS_REGION is left empty, as .env.example
   * ships it.
   */
  test("the client is built from sesClientConfig(), and an empty AWS_REGION still sends", async () => {
    const constructed: unknown[] = [];
    vi.doMock("@aws-sdk/client-sesv2", async (importOriginal) => {
      const sdk = await importOriginal<typeof import("@aws-sdk/client-sesv2")>();
      class RecordingSESv2Client extends sdk.SESv2Client {
        constructor(config: SESv2ClientConfig) {
          constructed.push(structuredClone(config));
          super(config);
        }
      }
      return { ...sdk, SESv2Client: RecordingSESv2Client };
    });
    process.env.AWS_REGION = "";
    const { SesTransport, sesClientConfig } = await freshDeliver();

    expect(await new SesTransport().send(TARGET, message())).toMatchObject({ status: "sent" });
    expect(await new SesTransport().send(TARGET, message())).toMatchObject({ status: "sent" });

    // One client for the process, built from the bounded config.
    expect(constructed).toEqual([sesClientConfig()]);
    expect(constructed[0]).toMatchObject({
      region: "us-east-1",
      maxAttempts: 2,
      requestHandler: { requestTimeout: 20_000, throwOnRequestTimeout: true },
    });
  });
});
