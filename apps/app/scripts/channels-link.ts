import { issueConnectionLink, type LinkPurpose } from "../src/lib/connections/links";
import { env } from "../src/lib/env";

/**
 * Issue a clinic's links to connect its Meta channels.
 *
 *   npm run channels-link -w @healdesk/app -- <clinic id> [--only meta|whatsapp] [--days N]
 *
 * Prints one URL per channel: /channels/meta/<token> connects the Facebook
 * Page and its Instagram account, /channels/whatsapp/<token> the WhatsApp
 * number. Each is single use and spent when its connection is saved.
 *
 * A shell command rather than an operation in the ops console on purpose. The
 * console's operations are a closed list (lib/ops/api.ts), and this exists for
 * the Meta App Review recordings and the first pilot clinics. The onboarding
 * wizard (launch plan 2.6) replaces it with the connect buttons the spec
 * describes, inside a signed-in session, and this script then goes.
 *
 * The URLs are printed and nowhere else: the token is unrecoverable once this
 * process exits, which is the point of storing only its digest.
 *
 * On the AWS host, which has no shell, through run-task.sh only:
 *
 *   bash infra/aws/scripts/run-task.sh channels-link <clinic id> [meta|whatsapp] [days]
 *
 * which runs this in a one-off task with the arguments as environment
 * variables instead (HEALDESK_LINK_CLINIC_ID, HEALDESK_LINK_ONLY,
 * HEALDESK_LINK_DAYS; arguments, where given, win). There "printed" means the
 * task's own log group in CloudWatch, under the product key, and nowhere
 * else: run-task.sh names the stream and never shows its contents.
 */

const ACTOR = { type: "service" as const, serviceName: "channels-link-cli" };

function usage(): never {
  console.error("Usage: npm run channels-link -w @healdesk/app -- <clinic id> [--only meta|whatsapp] [--days N]");
  process.exit(2);
}

/**
 * The command line, or, when it is empty, the same thing from the one-off
 * task's environment.
 */
function argsFrom(argv: string[], environment: NodeJS.ProcessEnv): string[] {
  if (argv.length > 0) return argv;
  const clinicId = environment.HEALDESK_LINK_CLINIC_ID?.trim();
  if (!clinicId) return [];
  const only = environment.HEALDESK_LINK_ONLY?.trim();
  const days = environment.HEALDESK_LINK_DAYS?.trim();
  return [clinicId, ...(only ? ["--only", only] : []), ...(days ? ["--days", days] : [])];
}

async function main(): Promise<void> {
  const args = argsFrom(process.argv.slice(2), process.env);
  const clinicId = args[0];
  if (!clinicId || !/^[0-9a-f-]{36}$/i.test(clinicId)) usage();

  let purposes: LinkPurpose[] = ["meta", "whatsapp"];
  let days: number | undefined;
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--only" && (value === "meta" || value === "whatsapp")) purposes = [value];
    else if (flag === "--days" && value && /^\d+$/.test(value)) days = Number(value);
    else usage();
  }

  const base = env.betterAuthUrl().replace(/\/$/, "");
  for (const purpose of purposes) {
    const { token, expiresAt } = await issueConnectionLink(clinicId, { purpose, expiresInDays: days }, { actor: ACTOR });
    console.info(`${purpose.padEnd(8)} ${base}/channels/${purpose}/${token}`);
    console.info(`         expires ${expiresAt.toISOString()}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(`[healdesk] channels link failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
