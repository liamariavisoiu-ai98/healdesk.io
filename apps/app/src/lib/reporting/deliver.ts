import { env } from "@/lib/env";

import type { RenderedReport } from "./render";

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
 */

export type DeliveryTarget = {
  /** Business contact address. May be a shared inbox — the email has no PHI. */
  to: string;
  clinicId: string;
  clinicName: string;
};

export type DeliveryResult =
  | { status: "sent"; messageId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export interface EmailTransport {
  readonly name: string;
  send(
    target: DeliveryTarget,
    report: RenderedReport,
  ): Promise<DeliveryResult>;
}

/**
 * Development transport: writes to the log and reports honestly that nothing
 * was sent. Refuses to be used in production.
 */
export class ConsoleTransport implements EmailTransport {
  readonly name = "console";

  async send(
    target: DeliveryTarget,
    report: RenderedReport,
  ): Promise<DeliveryResult> {
    if (env.isProduction()) {
      throw new Error(
        "ConsoleTransport must never run in production. Configure SES.",
      );
    }

    console.info(
      `[healdesk] would send to ${target.to}: ${report.subject}`,
    );
    return {
      status: "skipped",
      reason: "No email transport configured; nothing was sent.",
    };
  }
}

/**
 * AWS SES. Not implemented yet — see the Phase 8 checklist.
 *
 * When it is, two things are non-negotiable:
 *
 *   1. A configuration set with `TlsPolicy: Require`, so delivery fails rather
 *      than silently downgrading to plaintext. Opportunistic TLS is not a
 *      safeguard, it is a hope.
 *   2. Bounce and complaint handling wired to suppression. A clinic whose
 *      address hard-bounces must stop being mailed, and a spam complaint must
 *      be treated as a stop request.
 */
export class SesTransport implements EmailTransport {
  readonly name = "ses";

  /** Checked once per process, then cached. See assertTlsRequired(). */
  #tlsVerified = false;

  async send(
    target: DeliveryTarget,
    report: RenderedReport,
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

    const sent = await ses.send(
      new ses.SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [target.to] },
        ConfigurationSetName: configurationSet,
        Content: {
          Simple: {
            Subject: { Data: report.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: report.text, Charset: "UTF-8" },
              ...(report.html
                ? { Html: { Data: report.html, Charset: "UTF-8" } }
                : {}),
            },
          },
        },
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
   * Checked once per process: the value changes about never, and paying an API
   * call per email to re-learn it would be silly. A deploy is the natural
   * boundary for re-checking, and a deploy restarts the process.
   */
  async #assertTlsRequired(ses: SesClient, name: string): Promise<void> {
    if (this.#tlsVerified) return;

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

    this.#tlsVerified = true;
  }
}

/**
 * The SES client, imported lazily.
 *
 * Same pattern as crypto/kms.ts: the SDK is a heavy optional dependency that
 * only the production path needs, so development and tests never load it.
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
  });

  cached = {
    send: (command) => instance.send(command),
    SendEmailCommand: mod.SendEmailCommand as SesClient["SendEmailCommand"],
    GetConfigurationSetCommand:
      mod.GetConfigurationSetCommand as SesClient["GetConfigurationSetCommand"],
  };
  return cached;
}

export function getTransport(): EmailTransport {
  if (process.env.HEALDESK_EMAIL_TRANSPORT === "ses") return new SesTransport();

  if (env.isProduction()) {
    // Fail at startup rather than pretending to have mailed anyone.
    throw new Error(
      "No email transport configured in production. Set HEALDESK_EMAIL_TRANSPORT=ses.",
    );
  }

  return new ConsoleTransport();
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

export async function deliverReport(
  target: DeliveryTarget,
  report: RenderedReport,
  transport: EmailTransport = getTransport(),
): Promise<DeliveryResult> {
  assertNoPhiInReport(report);
  return transport.send(target, report);
}
