import { randomBytes } from "node:crypto";
import { domainToASCII } from "node:url";

import { env } from "@/lib/env";

import type { RenderedReport } from "./render";
import { PhiRoutingError, ResendTransport } from "./resend-transport";

/**
 * Email delivery, behind a port.
 *
 * SES doesn't exist yet — it needs an AWS account, a verified sending domain,
 * and DKIM. Waiting for that would block the renderer, the scheduler and the
 * report shape from being built and tested, so delivery goes through this
 * boundary instead.
 *
 * The stub is deliberately loud in production. A silent no-op that lets a
 * scheduler report "sent 40 reports" while sending none is worse than a crash,
 * because it looks like success for a month.
 *
 * ## Why SES specifically
 *
 * Amazon SES is on the HIPAA Eligible Services list and is covered by the
 * standard AWS BAA — the same one that already covers RDS, KMS and S3. The
 * alternatives are worse: Twilio explicitly refuses to sign a BAA for SendGrid,
 * and Postmark states outright that it cannot sign one.
 *
 * That said, the reason this is comfortable is not the BAA — it is that the
 * payload carries no PHI at all (see render.ts). The BAA is the second line.
 *
 * ## Why this port now carries attachments
 *
 * The counterparty to a business associate agreement could not obtain a copy of
 * it. Nothing was mailed, nothing was downloadable — healdesk held the only
 * copy of a contract with two parties to it. Fixing that means the mail layer
 * has to be able to carry a file, and there is exactly one mail layer here on
 * purpose (see the note in email/connect-link.ts): a second sending path with
 * its own settings is how the BAA's promise about encrypted transmission
 * quietly stops being true.
 *
 * So attachments are added HERE, optional, rather than by giving the agreement
 * email a mailer of its own.
 *
 * ## And why there is now a second transport after all
 *
 * The paragraphs above were written while nothing had ever been sent, and they
 * were still true of the deployment: HEALDESK_EMAIL_TRANSPORT was unset,
 * @aws-sdk/client-sesv2 was installed nowhere, and SES needs an account, a
 * verified domain, DKIM and a production-access review before the first message
 * moves. Resend needs an API key. So Resend carries the mail today (see
 * resend-transport.ts), and SES stays exactly as it is.
 *
 * That is a second sending path, which the note above says is how the BAA's
 * promise quietly stops being true — so the thing that stops it happening is
 * built in rather than promised. Every message declares a `phiClass`; the
 * declaration decides the wire; and Resend, which signs no BAA and offers no
 * TlsPolicy=REQUIRE, refuses anything not classed "none". The choice is made by
 * the routing rule above getTransport(), never by which transport happens to be
 * configured on the box.
 */

export type DeliveryTarget = {
  /** Business contact address. May be a shared inbox — the email has no PHI. */
  to: string;
  clinicId: string;
  clinicName: string;
};

/**
 * A file to be carried alongside the message.
 *
 * `content` is the raw bytes; this layer owns the base64 and the MIME framing,
 * because a caller that hand-rolls either one will eventually get it subtly
 * wrong in a way that only shows up in one mail client.
 */
export type EmailAttachment = {
  /**
   * Suggested filename. Sanitised to a conservative ASCII subset before it
   * reaches a header — see safeFilename().
   */
  filename: string;
  /** e.g. "application/pdf". Validated as a MIME type; anything else is refused. */
  contentType: string;
  content: Uint8Array;
};

/**
 * Whether this message may contain protected health information.
 *
 * The one field on an outgoing message that decides which wire it goes down.
 * See the routing rule above getTransport().
 */
export type PhiClass =
  /**
   * Carries no PHI at all: a contract, a link, or aggregate counts. May travel
   * over a transport with no business associate agreement behind it.
   */
  | "none"
  /**
   * May carry PHI. Requires a transport that can be instructed to enforce TLS
   * and to fail the delivery rather than downgrade — today that means SES with
   * a configuration set whose TlsPolicy is REQUIRE, and nothing else.
   */
  | "may-carry-phi";

/**
 * What a transport is asked to send.
 *
 * Deliberately a widening of RenderedReport rather than a change to it: the
 * report renderer stays a module that knows nothing about attachments or
 * routing.
 *
 * `phiClass` is REQUIRED, and that is the entire point of it. As an optional
 * field defaulting to "none" it would cost nothing to add and would protect
 * nothing: the next message would be written without it, compile, and be
 * classified by omission — which is the precise failure this exists to prevent.
 * Required means every call site has had to answer the question out loud, and a
 * new one cannot be written without answering it.
 */
export type OutgoingEmail = RenderedReport & {
  attachments?: EmailAttachment[];
  phiClass: PhiClass;
};

