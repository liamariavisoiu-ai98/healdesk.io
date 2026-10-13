import { generateKeyPairSync, sign } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { POST } from "@/app/api/webhooks/ses/route";
import {
  confirmSubscription,
  isSnsUrl,
  parseSnsMessage,
  sesEventFromNotification,
  type SnsMessage,
  stringToSign,
  verifySnsMessage,
} from "@/lib/email/ses-events";

/**
 * SES's events reach the transcript outbox through SNS (infra/aws/ses.tf,
 * app/api/webhooks/ses). A public URL takes posts from anyone, so these hold
 * what makes a message count: the trusted topic, SNS's version 2 signature
 * over the fields SNS signs, and a certificate and SubscribeURL on SNS's own
 * host. No network: the certificate's key is handed in.
 */

const TOPIC = "arn:aws:sns:us-east-1:865780386982:healdesk-production-ses-events";
const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0000000000.pem";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const getKey = async (url: string) => {
  expect(url).toBe(CERT_URL);
  return publicKey;
};

function signed(fields: Omit<SnsMessage, "Signature" | "SignatureVersion" | "SigningCertURL"> & Partial<SnsMessage>): SnsMessage {
  const message: SnsMessage = { SignatureVersion: "2", SigningCertURL: CERT_URL, Signature: "", ...fields };
  message.Signature = sign("RSA-SHA256", Buffer.from(stringToSign(message)), privateKey).toString("base64");
  return message;
}

const sesBounce = JSON.stringify({
  eventType: "Bounce",
  mail: { messageId: "0100018b-ses-message", destination: ["owner@clinic.test"] },
  bounce: {
    bounceType: "Permanent",
    bouncedRecipients: [{ emailAddress: "owner@clinic.test", diagnosticCode: "smtp; 550 5.1.1 user unknown" }],
  },
});

const notification = (overrides: Partial<SnsMessage> = {}) =>
  signed({
    Type: "Notification",
    MessageId: "sns-1",
    TopicArn: TOPIC,
    Message: sesBounce,
    Timestamp: "2026-10-13T16:00:00.000Z",
    ...overrides,
  });

describe("verifySnsMessage", () => {
  test("a notification SNS signed for the trusted topic verifies", async () => {
    await expect(verifySnsMessage(notification(), TOPIC, getKey)).resolves.toBeUndefined();
  });

  test("a subject, when SNS sent one, is part of what was signed", async () => {
    const message = notification({ Subject: "Amazon SES Email Event Notification" });
    expect(stringToSign(message)).toContain("Subject\nAmazon SES Email Event Notification\n");
    await expect(verifySnsMessage(message, TOPIC, getKey)).resolves.toBeUndefined();
    await expect(verifySnsMessage({ ...message, Subject: "changed" }, TOPIC, getKey)).rejects.toThrow(/does not verify/);
  });

  test("a changed message does not verify", async () => {
    const message = notification();
    const forged = { ...message, Message: message.Message.replace("Permanent", "Transient") };
    await expect(verifySnsMessage(forged, TOPIC, getKey)).rejects.toThrow(/does not verify/);
  });

  test("another topic is refused before anything is fetched", async () => {
    const other = notification({ TopicArn: "arn:aws:sns:us-east-1:111111111111:someone-else" });
    const never = async () => {
      throw new Error("fetched");
    };
    await expect(verifySnsMessage(other, TOPIC, never)).rejects.toThrow(/another topic/);
  });

  test("only signature version 2", async () => {
    await expect(verifySnsMessage({ ...notification(), SignatureVersion: "1" }, TOPIC, getKey)).rejects.toThrow(/version 2/);
  });

  test("the certificate must be on SNS's host for the topic's region", async () => {
    for (const url of [
      "http://sns.us-east-1.amazonaws.com/cert.pem",
      "https://sns.us-east-1.amazonaws.com.evil.test/cert.pem",
      "https://sns.eu-west-1.amazonaws.com/cert.pem",
      "https://evil.test/sns.us-east-1.amazonaws.com/cert.pem",
      "https://sns.us-east-1.amazonaws.com/cert.txt",
      "https://sns.us-east-1.amazonaws.com:8443/cert.pem",
    ]) {
      await expect(verifySnsMessage(notification({ SigningCertURL: url }), TOPIC, getKey), url).rejects.toThrow(
        /not on SNS's host/,
      );
    }
  });

  test("an unknown type is refused", async () => {
    await expect(verifySnsMessage({ ...notification(), Type: "Surprise" }, TOPIC, getKey)).rejects.toThrow(/Unknown/);
  });
});

