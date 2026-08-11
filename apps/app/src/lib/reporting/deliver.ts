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

  async send(): Promise<DeliveryResult> {
    throw new Error(
      "SES delivery is not implemented. Needs an AWS account, a verified " +
        "sending domain, DKIM, and a configuration set with TlsPolicy=Require. " +
        "See docs/launch-plan.md, Phase 8.",
    );
  }
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
  const body = `${report.subject}\n${report.text}`.replace(
    /Reply to this email[^\n]*/g,
    "",
  );

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