export type DeliveryResult =
  | { status: "sent"; messageId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export interface EmailTransport {
  readonly name: string;
  send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult>;
}

/**
 * Development transport: writes to the log and reports honestly that nothing
 * was sent. Refuses to be used in production.
 */
export class ConsoleTransport implements EmailTransport {
  readonly name = "console";

  async send(
    target: DeliveryTarget,
    message: OutgoingEmail,
  ): Promise<DeliveryResult> {
    if (env.isProduction()) {
      throw new Error(
        "ConsoleTransport must never run in production. Set " +
          "HEALDESK_EMAIL_TRANSPORT to resend or, for anything that may carry " +
          "patient information, ses.",
      );
    }

    // Name, type and size — never the bytes. A base64 blob in a log is both
    // useless to read and, for anything document-shaped, a copy of the document
    // in a place with none of the document's access controls. The size is the
    // part that actually answers the question you have in development, which is
    // "did the attachment get built at all, or is it empty?".
    const attachments = message.attachments ?? [];
    const files = attachments.length
      ? ` + ${attachments
          .map((a) => `${a.filename} (${a.contentType}, ${a.content.byteLength} bytes)`)
          .join(", ")}`
      : "";

    console.info(
      `[healdesk] would send to ${target.to}: ${message.subject}${files}`,
    );
    return {
      status: "skipped",
      reason: attachments.length
        ? `No email transport configured; nothing was sent (${attachments.length} attachment(s) were built).`
        : "No email transport configured; nothing was sent.",
    };
  }
}

/**
 * AWS SES.
 *
 * Two things are non-negotiable:
 *
 *   1. A configuration set with `TlsPolicy: Require`, so delivery fails rather
 *      than silently downgrading to plaintext. Opportunistic TLS is not a
 *      safeguard, it is a hope.
 *   2. Bounce and complaint handling wired to suppression. A clinic whose
 *      address hard-bounces must stop being mailed, and a spam complaint must
 *      be treated as a stop request. (Still outstanding — see the Phase 8
 *      checklist.)
 *
 * ## Simple content, or raw MIME
 *
 * SES's `Content.Simple` form cannot carry a file, so a message with an
 * attachment is assembled as raw MIME instead (`Content.Raw`). The branch is
 * ONLY over the shape of `Content`: the configuration set is resolved and the
 * TLS policy is verified above it, on the single path both forms take, and
 * there is one `SendEmailCommand` at the bottom. That structure is the point —
 * an attachment path that returned early, or built its own command, is exactly
 * how a guard gets bypassed by a later edit that never meant to bypass it.
 *
 * It matters more here than anywhere else in the system, because the first
 * thing this attachment path is used for is mailing the business associate
 * agreement — a document that itself contains the promise about encrypted
 * transmission. Sending that one over opportunistic TLS would be self-refuting.
 */
export class SesTransport implements EmailTransport {
  readonly name = "ses";

  async send(
    target: DeliveryTarget,
    message: OutgoingEmail,
  ): Promise<DeliveryResult> {
    const configurationSet = process.env.HEALDESK_SES_CONFIGURATION_SET;
    if (!configurationSet) {
      // Refuse rather than send without one. Sending with no configuration set
      // is exactly the opportunistic-TLS default the BAA now promises we will
      // not do.
      throw new Error(
        "HEALDESK_SES_CONFIGURATION_SET is not set. healdesk will not send " +
          "without a configuration set, because SES defaults to opportunistic " +
          "TLS and would deliver in cleartext to any server that declines to " +
          "negotiate. Create one with TlsPolicy=REQUIRE:\n" +
          "  aws sesv2 put-configuration-set-delivery-options \\\n" +
          "    --configuration-set-name healdesk-phi --tls-policy REQUIRE",
      );
    }

    const ses = await client();
    await this.#assertTlsRequired(ses, configurationSet);

    const from = process.env.HEALDESK_EMAIL_FROM;
    if (!from) throw new Error("HEALDESK_EMAIL_FROM is not set.");

    /**
     * The recipient in the form that will actually be transmitted, resolved
     * once and above the Simple/Raw branch.
     *
     * `Destination` is the envelope SES routes on; `To:` is the header the
     * recipient reads. Normalising an internationalised domain in only one of
     * them would let a message be routed on one spelling of an address and
     * display another, and the Simple form has no header of its own to be kept
     * in step — which is why this cannot live inside buildRawMessage alone.
     *
     * Reported rather than thrown, for the reason the raw path below gives: an
     * address that cannot be sent to is a fact about this one message, and the
     * rest of a monthly-report batch should carry on without it.
     */
    let to: string;
    try {
      to = normaliseRecipient(target.to);
    } catch (error) {
      return {
        status: "failed",
        reason:
          error instanceof Error ? error.message : "Unusable recipient address",
      };
    }

    const attachments = message.attachments ?? [];

    let content: unknown;
    if (attachments.length === 0) {
      content = {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: message.text, Charset: "UTF-8" },
            ...(message.html
              ? { Html: { Data: message.html, Charset: "UTF-8" } }
              : {}),
          },
        },
      };
    } else {
      let raw: Uint8Array;
      try {
        raw = buildRawMessage({
          from,
          to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          attachments,
        });
      } catch (error) {
        // A malformed address, an unusable filename or an oversized attachment
        // is a fact about this one message, not a misconfiguration, so it is
        // reported rather than thrown: the caller records it and the rest of
        // the batch carries on.
        return {
          status: "failed",
          reason:
            error instanceof Error ? error.message : "Could not build message",
        };
      }

      content = { Raw: { Data: raw } };
    }

    const sent = await ses.send(
      new ses.SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        ConfigurationSetName: configurationSet,
        Content: content,
      }),
    );

    return { status: "sent", messageId: sent.MessageId ?? "unknown" };
  }

  /**
   * Verify the configuration set really enforces TLS, rather than trusting that
   * someone set it up correctly.
   *
   * This is the whole point. Passing a configuration set name proves nothing —
   * a set with no delivery options behaves exactly like the opportunistic
   * default. So we read it back and refuse if TlsPolicy is not REQUIRE.
   *
   * Checked once per process, and the memo has to live OUTSIDE the instance to
   * be true: getTransport() hands back `new SesTransport()` on every call, so a
   * per-object flag is a cache that never hits — it bought a second SES API
   * round trip on every message, on a path that now includes a buyer waiting at
   * a signature step. Keyed by configuration set name so that changing the
   * variable cannot be answered from a memo about the previous one.
   *
   * Note that this governs the raw-MIME path identically. `ConfigurationSetName`
   * is a parameter of SendEmailCommand, not of `Content`, so switching Simple
   * for Raw changes nothing about which delivery options apply — and the name is
   * only recorded after this returns, so a failure here can never be cached as a
   * pass.
   */
  async #assertTlsRequired(ses: SesClient, name: string): Promise<void> {
    if (tlsVerifiedFor === name) return;

    const config = await ses.send(
      new ses.GetConfigurationSetCommand({ ConfigurationSetName: name }),
    );
    const policy = config.DeliveryOptions?.TlsPolicy;

    if (policy !== "REQUIRE") {
      throw new Error(
        `SES configuration set "${name}" has TlsPolicy=${policy ?? "unset"}, ` +
          `not REQUIRE. healdesk's business associate agreement promises not to ` +
          `transmit patient information over a channel that cannot negotiate ` +
          `encryption, and with anything other than REQUIRE, SES silently ` +
          `delivers in cleartext when the receiving server declines TLS. ` +
          `Refusing to send.`,
      );
    }

    tlsVerifiedFor = name;
  }
}

