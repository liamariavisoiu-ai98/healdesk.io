import { smsOriginationIdentity } from "./config";

/**
 * The one text healdesk ever sends, and the adapter that sends it (owner,
 * 28 and 30 October 2026; spec, "Payment by text after a call, and full
 * payment"; CLAUDE.md, "Inbound only").
 *
 * The sender is AWS End User Messaging SMS (the SMS and voice v2 API, listed
 * by AWS as HIPAA eligible under "Amazon Pinpoint and End User Messaging"),
 * in healdesk's HIPAA account, from the one toll-free number healdesk
 * registered for itself (lib/sms/config.ts). The words are fixed here, in
 * paymentLinkTextBody, and nowhere else, so the sample in the carrier
 * registration can be matched to the code: a sender name, the clinic's own
 * hosted checkout link, that nobody reads replies, and the opt-out line. No
 * treatment, time, amount or clinic name: the checkout page shows the
 * amount, and the text carries nothing a caller said.
 *
 * STOP and HELP are AWS's and the carrier's: a number that replied STOP is
 * on the account's opt-out list, and AWS refuses to text it again, which
 * this adapter reports as `opted_out`. Nobody answers replies.
 *
 * The client is loaded lazily, by a literal specifier, outside any `try`,
 * and the package is a runtime dependency external to the Next build, as the
 * KMS and SES clients are (tests/aws-sdk-clients.test.ts,
 * tests/aws-sdk-externals.test.ts). Tests pass their own transport.
 *
 * Nothing here is logged with the number or the body; only the outcome's
 * code and AWS's message id leave this module.
 */

/**
 * The words of the text, `{link}` standing for the clinic's checkout link.
 * The ONE place they are written: the carrier registration's sample is this.
 */
export const PAYMENT_LINK_TEXT_TEMPLATE =
  "Healdesk: your secure link to pay your booking deposit: {link}. We don't read replies. Msg&data rates may apply. Reply STOP to opt out, HELP for help.";

/** The text, with the link. Refuses anything but an https link (as depositLinkText does). */
export function paymentLinkTextBody(url: string): string {
  if (!/^https:\/\/[^\s{}]+$/.test(url)) {
    throw new Error("paymentLinkTextBody takes the https link the payment gateway returned.");
  }
  return PAYMENT_LINK_TEXT_TEMPLATE.replace("{link}", () => url);
}

/** What came of one send. */
export type SmsSendResult =
  | { status: "sent"; messageId: string }
  | {
      status: "failed";
      /**
       * `opted_out`: the number replied STOP, and AWS will not text it.
       * `invalid_number`: AWS refused the number (not a mobile, malformed).
       * `throttled`: a rate or spending limit.
       * `not_configured`: healdesk's number is not set (never sent).
       * `error`: anything else, the network included.
       */
      code: "opted_out" | "invalid_number" | "throttled" | "not_configured" | "error";
    };

/** One message to AWS, as SendTextMessage takes it. */
export type SmsRequest = {
  DestinationPhoneNumber: string;
  OriginationIdentity: string;
  MessageBody: string;
  MessageType: "TRANSACTIONAL";
};

/**
 * How a send reaches AWS: the SDK in production, a fake in tests. Returns
 * AWS's message id. `signal` aborts the request when our own deadline passes.
 */
export type SmsTransport = (request: SmsRequest, signal?: AbortSignal) => Promise<{ MessageId?: string | undefined }>;

/**
 * ONE attempt, never an automatic retry. SendTextMessage takes no
 * idempotency token, so a retry after a lost response (the text sent, the
 * answer not received) would text the caller twice. The once-per-booking
 * ledger row (lib/sms/payment-text.ts) is the only guard against a second
 * send, and the SDK must not add one of its own.
 */
const SMS_MAX_ATTEMPTS = 1;
const SMS_CONNECT_TIMEOUT_MS = 1_500;
const SMS_REQUEST_TIMEOUT_MS = 4_000;
/**
 * Our own deadline over the whole send, the SDK's load included: a caller
 * is waiting on the line, so past it the send is given up as `error`, never
 * resent, and the deposit goes to the front desk.
 */
