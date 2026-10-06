import {
  MailFormatError,
  normaliseRecipient,
  type DeliveryResult,
  type DeliveryTarget,
  type EmailAttachment,
  type EmailTransport,
  type OutgoingEmail,
} from "./deliver";

/**
 * Resend, for mail that carries no patient information — and for nothing else.
 *
 * Until this file existed, healdesk had never sent an email. HEALDESK_EMAIL_TRANSPORT
 * was unset, @aws-sdk/client-sesv2 was installed nowhere, and every send path
 * ended at the console stub. The invitation the checkout screen promised, the
 * connect link, the monthly report and the counterparty's copy of a signed
 * business associate agreement all did not go out. This is the transport that
 * ends that, because it needs an API key and a verified domain rather than an
 * AWS account, a SES production-access review and a DKIM round trip.
 *
 * ## Why a vendor that will not sign a BAA is nonetheless allowed here
 *
 * Resend states plainly that it is not HIPAA compliant and does not sign
 * business associate agreements (https://resend.com/security/gdpr). That is not
 * disqualifying, and the reason is worth stating precisely, because "our email
 * vendor won't sign a BAA" is exactly the sentence that later gets quoted back
 * at us.
 *
 * healdesk's own promise, in packages/catalog/src/baa.ts, binds PROTECTED
 * HEALTH INFORMATION: it will not transmit PHI over a channel that cannot
 * negotiate encryption, and where a message cannot be delivered securely it
 * fails the delivery and tells the clinic rather than sending in the clear. It
 * does not promise that every byte of every email travels under a BAA. None of
 * today's four messages carries PHI — the agreement copy is a contract between
 * us and the clinic, the invitation and the connect link carry links, and the
 * monthly report is counts and totals with assertNoPhiInReport standing over
 * it. So Resend may carry all of them.
 *
 * The danger is not that this is wrong today. It is that it stays true only by
 * convention — someone adds a message, nobody asks the question, and the
 * promise quietly stops being true with no code change to point at. So the
 * question is asked of every message, by the type system and again here at
 * runtime: `phiClass` is a required field on OutgoingEmail, and this transport
 * refuses anything not classed "none".
 *
 * ## Why the refusal lives in the transport and not only in the router
 *
 * getTransport() already refuses to hand a may-carry-phi message to Resend. That
 * guard covers the configured path and nothing else: agreement-copy.ts takes an
 * injected transport, tests construct one directly, and the next caller may do
 * the same. A rule enforced only by the factory is a rule that a `new
 * ResendTransport()` walks around. Both are cheap; the one that cannot be
 * bypassed belongs where the send happens.
 *
 * What Resend cannot do is the second half of the sentence. SES has
 * `TlsPolicy: REQUIRE` on a configuration set — a per-message, verifiable
 * instruction to fail the delivery rather than downgrade to plaintext, which
 * SesTransport reads back from the API before it will send. Resend exposes no
 * equivalent control, so there is no way to make a PHI-bearing message fail
 * closed on it. Not "we would rather not"; there is no setting.
 *
 * ## Attachments are bytes, never a path
 *
 * Resend's Attachment accepts either `content` or `path`, and `path` is a URL
 * it fetches. Using it would mean hosting a signed business associate agreement
 * somewhere fetchable, at an address that has to be either public or
 * authenticated — the exact artefact agreement-copy.ts refused to create when
 * it chose to mail a file instead of a link. `content` only.
 */

/**
 * Refusal to route a message to a transport that must not carry it.
 *
 * A distinct class, and thrown rather than returned as `{ status: "failed" }`,
 * because it is not a delivery failure. A failed result is an ordinary fact
 * about one message — a bad address, a rejected payload — that callers record
 * and operators retry. This is a routing bug, and retrying it would produce the
 * same refusal for as long as the code is wrong. It should read like a crash,
 * because it is one.
 */
export class PhiRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhiRoutingError";
  }
}

/**
 * A message this transport cannot frame.
 *
 * A fact about ONE message — an unusable value in it — rather than a fault in
 * the deployment, which is the split that decides whether it is reported as a
 * failed result or thrown. Subclassed so the attachment cases keep their own
 * name in a log while both are caught by one clause.
 */
class ResendMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResendMessageError";
  }
}

/** A file this transport cannot frame — sized, empty or unusably named. */
class ResendAttachmentError extends ResendMessageError {
  constructor(message: string) {
    super(message);
    this.name = "ResendAttachmentError";
  }
}