/**
 * The configuration set whose TlsPolicy has already been read back and found to
 * be REQUIRE, for this process. Never a boolean: a name is what makes the memo
 * answer the question that was asked.
 */
let tlsVerifiedFor: string | undefined;

/**
 * The SES client, imported lazily.
 *
 * Same pattern as crypto/kms.ts: the SDK is a heavy optional dependency that
 * only the production path needs, so development and tests never load it.
 *
 * Attachments did not change that. The raw path is built here, out of bytes,
 * and handed to SES as `Content.Raw.Data` — it needs no type from the SDK, so
 * @aws-sdk/client-sesv2 stays an install-it-in-production dependency rather
 * than becoming a build-time one for everybody.
 */
type SesClient = {
  send: (command: unknown) => Promise<{
    MessageId?: string;
    DeliveryOptions?: { TlsPolicy?: string };
  }>;
  SendEmailCommand: new (input: unknown) => unknown;
  GetConfigurationSetCommand: new (input: unknown) => unknown;
};

/**
 * Indirected through a constant for the same reason as crypto/kms.ts: a literal
 * specifier makes the bundler resolve an optional dependency at build time and
 * fail when it is absent, which is exactly the case in development.
 */
const SES_MODULE = "@aws-sdk/client-sesv2";

/**
 * Bounds on how long a mail call may take, because one of them now sits inside
 * a request a buyer is waiting on.
 *
 * The AWS SDK imposes no request timeout of its own: construct the client with
 * nothing but a region and a socket that connects and then goes quiet blocks
 * forever. That is survivable for the monthly report, which runs in a job. It is
 * not survivable for the BAA copy, which is sent from the signing request —
 * there, an unbounded wait turns a signature we have already committed into a
 * 5xx at the marketing site, and the buyer's obvious response is to sign again.
 * Two acceptance rows for one act of assent is the one mess this record must
 * never contain.
 *
 * `maxAttempts` is 2 rather than the SDK's 3 for the same reason: SendEmail is
 * not idempotent, so every retry is a chance at a duplicate message, and the
 * budget is a multiple of it.
 *
 * ## Why the request timeout is long, and was wrong at five seconds
 *
 * The SDK treats a request timeout as a retryable error. So with a five-second
 * request timeout and two attempts, a SendEmail that SES ACCEPTED and answered
 * in six seconds was aborted and sent again — and the retry is the whole
 * failure, because the first call had already delivered. The comment above
 * already said SendEmail is not idempotent; the timeout was quietly arranging
 * for it to be called twice.
 *
 * What that costs is two copies of a signed business associate agreement in the
 * counterparty's mailbox, and the record cannot tell them apart or tell anyone
 * which one is authoritative: `copy_sent_at` and `copy_document_sha256` record
 * one delivery, because from this side there was one. That asymmetry is the
 * whole argument. A copy that never arrives is recoverable and is already
 * surfaced — the ops console counts `copy_sent_at is null` and has a resend
 * button. A copy that arrived twice cannot be un-sent, and it is the first
 * document this system ever sends a buyer.
 *
 * Five seconds was also never the thing protecting the buyer's request. That is
 * COPY_BUDGET_MS in lib/agreements.ts, which stops waiting after eight seconds
 * and — the part that matters here — does not retry. So the request timeout was
 * buying no latency guarantee anyone relied on, and paying for it in duplicate
 * contracts.
 *
 * Twenty seconds is a judgement rather than a measurement: AWS publishes no
 * SendEmail latency figure to derive one from, and this comment will not invent
 * one. What makes it defensible is which way the error runs. Too long costs a
 * background job a slower failure and the signing request nothing at all, since
 * COPY_BUDGET_MS answers the buyer either way. Too short costs a duplicate
 * contract. If SES is ever seen answering slower than this, the correction is
 * to raise it further, never to lower it.
 *
 * The alternative — keep five seconds and stop the SDK retrying timeouts
 * specifically — was rejected on testability. The SDK classifies a request
 * timeout as TRANSIENT, alongside a reset connection, and makes the retry
 * decision inside its retry strategy, so suppressing just that case means
 * supplying a custom RetryStrategyV2: SDK-internal surface, written against a
 * package this repo deliberately does not install (see SES_MODULE) and
 * therefore cannot type-check or test. Untested retry logic on the path that
 * mails signed contracts is a worse trade than a longer timeout.
 *
 * The CONNECT timeout stays short, and stays the fast failure. A connection
 * that was never established cannot have delivered anything, so retrying one is
 * unambiguously safe — which is exactly what cannot be said of the other.
 */