export const SMS_SEND_DEADLINE_MS = 4_500;

/** The client's bounds: a caller is waiting on the line. */
export function smsClientConfig() {
  return {
    region: process.env.AWS_REGION || "us-east-1",
    maxAttempts: SMS_MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: SMS_CONNECT_TIMEOUT_MS,
      requestTimeout: SMS_REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  };
}

let cached: SmsTransport | undefined;

/**
 * The production transport: AWS End User Messaging SMS, loaded on first use.
 * Module-private on purpose: it would send any body, so the only way to it
 * is sendPaymentLinkText, which hands it the fixed words alone
 * (tests/safety-suite.test.ts holds every other file away from the SDK).
 */
async function awsSmsTransport(): Promise<SmsTransport> {
  if (cached) return cached;
  // A literal specifier, outside any `try` (see the header).
  const mod = await import("@aws-sdk/client-pinpoint-sms-voice-v2").catch((error: unknown) => {
    throw new Error(
      "@aws-sdk/client-pinpoint-sms-voice-v2 could not be loaded. It is a dependency of @healdesk/app and " +
        "external to the Next build, so it is required from node_modules at run time: the install is incomplete.",
      { cause: error },
    );
  });
  const client = new mod.PinpointSMSVoiceV2Client(smsClientConfig());
  cached = async (request, signal) =>
    client.send(new mod.SendTextMessageCommand(request), signal ? { abortSignal: signal } : {});
  return cached;
}

/** AWS's refusal, as one of our codes. Reads the error's name and Reason only, never its message. */
export function smsFailureCode(error: unknown): Extract<SmsSendResult, { status: "failed" }>["code"] {
  const named = error as { name?: unknown; Reason?: unknown } | null;
  const name = typeof named?.name === "string" ? named.name : "";
  const reason = typeof named?.Reason === "string" ? named.Reason : "";
  if (reason === "DESTINATION_PHONE_NUMBER_OPTED_OUT") return "opted_out";
  if (name === "ThrottlingException" || name === "ServiceQuotaExceededException") return "throttled";
  if (name === "ValidationException" && /PHONE|DESTINATION|COUNTRY/.test(reason)) return "invalid_number";
  return "error";
}

/**
 * Send the payment-link text once. Never throws: every failure is a code.
 * The caller has already passed the contact policy (canSendPaymentLinkText)
 * and holds the ledger row that makes this the only send for the booking.
 */
export async function sendPaymentLinkText(input: {
  to: string;
  url: string;
  transport?: SmsTransport;
  env?: Readonly<Record<string, string | undefined>>;
  /** Our deadline; SMS_SEND_DEADLINE_MS unless a test passes a shorter one. */
  deadlineMs?: number;
}): Promise<SmsSendResult> {
  const origin = smsOriginationIdentity(input.env);
  if (!origin) return { status: "failed", code: "not_configured" };
  if (!/^\+[1-9]\d{6,14}$/.test(input.to)) return { status: "failed", code: "invalid_number" };
  const body = paymentLinkTextBody(input.url);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(Object.assign(new Error("payment-link text deadline passed"), { name: "TimeoutError" }));
    }, input.deadlineMs ?? SMS_SEND_DEADLINE_MS);
  });
  try {
    const send = (async () => {
      const transport = input.transport ?? (await awsSmsTransport());
      return transport(
        { DestinationPhoneNumber: input.to, OriginationIdentity: origin, MessageBody: body, MessageType: "TRANSACTIONAL" },
        abort.signal,
      );
    })();
    // A late answer after the deadline is dropped; the attempt is never repeated.
    send.catch(() => undefined);
    const reply = await Promise.race([send, deadline]);
    if (!reply.MessageId) return { status: "failed", code: "error" };
    return { status: "sent", messageId: reply.MessageId };
  } catch (error) {
    return { status: "failed", code: smsFailureCode(error) };
  } finally {
    clearTimeout(timer);
  }
}
