/**
 * Every templated email, rendered from its fixture and sent to the inboxes
 * given, for the launch's seed test (Annex X8: Gmail, Microsoft 365,
 * Outlook.com, iCloud, Yahoo; light and dark mode; DKIM over the
 * List-Unsubscribe headers).
 *
 *   npm run email:seed -w @healdesk/app -- --to you@gmail.com,you@outlook.com
 *
 * It sends through whatever transport the environment names (Resend when
 * HEALDESK_EMAIL_TRANSPORT=resend, the console otherwise), with the same
 * sendEmail() as production, so a seed email is the email a clinic would get.
 * The fixtures carry ids and counts only, and no clinic tag, so nothing a
 * seed send says can be mistaken for a clinic's mail in Resend's logs.
 *
 * It runs only with an explicit --to, and never in production: the seed is
 * for test inboxes, and a production environment has real clinics' quota to
 * spend. Both are checked before anything is loaded, so the refusal is the
 * first thing that happens rather than whatever the database module says.
 */

const FIXTURE_CLINIC_ID = "0c1d2e3f-0000-4000-8000-000000000000";
const FIXTURE_CLINIC_NAME = "Radiance Med Spa";

function recipients(argv: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--to") values.push(argv[i + 1] ?? "");
    else if (arg.startsWith("--to=")) values.push(arg.slice("--to=".length));
  }
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

async function main(): Promise<number> {
  if (process.env.NODE_ENV === "production") {
    console.error("[healdesk] email:seed refuses to run in production.");
    return 1;
  }
  const to = recipients(process.argv.slice(2));
  if (to.length === 0) {
    console.error("usage: npm run email:seed -w @healdesk/app -- --to <address>[,<address>…]");
    return 1;
  }

  const { pool } = await import("../src/db");
  const { carriesUnsubscribe, optionalSwitchOf } = await import("../src/lib/email/kind-rules");
  const { copyProblems, subjectProblems, visibleText } = await import("../src/lib/email/lint");
  const { sendEmail } = await import("../src/lib/email/send");
  const { clinicReason, OPS_REASON } = await import("../src/lib/email/templates/context");
  const { TEMPLATES } = await import("../src/lib/email/templates/registry");
  const { unsubscribeHeaders, unsubscribeUrl } = await import("../src/lib/email/unsubscribe");
  const { isSendableAddress } = await import("../src/lib/reporting/deliver");

  try {
    const unusable = to.filter((address) => !isSendableAddress(address));
    if (unusable.length > 0) {
      console.error(`[healdesk] email:seed: ${unusable.length} address(es) cannot be sent to.`);
      return 1;
    }

    let failed = 0;
    for (const [kind, entry] of Object.entries(TEMPLATES)) {
      if (!entry) continue;
      const k = kind as Parameters<typeof carriesUnsubscribe>[0];
      const scope = carriesUnsubscribe(k) ? (optionalSwitchOf(k) ?? "commercial") : null;
      const ctx = {
        clinicName: kind === "ops_alert" ? null : FIXTURE_CLINIC_NAME,
        audience: "patients" as const,
        reason: kind === "ops_alert" ? OPS_REASON : clinicReason(FIXTURE_CLINIC_NAME),
        ...(scope ? { unsubscribeUrl: unsubscribeUrl(FIXTURE_CLINIC_ID, scope) } : {}),
        raisedAt: new Date(),
        timeZone: "America/New_York",
      };
      const rendered = entry.render(entry.fixture, ctx);
      const problems = [
        ...subjectProblems(rendered.subject),
        ...copyProblems(
          [rendered.subject, rendered.preheader, rendered.text, visibleText(rendered.html)].join(
            "\n",
          ),
        ),
      ];
      if (problems.length > 0) {
        console.warn(`[healdesk] ${kind}: the copy lint says ${problems.join("; ")}`);
      }
      for (const address of to) {
        const result = await sendEmail({
          to: address,
          kind,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          phiClass: "none",
          // A direct kind goes with the payload it rendered from (send.ts).
          payload: entry.fixture,
          ...(ctx.unsubscribeUrl ? { headers: unsubscribeHeaders(ctx.unsubscribeUrl) } : {}),
        });
        const detail = result.status === "sent" ? result.messageId : result.reason;
        console.info(
          `[healdesk] ${kind} → @${address.split("@")[1]}: ${result.status} (${detail})`,
        );
        if (result.status === "failed") failed += 1;
      }
    }
    return failed > 0 ? 1 : 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("[healdesk] email:seed failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