const SES_CONNECT_TIMEOUT_MS = 2_000;
const SES_REQUEST_TIMEOUT_MS = 20_000;
const SES_MAX_ATTEMPTS = 2;

let cached: SesClient | undefined;

async function client(): Promise<SesClient> {
  if (cached) return cached;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ SES_MODULE)) as never;
  } catch {
    throw new Error(
      "HEALDESK_EMAIL_TRANSPORT is 'ses' but @aws-sdk/client-sesv2 is not " +
        "installed. Run: npm install @aws-sdk/client-sesv2 -w @healdesk/app",
    );
  }

  const SESv2Client = mod.SESv2Client as new (config: unknown) => {
    send: SesClient["send"];
  };
  const instance = new SESv2Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    maxAttempts: SES_MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: SES_CONNECT_TIMEOUT_MS,
      requestTimeout: SES_REQUEST_TIMEOUT_MS,
    },
  });

  cached = {
    send: (command) => instance.send(command),
    SendEmailCommand: mod.SendEmailCommand as SesClient["SendEmailCommand"],
    GetConfigurationSetCommand:
      mod.GetConfigurationSetCommand as SesClient["GetConfigurationSetCommand"],
  };
  return cached;
}

/**
 * Which wire a message goes down.
 *
 * ## The rule
 *
 *   phiClass "none"          -> Resend or SES, whichever is configured
 *   phiClass "may-carry-phi" -> SES only, and only with TlsPolicy=REQUIRE
 *
 * Class first, configured transport second — and that ordering is the design,
 * not a coding style. Read the other way round it would be "use what is
 * configured, and hope it suits the message", which downgrades silently the
 * first time someone sets HEALDESK_EMAIL_TRANSPORT=resend on a box that also
 * sends something patient-bearing. The PHI branch has no fallback on purpose:
 * where the configured transport cannot carry the class, this raises, because
 * the only alternative to refusing is sending it anyway. (The console stub
 * below is not a fallback — it sends nothing, and says so.)
 *
 * ## Why the class is a parameter rather than read off the message
 *
 * Because a factory has no message. The declaration therefore has to be handed
 * in by the caller, which is why every call site reads `getTransport(m.phiClass)`
 * — one declaration on the message, quoted here, rather than a second judgement
 * made in a second place that can disagree with the first. ResendTransport
 * re-checks the message itself, so an injected or hand-built transport is
 * governed by the same rule; this is the half that stops the wrong transport
 * from ever being constructed.
 *
 * Anything that is not exactly "none" routes as PHI-bearing, including a value
 * no version of PhiClass has ever contained. Fail closed.
 */
export function getTransport(phiClass: PhiClass): EmailTransport {
  const configured = process.env.HEALDESK_EMAIL_TRANSPORT;
  const mayCarryPhi = phiClass !== "none";

  if (mayCarryPhi && configured === "resend") {
    throw new PhiRoutingError(
      "Refusing to route: HEALDESK_EMAIL_TRANSPORT is 'resend' and this " +
        "message is classed as possibly carrying patient information. Resend " +
        "signs no business associate agreement and has no equivalent of SES's " +
        "TlsPolicy=REQUIRE, so it cannot be made to fail a delivery the " +
        "receiving server will not encrypt. Set HEALDESK_EMAIL_TRANSPORT=ses " +
        "for this deployment — sending it over Resend is not a lesser option, " +
        "it is the thing healdesk's business associate agreement says it does " +
        "not do.",
    );
  }

  if (configured === "ses") return new SesTransport();
  if (configured === "resend") return new ResendTransport();

  if (env.isProduction()) {
    // Fail here rather than pretending to have mailed anyone.
    throw new Error(
      "No email transport configured in production. Set " +
        "HEALDESK_EMAIL_TRANSPORT=resend for mail that carries no patient " +
        "information, or =ses, which is the only setting allowed to carry any.",
    );
  }

  // Development, either class: it writes to the log and reports that nothing
  // was sent, so there is no channel here to be unencrypted.
  return new ConsoleTransport();
}

// -----------------------------------------------------------------------------
// Raw MIME
//
// Hand-rolled rather than pulled from a library, for the same reason the SES
// client is lazy: this is one message shape (a body, optionally with an
// alternative rendering, plus files) and a mail-composition dependency would be
// a large amount of code sitting on the path that carries signed contracts.
//
// Everything below treats its inputs as hostile. `to` is an address a stranger
// typed into a form; `filename` and `contentType` come from a caller. A header
// is terminated by a newline, so any of those three containing one is an
// injected header — a second Bcc, a replaced From — and the answer is to refuse
// the message, never to strip the newline and send something the caller did not
// ask for.
// -----------------------------------------------------------------------------

/**
 * SES rejects a message over 40 MB (that is the whole MIME message, after
 * base64 has inflated the bytes by a third). We stop well short of it: an
 * agreement PDF is a few hundred kilobytes, so anything approaching this is a
 * bug upstream, and a clear refusal here beats an opaque SES error.
 */
const MAX_RAW_MESSAGE_BYTES = 30 * 1024 * 1024;

export class MailFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailFormatError";
  }
}

