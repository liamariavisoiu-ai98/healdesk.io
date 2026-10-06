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
 */

const ACTOR = { type: "service" as const, serviceName: "channels-link-cli" };

function usage(): never {
  console.error("Usage: npm run channels-link -w @healdesk/app -- <clinic id> [--only meta|whatsapp] [--days N]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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