/**
 * The two caller-supplied values that become mail HEADERS inside Resend.
 *
 * Same argument the attachment check below makes, applied to the fields that
 * actually carry a stranger's typing. `subject` is the important one: for the
 * agreement copy it is built by interpolating `clinicLegalName` — 200
 * characters straight off the self-serve checkout form, length-checked at
 * signature and never checked for line breaks — into a sentence that Resend
 * then writes into a `Subject:` header, using code we cannot read.
 *
 * That value was refused before this transport existed. The agreement copy
 * carries an attachment, so it took SES's raw-MIME path, where
 * `encodeHeaderValue` calls `assertNoHeaderBreak` and the message is refused
 * rather than sent. Resend has no such path, so without this check the SAME
 * message is refused by one transport and accepted by the other — and the one
 * that accepts it is the one that actually sends today, on the highest-stakes
 * message this system has.
 *
 * `from` is deliberately not here: it is operator-configured, not caller-
 * supplied, and has an operator who can be told to correct it — the same
 * asymmetry assertSendableFrom() sets out in deliver.ts.
 */
function assertHeaderSafe(to: string, subject: string): void {
  for (const [field, value] of [
    ["recipient address", to],
    ["subject", subject],
  ] as const) {
    if (/[\r\n\0]/.test(value)) {
      throw new ResendMessageError(
        `Refusing to send: the ${field} contains a line break or null byte, ` +
          `which in a mail header means an injected header rather than a value.`,
      );
    }
  }
}

/**
 * The recipient in the form that will actually be transmitted.
 *
 * The line-break check above says what the address may not CONTAIN. This says
 * what it must BE, and it is the half that was missing: `normaliseRecipient` is
 * a converter as much as a validator, and the SES path transmits its return
 * value rather than the typed one — an internationalised domain leaves here as
 * its A-label, `klinik-münchen.test` as `xn--klinik-mnchen-3ob.test`.
 *
 * Leaving that conversion to Resend was the wrong side of an unknown. What is
 * known is that this codebase already accepted such an address, on the promise
 * that the mail layer could send it: `isSendableAddress` — the same function,
 * exported for exactly this — is what `agreements.ts` calls `isEmail`, and it
 * returns true for a non-ASCII domain ONLY because it punycodes one. So the
 * signature-time question and the send-time behaviour had drifted apart, which
 * is the precise failure that function's docblock says it exists to prevent.
 * The address goes onto an append-only legal record, and the earliest anyone
 * would find out is a copy that did not arrive.
 *
 * What is NOT known is what Resend does with a raw 8-bit domain, and this is
 * not the place to guess: converting it here means the answer no longer
 * matters. An address that cannot be converted is refused with a reason an
 * operator can act on, in place of whatever the API would have said — and both
 * transports now refuse and accept the same addresses, which is worth more than
 * either rule on its own.
 */
function sendableRecipient(to: string): string {
  try {
    return normaliseRecipient(to);
  } catch (error) {
    // Re-clothed, not re-worded: the sentence normaliseRecipient wrote is the
    // useful one, and it deliberately never echoes the address. The class is
    // changed so the one catch below reports it as a fact about this message.
    if (error instanceof MailFormatError) {
      throw new ResendMessageError(error.message);
    }
    throw error;
  }
}

/**
 * Resend rejects an email over 40 MB, counted after base64 has inflated the
 * bytes by a third.
 *
 * Checked here rather than left to the API for the reason the raw-MIME path in
 * deliver.ts checks its own ceiling: the API's rejection is opaque and arrives
 * after the whole payload has been encoded and uploaded, and the operator
 * reading the ops console needs a sentence they can act on. An agreement PDF is
 * a few hundred kilobytes, so anything near this is a bug upstream.
 */
export const RESEND_MAX_ENCODED_BYTES = 40 * 1024 * 1024;

/**
 * How long a caller may be made to wait.
 *
 * The Resend SDK builds its request options from `{ query, headers }` and gives
 * no timeout or AbortSignal, and `fetch` has no default deadline — a socket that
 * connects and then goes quiet blocks until the OS gives up. That is survivable
 * for the monthly report, which runs in a job. It is not survivable for the BAA
 * copy, which is sent from inside the signing request: an unbounded wait there
 * turns a signature already committed to an append-only table into a 5xx at the
 * marketing site, and the buyer's obvious response is to sign again.
 *
 * This bounds the WAIT, not the request — nothing here can cancel a POST that
 * Resend has already accepted, so a message that times out may still be
 * delivered. That trade is deliberate and it only runs one way: the caller
 * records a failure, the ops console shows the copy as missing, and an operator
 * resends. A duplicate copy of a contract is a nuisance; two acceptance rows
 * for one act of assent is a mess in the one record we most need to be able to
 * testify about.
 *
 * Ten seconds rather than SES's five, because this request carries the PDF in
 * its body instead of streaming to a nearer AWS endpoint.
 */