/**
 * An address, in the two halves that do not get the same answer.
 *
 * What was here before was one regex of negated classes —
 * `[^\s@,<>()[\]:;\\"]+@…` — which names a dozen characters it will not accept
 * and therefore accepts every code point outside them, non-ASCII included. It
 * described the SHAPE of an address and said nothing about whether the bytes
 * could go in a header, so `gunter@klinik-münchen.test` satisfied it and
 * buildRawMessage wrote it into `To:` as raw 8-bit UTF-8. Every other value on
 * that path is made header-safe — the subject by RFC 2047, the filename by
 * transliteration — and the addresses were the exception.
 *
 * The two halves are different problems:
 *
 *   - the DOMAIN already has a standard ASCII form. IDNA/punycode exists so
 *     that `münchen-klinik.test` can travel as `xn--mnchen-klinik-wob.test`
 *     and reach the same host, so it is CONVERTED rather than refused. Refusing
 *     it would be refusing a correctly-formed address we know how to send to.
 *   - the LOCAL part has no such form. A non-ASCII mailbox name needs SMTPUTF8,
 *     which is negotiated per hop, is not universally supported, and which this
 *     transport does not speak. There is no repair either: RFC 2047 explicitly
 *     does not apply inside an address, and transliterating one would deliver a
 *     signed contract to whatever different mailbox the stripped accents
 *     happened to name. So it is REFUSED at validation time, where an operator
 *     gets a reason they can act on — which beats emitting 8 bits and leaving a
 *     receiving MTA to decide what becomes of a contract.
 *
 * Both patterns are written as positive classes, deliberately. That is the
 * actual fix: a negated class is a list of what we thought of, and the code
 * point that matters is always the one nobody thought of.
 */

/**
 * RFC 5322 dot-atom: the atext characters, in dot-separated runs. Narrower than
 * the old negated class in the two ways that were wrong rather than strict — it
 * is ASCII by construction, and it rejects the leading, trailing and doubled
 * dots that are not a legal mailbox anywhere.
 */
const LOCAL_PART =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

/**
 * An LDH domain of at least two labels, checked AFTER punycode conversion.
 *
 * Checked after, and not merely for tidiness: `domainToASCII` is a converter,
 * not a validator, and hands back `a..b.com` and `-bad.com` unchanged rather
 * than rejecting them. It signals failure by returning the empty string, which
 * is necessary to check and nowhere near sufficient.
 */
const DOMAIN_ASCII =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9]$/;

/**
 * The two ceilings, from the two specifications that set them.
 *
 * 64 for the local part is RFC 5321 §4.5.3.1. 253 for the domain is the DNS
 * presentation-format limit rather than RFC 5321's 255, because the value being
 * measured here is a domain NAME after punycode conversion: 255 is the wire
 * form, which spends two octets on the root label and the leading length byte.
 * Taking the smaller is the safe direction, and together they bound the header
 * line this becomes at well under the RFC 5322 998.
 */
const MAX_LOCAL_PART_CHARS = 64;
const MAX_DOMAIN_CHARS = 253;

/**
 * Printable US-ASCII, which is all a header field may contain (RFC 5322 §2.2).
 *
 * Every value that reaches a header below is made to satisfy this one way or
 * another: the subject by RFC 2047 encoding, the filename by transliteration,
 * a recipient's domain by punycode conversion, and everything else about an
 * address by refusal. Refusal is the only honest option for the mailbox name —
 * encoding one produces a header no MTA can route, and transliterating one
 * names a different mailbox. The domain is the one half with a standard ASCII
 * form to be converted into, so it is the one half that is converted.
 *
 * assertHeaderAscii() then checks the outcome at the point of writing, because
 * four separate routes to the same property is four places for it to stop being
 * true.
 */
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/** RFC 2045 type/subtype, restricted to token characters. */
const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/;

function assertNoHeaderBreak(field: string, value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new MailFormatError(
      `Refusing to send: the ${field} contains a line break or null byte, ` +
        `which in a mail header means an injected header rather than a value.`,
    );
  }
}

/**
 * The From address is operator-configured, so it is allowed the display-name
 * form ("healdesk <hello@healdesk.io>"); the To address is not, because it came
 * from a form.
 *
 * It is not punycoded the way a recipient's domain is, and the asymmetry is on
 * purpose. This is healdesk's own sending domain: it has to be verified in SES
 * and carry DKIM records before a single message leaves, so it is ASCII by the
 * time anyone can configure it here — and unlike a recipient's address it has an
 * operator who can be told to correct it. Splitting a display-name form to
 * convert the half inside the angle brackets would be new parsing on the From
 * header for a case that cannot arise, and parsing is what goes wrong here.
 */
function assertSendableFrom(value: string): void {
  assertNoHeaderBreak("sender address", value);
  if (!value.trim()) throw new MailFormatError("Refusing to send: empty sender address.");
  if (!ASCII_PRINTABLE.test(value)) {
    throw new MailFormatError(
      "Refusing to send: HEALDESK_EMAIL_FROM is not printable US-ASCII. It is " +
        "written into the From header verbatim, and an 8-bit octet there is not " +
        "a header any receiving client is required to understand. A display " +
        "name needing accents has to arrive already encoded as an RFC 2047 word.",
    );
  }
}

/**
 * The recipient, in the form it will actually be transmitted.
 *
 * Returns the address rather than merely approving it, because the punycode
 * conversion is a change to the value and a checker that threw the changed
 * value away would leave the caller writing the unconverted one — which is the
 * bug this replaced, in a new costume.
 *
 * Nothing about the address is echoed in any message raised here. It is the one
 * piece of personal data on this path, these strings reach a log line and a
 * security_events row, and "which address" is not the question an operator is
 * asking anyway — they have the row in front of them.
 */
