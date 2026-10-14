import { env } from "../src/lib/env";
import { createDemoClinic, existingDemoClinics } from "../src/lib/onboarding/demo-clinic";

/**
 * Create healdesk's one demo clinic: a fictional practice, for the Google
 * verification video and for showing the product, which may exist in
 * production because the owner allowed it (Q6, 5 October 2026).
 *
 *   npm run demo-clinic -w @healdesk/app -- --name "<fictional practice>" --email <operator address> --operator "<your name>"
 *
 * Optional: --timezone <IANA zone> (default America/New_York), --plan <plan id>
 * (a package at its steps; default voice-metachat-500-300, every channel).
 *
 * What it does, in order (src/lib/onboarding/demo-clinic.ts has the why):
 *
 *   1. refuses if a demo clinic already exists: the owner allowed one;
 *   2. signs the current agreement for the fictional practice, the operator
 *      signing, exactly as the agreements endpoint would take it;
 *   3. provisions the clinic as a purchase would, with the internal `demo`
 *      option: billing status `demo`, no Stripe ids, synthetic data only;
 *   4. prints the clinic's id and slug.
 *
 * It sends no setup link, calendar link or welcome. The one email is the one
 * every signature sends: the signed agreement's PDF, to its signatory, the
 * operator. The address must be the operator's own (HEALDESK_ADMIN_EMAIL or
 * HEALDESK_OPS_EMAIL), because it becomes the demo clinic's one sign-in, and
 * a real practice's address would show that practice a clinic it never
 * bought.
 *
 * Afterwards: a demo clinic never goes live (ops goLive refuses it), and only
 * healdesk's own test Google accounts are ever connected to it. On it, and
 * nowhere else, the draft calendar election counts, so its calendar terms
 * can be elected before calendar-election/1.0.0 is released.
 *
 * On the AWS host, which has no shell, through run-task.sh only:
 *
 *   bash infra/aws/scripts/run-task.sh demo-clinic "<fictional practice>" "<your name>" <you@healdesk.io>
 *
 * which runs this in a one-off task with each option as an environment
 * variable instead (an argument, where one is given, wins):
 *
 *   HEALDESK_DEMO_NAME            --name
 *   HEALDESK_DEMO_OPERATOR_NAME   --operator
 *   HEALDESK_OPS_OPERATOR         --email
 *   HEALDESK_DEMO_TIMEZONE        --timezone
 *   HEALDESK_DEMO_PLAN            --plan
 *
 * What it prints, the clinic's id and slug, goes to the task's CloudWatch log.
 */

const ENV: Record<string, string> = {
  name: "HEALDESK_DEMO_NAME",
  operator: "HEALDESK_DEMO_OPERATOR_NAME",
  email: "HEALDESK_OPS_OPERATOR",
  timezone: "HEALDESK_DEMO_TIMEZONE",
  plan: "HEALDESK_DEMO_PLAN",
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const fromEnv = ENV[name] ? process.env[ENV[name]] : undefined;
  return fromEnv || undefined;
}

function usage(message: string): never {
  console.error(`[healdesk] ${message}`);
  console.error(
    'Usage: npm run demo-clinic -w @healdesk/app -- --name "<fictional practice>" --email <operator address> --operator "<your name>" [--timezone <IANA zone>] [--plan <plan id, e.g. voice-metachat-500-300>]',
  );
  process.exit(2);
}

function knownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const name = arg("name")?.trim();
  const email = arg("email")?.trim().toLowerCase();
  const operatorName = arg("operator")?.trim();
  const timezone = arg("timezone")?.trim();
  const plan = arg("plan")?.trim();

  if (!name || name.length < 2) usage("--name <the fictional practice's name> is required.");
  if (!email) usage("--email <your operator address> is required.");
  if (!operatorName || operatorName.length < 2)
    usage("--operator <your name> is required; it is the signature.");
  if (timezone && !knownTimeZone(timezone))
    usage(`--timezone must be an IANA zone, such as America/New_York.`);

  const operatorAddresses = [
    env.adminEmail(),
    process.env.HEALDESK_OPS_EMAIL?.trim().toLowerCase(),
  ].filter((address): address is string => Boolean(address));
  if (operatorAddresses.length === 0) {
    usage(
      "Set HEALDESK_ADMIN_EMAIL (or HEALDESK_OPS_EMAIL) first: the demo clinic's address must be the operator's own.",
    );
  }
  if (!operatorAddresses.includes(email)) {
    usage(
      "--email must be the operator's own address, HEALDESK_ADMIN_EMAIL or HEALDESK_OPS_EMAIL, never a practice's.",
    );
  }

  const existing = await existingDemoClinics();
  if (existing.length > 0) {
    usage(
      `A demo clinic already exists (${existing.map((c) => `${c.slug}, ${c.id}`).join("; ")}). The owner allowed one; use it.`,
    );
  }

  const demo = await createDemoClinic({ name, operatorEmail: email, operatorName, timezone, plan });

  console.info(
    [
      `[healdesk] demo clinic created`,
      `  clinic id   ${demo.clinicId}`,
      `  slug        ${demo.clinicSlug}`,
      `  agreement   ${demo.agreementId} (BAA ${demo.agreementVersion}, signed by you)`,
      demo.copy === "sent"
        ? `  Its PDF has been sent to you.`
        : `  Its PDF was not sent (${demo.copy}); resend it from the console's agreements view.`,
      `  Next: record its calendar election and connect one of healdesk's own test Google accounts. Never a real practice's.`,
      `  Its Meta connect links: channels-link with this clinic id (run-task.sh channels-link ${demo.clinicId}).`,
    ].join("\n"),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(
      `[healdesk] demo clinic failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