const RESEND_REQUEST_TIMEOUT_MS = 10_000;

export class ResendTransport implements EmailTransport {
  readonly name = "resend";

  async send(
    target: DeliveryTarget,
    message: OutgoingEmail,
  ): Promise<DeliveryResult> {
    assertNoPhi(message);

    // After the class gate, never before it. A refusal that depended on
    // configuration would be a refusal that a missing environment variable
    // could turn into a different error message on a different day.
    const apiKey = required(
      "RESEND_API_KEY",
      "Create one at https://resend.com/api-keys with sending permission on " +
        "the verified domain, and set it wherever HEALDESK_EMAIL_TRANSPORT=resend.",
    );
    const from = required(
      "HEALDESK_EMAIL_FROM",
      'An address on a domain verified in Resend. "healdesk <hello@healdesk.io>" is fine.',
    );

    let attachments: ResendAttachment[];
    let to: string;
    try {
      assertHeaderSafe(target.to, message.subject);
      to = sendableRecipient(target.to);
      attachments = encodeAttachments(message.attachments ?? []);
    } catch (error) {
      // An unusable header value, or a file too large, empty or unusably named,
      // is a fact about this one message rather than a misconfiguration, so it
      // is reported and the rest of a batch carries on — the same split
      // SesTransport makes.
      if (error instanceof ResendMessageError) {
        return { status: "failed", reason: error.message };
      }
      throw error;
    }

    const resend = await client(apiKey);

    let response: Awaited<ReturnType<typeof resend.emails.send>>;
    try {
      response = await withTimeout(
        resend.emails.send({
          from,
          // The transmitted form, not the typed one — trimmed, checked for a
          // line break, and with an internationalised domain already converted
          // to its A-label. See sendableRecipient() for why that conversion
          // happens here rather than being left to the API.
          to,
          subject: message.subject,
          text: message.text,
          // Omitted rather than sent empty: an empty text/html alternative is
          // rendered as a blank message by the clients that prefer HTML, which
          // is how a report becomes "healdesk sent me nothing".
          ...(message.html ? { html: message.html } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
        RESEND_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      // The SDK turns a network failure into an error VALUE and does not throw,
      // so this catches the timeout above and anything genuinely unexpected.
      return {
        status: "failed",
        reason:
          error instanceof Error ? error.message : "Resend request failed.",
      };
    }

    /**
     * The whole reason this transport is not a three-line wrapper.
     *
     * `resend.emails.send` resolves for a rejected message exactly as it does
     * for an accepted one: errors come back as `{ data: null, error }`, not as
     * throws. A transport that only try/catches around it therefore reports
     * "sent" on every single failure — a bad key, an unverified domain, a
     * rejected address — and the scheduler logs a month of deliveries that
     * never happened. Check the value.
     */
    if (response.error) {
      return {
        status: "failed",
        reason: `Resend refused the message (${response.error.name}): ${response.error.message}`,
      };
    }

    if (!response.data?.id) {
      // Neither an error nor an id. Nothing can be said about this message
      // afterwards, so it is not called sent.
      return {
        status: "failed",
        reason:
          "Resend returned neither an error nor a message id; the outcome of " +
          "this send is unknown, so it is not recorded as delivered.",
      };
    }

    return { status: "sent", messageId: response.data.id };
  }
}

/**
 * The class gate.
 *
 * Written as "anything that is not exactly 'none'" rather than "is
 * may-carry-phi", so that a value the type system never anticipated — undefined
 * from a JavaScript caller, a string from a JSON payload, a class added later —
 * lands on the refusing side. Fail closed: the default is the safety property,
 * not a convenience.
 */
function assertNoPhi(message: OutgoingEmail): void {
  if (message.phiClass === "none") return;

  // The type says this field is required; the runtime is what enforces it.
  const declared: string = message.phiClass ?? "undeclared";

  throw new PhiRoutingError(
    `Refusing to send: this message is classed "${declared}" and the Resend ` +
      `transport carries only "none". Resend states it is not HIPAA compliant ` +
      `and does not sign a business associate agreement ` +
      `(https://resend.com/security/gdpr), and it offers no equivalent of SES's ` +
      `TlsPolicy=REQUIRE — so it cannot be made to fail the delivery when a ` +
      `receiving server declines TLS, which is what healdesk's own agreement ` +
      `promises it will do. Send anything that may carry patient information ` +
      `with HEALDESK_EMAIL_TRANSPORT=ses.`,
  );
}

/**
 * What Resend is handed for each file.
 *
 * `content` is base64 and `path` is deliberately absent — see the note at the
 * top of this file about what a fetchable URL for a signed agreement would mean.
 */
type ResendAttachment = {
  filename: string;
  contentType: string;
  content: string;
};

function encodeAttachments(attachments: EmailAttachment[]): ResendAttachment[] {
  if (attachments.length === 0) return [];

  /**
   * Estimated before encoding, not measured after.
   *
   * Reaching the ceiling with a base64 string in hand means having already
   * allocated a third more memory than an attachment that was too big in the
   * first place. For a mistakenly-attached video that is an out-of-memory crash
   * instead of an error message.
   */
  const encoded = attachments.reduce(
    (total, a) => total + Math.ceil(a.content.byteLength / 3) * 4,
    0,
  );
  if (encoded > RESEND_MAX_ENCODED_BYTES) {
    throw new ResendAttachmentError(
      `Refusing to send: the attachments come to roughly ${encoded} bytes once ` +
        `base64 has added a third to them, over Resend's ${RESEND_MAX_ENCODED_BYTES}-byte ` +
        `limit for an email. The limit covers the whole message, so a payload ` +
        `that only just fits here may still be refused by the API.`,
    );
  }

  return attachments.map((attachment) => {
    if (attachment.content.byteLength === 0) {
      throw new ResendAttachmentError(
        `Refusing to send: attachment "${attachment.filename}" is empty. A ` +
          `message announcing a document with nothing attached is worse than one ` +
          `that never arrived, because the recipient is left believing they hold ` +
          `a copy.`,
      );
    }

    /**
     * We do not assemble these headers — and that is the reason to check rather
     * than the reason not to. Both values reach Content-Type and
     * Content-Disposition headers built inside Resend, by code we cannot read,
     * so what a line break does there is unknown. Neither is ever legitimately
     * multi-line, and refusing costs nothing. The SES path refuses the same two
     * for a reason it can see: there, we write the header ourselves.
     */
    if (
      /[\r\n\0]/.test(attachment.filename) ||
      /[\r\n\0]/.test(attachment.contentType)
    ) {
      throw new ResendAttachmentError(
        "Refusing to send: an attachment's filename or content type contains " +
          "a line break or null byte, which in a mail header means an injected " +
          "header rather than a value.",
      );
    }

    return {
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: Buffer.from(attachment.content).toString("base64"),
    };
  });
}

/**
 * Required configuration, refused loudly.
 *
 * Throws rather than returning a failed result, and follows the precedent in
 * lib/env.ts and lib/gate.ts by naming the variable and what to put in it: an
 * unset key is not a fact about this message, it is a deployment that cannot
 * send any message, and every send will fail identically until someone acts.
 * Deliberately not env.ts's `required()`, which warns and returns "" outside
 * production — that fallback would hand Resend an empty API key and turn a
 * configuration error into a 401 per message.
 */
function required(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  throw new Error(`${name} is not set. ${hint}`);
}

/**
 * The SDK, imported lazily and the client memoised.
 *
 * Same shape as the SES client and crypto/kms.ts. `resend` is a dependency of
 * this app and is bundled, so unlike the AWS SDKs, which are external and must
 * be in node_modules at run time, this import cannot fail — the laziness is
 * only to keep the mail SDK out of every bundle that touches deliver.ts, which
 * by now is most of the console.
 *
 * Keyed by API key for the same reason the TLS memo is keyed by configuration
 * set name: a rotated key must not be answered from a memo about the previous
 * one.
 */
type ResendClient = InstanceType<(typeof import("resend"))["Resend"]>;

let cached: { key: string; client: ResendClient } | undefined;

async function client(apiKey: string): Promise<ResendClient> {
  if (cached && cached.key === apiKey) return cached.client;

  const { Resend } = await import("resend");
  const instance = new Resend(apiKey);
  cached = { key: apiKey, client: instance };
  return instance;
}

/**
 * Bound the wait on a promise that has no deadline of its own.
 *
 * The timer is cleared however the race ends, so nothing here holds the event
 * loop open after the send resolves — which matters in a worker that is
 * expected to exit.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Resend did not respond within ${ms}ms. The message may still ` +
                  `have been sent — nothing here can cancel a request the API ` +
                  `has already accepted — so it is reported as failed and needs ` +
                  `a person to decide whether to resend.`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