export function normaliseRecipient(value: string): string {
  assertNoHeaderBreak("recipient address", value);
  const trimmed = value.trim();

  // The last "@", not the first: the local part below cannot contain one, so
  // the two agree for any address that will be accepted — but splitting on the
  // last means a rejected address is rejected for its local part rather than
  // for a domain that was never the domain.
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) {
    throw new MailFormatError(
      "Refusing to send: the recipient is not a single plain address.",
    );
  }

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  if (local.length > MAX_LOCAL_PART_CHARS || !LOCAL_PART.test(local)) {
    throw new MailFormatError(
      "Refusing to send: the recipient's mailbox name is not one this " +
        "transport can address. A mail header is US-ASCII, and a non-ASCII " +
        "mailbox name needs SMTPUTF8, which is negotiated per hop and which " +
        "healdesk does not speak — it can be neither encoded (RFC 2047 does " +
        "not apply inside an address) nor transliterated (that names a " +
        "different mailbox). A display name, a second address or a bracketed " +
        "form is refused here too: this field takes one bare address.",
    );
  }

  // The A-label, so an internationalised domain is transmitted correctly rather
  // than raw. domainToASCII returns "" when it cannot convert, and returns
  // some invalid inputs unchanged, so the result is validated either way.
  const ascii = domainToASCII(domain);
  if (
    !ascii ||
    ascii.length > MAX_DOMAIN_CHARS ||
    !DOMAIN_ASCII.test(ascii)
  ) {
    throw new MailFormatError(
      "Refusing to send: the recipient's domain is not a domain healdesk can " +
        "convert to the ASCII form a mail header requires.",
    );
  }

  return `${local}@${ascii}`;
}

/**
 * True when normaliseRecipient would accept this address.
 *
 * Exported so that the places which validate an address BEFORE there is a
 * message — signature, above all — ask the transport what it can send rather
 * than keeping a second regex that drifts from this one. Two spellings of "is
 * this an address" is how a value gets onto a legal record that the mail layer
 * will later refuse to send to, which is the worst moment to find out.
 */