describe("subscription confirmation", () => {
  const confirmation = (url: string) =>
    signed({
      Type: "SubscriptionConfirmation",
      MessageId: "sns-2",
      TopicArn: TOPIC,
      Message: "You have chosen to subscribe to the topic.",
      Timestamp: "2026-10-13T16:00:00.000Z",
      SubscribeURL: url,
      Token: "token-1",
    });

  test("the signed fields include the SubscribeURL and the token", async () => {
    const message = confirmation("https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=token-1");
    expect(stringToSign(message)).toMatch(/SubscribeURL\nhttps:\/\/sns\.us-east-1\.amazonaws\.com\/.*\nTimestamp\n.*\nToken\ntoken-1\n/);
    await expect(verifySnsMessage(message, TOPIC, getKey)).resolves.toBeUndefined();
  });

  test("is followed only on SNS's host", async () => {
    const visited: string[] = [];
    const get = async (url: string) => {
      visited.push(url);
      return { ok: true, status: 200 };
    };
    const good = "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=token-1";
    expect(await confirmSubscription(confirmation(good), get)).toBe(true);
    await expect(confirmSubscription(confirmation("https://evil.test/?Action=ConfirmSubscription"), get)).rejects.toThrow(
      /SubscribeURL/,
    );
    expect(visited).toEqual([good]);
  });
});

describe("sesEventFromNotification", () => {
  test("a hard bounce carries its type and the server's diagnostic", () => {
    expect(sesEventFromNotification(sesBounce)).toEqual({
      messageId: "0100018b-ses-message",
      type: "bounce",
      bounceType: "Permanent",
      reason: "smtp; 550 5.1.1 user unknown",
    });
  });

  test("each kind the outbox acts on, and nothing else", () => {
    const of = (eventType: string, extra: object = {}) =>
      sesEventFromNotification(JSON.stringify({ eventType, mail: { messageId: "m" }, ...extra }));
    expect(of("Delivery")).toEqual({ messageId: "m", type: "delivery" });
    expect(of("Reject", { reject: { reason: "Bad content" } })).toMatchObject({ type: "reject", reason: "Bad content" });
    expect(of("Complaint", { complaint: { complaintFeedbackType: "abuse" } })).toMatchObject({ type: "complaint" });
    expect(of("Rendering Failure", { failure: { errorMessage: "x" } })).toMatchObject({ type: "rendering_failure" });
    expect(of("DeliveryDelay", { deliveryDelay: { delayType: "MailboxFull" } })).toMatchObject({ type: "delay" });
    expect(of("Send")).toBeNull();
    expect(of("Open")).toBeNull();
    expect(sesEventFromNotification("not json")).toBeNull();
    expect(sesEventFromNotification(JSON.stringify({ eventType: "Delivery" }))).toBeNull();
  });
});

describe("parseSnsMessage and isSnsUrl", () => {
  test("a body missing a signed field is not a message", () => {
    expect(() => parseSnsMessage("{}")).toThrow(/no Type/);
    expect(() => parseSnsMessage("nope")).toThrow(/not JSON/);
  });

  test("SNS's host, exactly", () => {
    expect(isSnsUrl(CERT_URL, "us-east-1", { pem: true })).toBe(true);
    expect(isSnsUrl("https://user@sns.us-east-1.amazonaws.com/a.pem", "us-east-1", { pem: true })).toBe(false);
  });
});

describe("POST /api/webhooks/ses", () => {
  afterEach(() => {
    delete process.env.HEALDESK_SES_EVENTS_TOPIC_ARN;
  });

  const post = (body: string) => POST(new Request("https://app.healdesk.test/api/webhooks/ses", { method: "POST", body }));

  test("answers 503 where no topic is trusted", async () => {
    delete process.env.HEALDESK_SES_EVENTS_TOPIC_ARN;
    expect((await post(JSON.stringify(notification()))).status).toBe(503);
  });

  test("answers 400 to a body that is not an SNS message, and 403 to another topic", async () => {
    process.env.HEALDESK_SES_EVENTS_TOPIC_ARN = TOPIC;
    expect((await post("hello")).status).toBe(400);
    const other = notification({ TopicArn: "arn:aws:sns:us-east-1:111111111111:someone-else" });
    expect((await post(JSON.stringify(other))).status).toBe(403);
  });
});