export function isSendableAddress(value: string): boolean {
  try {
    normaliseRecipient(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Last line: the bytes about to be written into a header field really are
 * 7-bit.
 *
 * Every value reaching a header is made ASCII by its own route — the addresses
 * by refusal and conversion, the subject by RFC 2047, the filename by
 * transliteration. This asserts the outcome instead of trusting the three
 * routes, because they are three separate pieces of code and the failure they
 * share is silent: an 8-bit octet in a header is not rejected locally, it is
 * accepted by SES and then rendered or dropped at the far end.
 */
function assertHeaderAscii(field: string, value: string): string {
  if (!ASCII_PRINTABLE.test(value)) {
    throw new MailFormatError(
      `Refusing to send: the ${field} is not printable US-ASCII once assembled.`,
    );
  }
  return value;
}

/**
 * How long a filename may be. Short enough that the two header lines it appears
 * on stay far inside the RFC 5322 line limit.
 */
const MAX_FILENAME_CHARS = 100;

/**
 * A trailing dotted segment that is still plausibly an extension.
 *
 * Bounded at twelve characters so that a name whose last segment is not an
 * extension at all — `healdesk-baa-2026-08-18`, a hash, a UUID tail — is left
 * as one stem and truncated as one, rather than having an arbitrary 30
 * characters declared load-bearing and preserved.
 */
const FILENAME_EXTENSION = /^(.*)\.([A-Za-z0-9]{1,12})$/;

/**
 * Reduce a filename to characters that need no quoting or encoding in a header.
 *
 * RFC 2231's `filename*` would preserve a non-ASCII name, but the names this
 * system generates are ASCII by construction, and a transliterated filename is
 * a far smaller surprise than a header the receiving client parses differently
 * from the one we intended.
 *
 * ## Why the STEM is truncated and never the extension
 *
 * The length cap used to be a `.slice(0, 100)` on the finished string, which
 * cut wherever 100 characters happened to land. A 150-character name came back
 * as 100 characters of stem with no extension at all; a 98-character stem came
 * back ending `.p`. Both are the same failure at different severities: the
 * recipient saves an attachment their operating system will not open, or opens
 * with the wrong application, and this is the message that carries the signed
 * agreement — the one file a clinic is expected to keep and produce years
 * later. A shortened name is a cosmetic loss. A lost or corrupted extension is
 * a file the counterparty cannot use, delivered under a covering note saying
 * their agreement is attached.
 *
 * So the budget is spent on the stem and the extension is always kept whole.
 */
function safeFilename(filename: string): string {
  assertNoHeaderBreak("attachment filename", filename);
  const cleaned = filename
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "");
  if (!cleaned) {
    throw new MailFormatError(
      "Refusing to send: the attachment filename is empty once made safe for a header.",
    );
  }

  const found = FILENAME_EXTENSION.exec(cleaned);
  const stem = found ? found[1]! : cleaned;
  const extension = found ? `.${found[2]!}` : "";

  // Trailing separators removed AFTER the cut, so a name truncated mid-word
  // does not arrive as "healdesk-baa-2026-.pdf".
  const trimmed = stem
    .slice(0, MAX_FILENAME_CHARS - extension.length)
    .replace(/[-.]+$/, "");

  // The stem should not be emptiable by any of that — the leading-separator
  // strip above leaves a first character that is neither "-" nor ".", and the
  // budget is never smaller than the longest extension kept — but "should not"
  // is a claim about three transformations, and the cost of being wrong is an
  // attachment named nothing but its extension. So the fallback is the old
  // behaviour, which was at least a name.
  return trimmed ? `${trimmed}${extension}` : cleaned.slice(0, MAX_FILENAME_CHARS);
}

/**
 * RFC 2047 encoded-words, for a subject that is not plain ASCII.
 *
 * A clinic's legal name can contain anything, and an 8-bit byte in a header is
 * not merely non-standard — it is rendered as mojibake by the clients that
 * accept it and rejected by the ones that do not. Each word stays under the
 * 75-character limit, and the split never lands inside a UTF-8 sequence, which
 * is the classic way this goes wrong: base64 hides the damage until a name with
 * an accent in the wrong column arrives.
 */
function encodeHeaderValue(field: string, value: string): string {
  assertNoHeaderBreak(field, value);
  if (ASCII_PRINTABLE.test(value)) return value;

  const prefix = "=?UTF-8?B?";
  const suffix = "?=";
  // 75 total, minus the delimiters, rounded down to a whole base64 quantum.
  const maxBytes = Math.floor((75 - prefix.length - suffix.length) / 4) * 3;

  const bytes = Buffer.from(value, "utf8");
  const words: string[] = [];
  let at = 0;
  while (at < bytes.length) {
    let take = Math.min(maxBytes, bytes.length - at);
    // Back off while the next byte would be a continuation byte (10xxxxxx),
    // i.e. while the cut would fall inside a character.
    while (take > 1 && at + take < bytes.length && (bytes[at + take]! & 0xc0) === 0x80) {
      take -= 1;
    }
    words.push(prefix + bytes.subarray(at, at + take).toString("base64") + suffix);
    at += take;
  }
  // Folded: a continuation line begins with whitespace.
  return words.join("\r\n ");
}

/**
 * The canonical form of a text body: CRLF line endings.
 *
 * RFC 2045 §6.8 says base64 encodes the CANONICAL form of the data, and for
 * text/* that means CRLF — the encoding hides the difference from the transport,
 * so a body assembled with bare LF travels intact and then decodes to something
 * the spec does not describe. Modern clients cope; the ones that do not render
 * the whole part as a single run-on line, which on the agreement copy would be
 * a paragraph of legal wording with its structure removed.
 *
 * Applied only to text, never to an attachment: normalising bytes inside a PDF
 * would corrupt the file the clinic is meant to keep.
 */
function canonicalText(value: string): string {
  return value.replace(/\r\n?|\n/g, "\r\n");
}

/** base64, wrapped at 76 columns with CRLF as RFC 2045 requires. */
function base64Lines(data: Uint8Array | string): string {
  const encoded =
    typeof data === "string"
      ? Buffer.from(data, "utf8").toString("base64")
      : Buffer.from(data).toString("base64");

  const lines: string[] = [];
  for (let at = 0; at < encoded.length; at += 76) {
    lines.push(encoded.slice(at, at + 76));
  }
  return lines.join("\r\n");
}

/**
 * RFC 5322 date, built from UTC parts.
 *
 * Not toUTCString(): that is close to the right format but is specified by the
 * HTTP grammar, not the mail one, and not via toLocale*: a header whose value
 * depends on which ICU data the container shipped with is a bug waiting for a
 * different base image.
 */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function rfc5322Date(at: Date): string {
  // An Invalid Date makes every field below NaN, and the header would read
  // "undefined, NaN undefined NaN" — a malformed header rather than an absent
  // one, which is the worse of the two failures.
  if (Number.isNaN(at.getTime())) {
    throw new MailFormatError("Refusing to send: the message date is invalid.");
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${DAYS[at.getUTCDay()]}, ${pad(at.getUTCDate())} ${MONTHS[at.getUTCMonth()]} ` +
    `${at.getUTCFullYear()} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:` +
    `${pad(at.getUTCSeconds())} +0000`
  );
}

/**
 * A boundary that cannot occur in the content it delimits.
 *
 * Every part below is base64, whose alphabet is A-Za-z0-9+/=, and this string
 * contains "_" and "-". So the usual worry — a boundary appearing inside a part
 * and truncating the message — is impossible by construction rather than
 * improbable by randomness. The random half is there so two messages never
 * share one.
 */
function boundary(): string {
  return `----=_healdesk_${randomBytes(16).toString("hex")}`;
}

export function buildRawMessage(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: EmailAttachment[];
  now?: Date;
}): Uint8Array {
  assertSendableFrom(input.from);
  // The transmitted form, not the typed one: an internationalised domain
  // becomes its A-label here and is written below as the A-label.
  const to = normaliseRecipient(input.to);

  if (input.attachments.length === 0) {
    throw new MailFormatError(
      "buildRawMessage was called with no attachments; use the simple content form.",
    );
  }

  /**
   * Estimate before encoding, not after.
   *
   * The ceiling below is checked on the assembled message, which is the number
   * that actually matters — but reaching it means having already built a base64
   * string a third larger than an attachment that was too big in the first
   * place. For a mistakenly-attached video that is an out-of-memory crash
   * instead of an error message.
   */
  const rawBytes = input.attachments.reduce(
    (total, a) => total + a.content.byteLength,
    0,
  );
  if (Math.ceil((rawBytes * 4) / 3) > MAX_RAW_MESSAGE_BYTES) {
    throw new MailFormatError(
      `Refusing to send: ${rawBytes} bytes of attachments will not fit under ` +
        `healdesk's ${MAX_RAW_MESSAGE_BYTES}-byte message ceiling once base64 has ` +
        `added a third to them.`,
    );
  }

  const subject = encodeHeaderValue("subject", input.subject);
  // RFC 5322 caps a line at 998 characters. Only an ASCII subject can reach it,
  // since a non-ASCII one is folded above. Refuse rather than truncate: a
  // silently shortened subject is a small lie told on every message.
  if (subject.split("\r\n").some((line) => line.length > 900)) {
    throw new MailFormatError(
      "Refusing to send: the subject is too long for a mail header.",
    );
  }

  const mixed = boundary();
  const parts: string[] = [
    `From: ${assertHeaderAscii("sender address", input.from)}`,
    `To: ${assertHeaderAscii("recipient address", to)}`,
    `Subject: ${subject}`,
    `Date: ${rfc5322Date(input.now ?? new Date())}`,
    `MIME-Version: 1.0`,
    // No Message-ID: SES assigns one, and the id it assigns is the one returned
    // to the caller. Supplying our own would make the two disagree.
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    ``,
    `--${mixed}`,
  ];

  if (input.html) {
    const alternative = boundary();
    parts.push(
      `Content-Type: multipart/alternative; boundary="${alternative}"`,
      ``,
      `--${alternative}`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      base64Lines(canonicalText(input.text)),
      `--${alternative}`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      base64Lines(canonicalText(input.html)),
      `--${alternative}--`,
    );
  } else {
    parts.push(
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      base64Lines(canonicalText(input.text)),
    );
  }

  for (const attachment of input.attachments) {
    // Header safety first, so a bad filename is reported as a bad filename
    // rather than surfacing while another error message is being built.
    const name = safeFilename(attachment.filename);
    if (!MIME_TYPE.test(attachment.contentType)) {
      throw new MailFormatError(
        "Refusing to send: the attachment content type is not a MIME type.",
      );
    }
    if (attachment.content.byteLength === 0) {
      throw new MailFormatError(
        `Refusing to send: attachment "${name}" is empty. A message announcing a ` +
          `document with nothing attached is worse than one that never arrived, ` +
          `because the recipient is left believing they hold a copy.`,
      );
    }

    parts.push(
      `--${mixed}`,
      `Content-Type: ${attachment.contentType}; name="${name}"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${name}"`,
      ``,
      base64Lines(attachment.content),
    );
  }

  parts.push(`--${mixed}--`, ``);

  const raw = Buffer.from(parts.join("\r\n"), "utf8");
  if (raw.byteLength > MAX_RAW_MESSAGE_BYTES) {
    throw new MailFormatError(
      `Refusing to send: the assembled message is ${raw.byteLength} bytes, over ` +
        `healdesk's ${MAX_RAW_MESSAGE_BYTES}-byte ceiling. SES rejects anything above ` +
        `40 MB and base64 adds a third, so this would fail at the API with a far ` +
        `less useful message.`,
    );
  }
  return raw;
}

/**
 * Guard rail: refuse to send anything that looks like it contains PHI.
 *
 * Belt and braces over the renderer, which is already aggregate-only. The cost
 * of a false positive is one undelivered report; the cost of a false negative
 * is unsecured PHI in a shared inbox, so the asymmetry decides the design.
 */
const PHI_SHAPED = [
  /\b\+?\d[\d\s().-]{8,}\d\b/, // phone number
  /[^\s@]+@[^\s@]+\.[^\s@]{2,}/, // email address
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/, // ISO date, which could be a DOB
];

export class PhiInEmailError extends Error {
  constructor(pattern: string) {
    super(
      `Refusing to send: the rendered report contains something shaped like ${pattern}. ` +
        `Monthly reports must be aggregate-only — the per-appointment detail belongs ` +
        `inside the clinic's own software. See docs/hipaa-compliance.md.`,
    );
    this.name = "PhiInEmailError";
  }
}

export function assertNoPhiInReport(report: RenderedReport): void {
  // The reply-to line legitimately contains our own address; check the body
  // sections that are built from data, not the fixed footer.
  //
  // The HTML is scanned too. It used to be skipped, which meant the guard
  // watched the one part of the email most recipients never look at while
  // ignoring the part they actually read — and the two are built from the same
  // data, so anything that could leak into one can leak into the other.
  const body = [report.subject, report.text, report.html ?? ""]
    .join("\n")
    .replace(/Reply to this email[^\n]*/g, "");

  for (const pattern of PHI_SHAPED) {
    if (pattern.test(body)) {
      throw new PhiInEmailError(pattern.source);
    }
  }
}

/**
 * The monthly report carries no PHI.
 *
 * Not an assumption — it is the property render.ts is built around and the one
 * assertNoPhiInReport() enforces at the top of deliverReport(), scanning the
 * subject, the text and the HTML for anything shaped like a phone number, an
 * email address, an SSN or a date of birth and refusing the send. The report
 * is counts and totals; none of HIPAA's 18 identifiers can appear in an
 * aggregate. The guard is what makes this constant a fact rather than a claim,
 * and it runs before every send.
 *
 * One constant used both to route and to label, so the two cannot drift into
 * disagreeing about the same message.
 */
const MONTHLY_REPORT_PHI_CLASS = "none" satisfies PhiClass;

export async function deliverReport(
  target: DeliveryTarget,
  report: RenderedReport,
  transport: EmailTransport = getTransport(MONTHLY_REPORT_PHI_CLASS),
): Promise<DeliveryResult> {
  assertNoPhiInReport(report);

  /**
   * A monthly report has no attachment, and must not acquire one here.
   *
   * assertNoPhiInReport reads the subject, the text and the HTML. It cannot
   * read inside a file, so an attachment on this path would be the one part of
   * the message the PHI guard does not cover — which is precisely the part
   * where a CSV of appointments would end up. The parameter type already says
   * RenderedReport; this catches the object that satisfies it structurally
   * while carrying more.
   */
  if (((report as OutgoingEmail).attachments?.length ?? 0) > 0) {
    throw new Error(
      "deliverReport does not carry attachments: the PHI guard cannot read " +
        "inside a file, and the monthly report is aggregate-only by design.",
    );
  }

  return transport.send(target, { ...report, phiClass: MONTHLY_REPORT_PHI_CLASS });
}
