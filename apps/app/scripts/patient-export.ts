import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { assertNoPhi } from "../src/lib/audit";
import { exportClinic, exportPatient, type PatientBundle } from "../src/lib/patient-rights/export";
import { exportTarget, storeBundle } from "../src/lib/patient-rights/export-store";
import { withTenant } from "../src/lib/tenant";

/**
 * Produce a patient-rights bundle, or a whole clinic's return bundle, as a
 * file on the app host.
 *
 * This is a script and not a console page on purpose. apps/web is the
 * marketing site: it holds no PHI and must not carry any, and a bundle is
 * nothing but PHI. So the operator runs this where the database is — the
 * app host, or a laptop with DATABASE_URL pointed at production over the
 * bastion — and hands the file to the clinic by the channel the runbook
 * names (docs/incident-response.md, "Patient rights requests"). Nothing
 * about the patient is printed; only counts.
 *
 *   npm run patient-export -w @healdesk/app -- --clinic <uuid> --phone +15551234567 --requested-by "practice manager, ticket 41"
 *   npm run patient-export -w @healdesk/app -- --clinic <uuid> --email someone@example.com --requested-by "..."
 *   npm run patient-export -w @healdesk/app -- --clinic <uuid> --all --requested-by "offboarding, notice of 1 September 2026"
 *
 * The audit row refuses anything shaped like an email address or a phone
 * number in --requested-by, and a date written in digits reads as one: write
 * dates in words.
 *
 * Optional: --out <dir> (default ./exports). The file is written 0600 and
 * named by clinic id and time, never by the patient.
 *
 * On the AWS host it runs as the one-off patient-export task
 * (infra/aws/scripts/run-task.sh patient-export <clinic id> "<who asked>"),
 * whose disk goes with it, so the bundle goes to the export bucket instead
 * (lib/patient-rights/export-store.ts). The task takes its inputs from the
 * environment, never the command line: HEALDESK_EXPORT_CLINIC_ID and
 * HEALDESK_EXPORT_REQUESTED_BY, for the whole clinic only, and
 * HEALDESK_EXPORT_BUCKET and HEALDESK_EXPORT_KEY for where it lands. A
 * patient's phone number or email never travels that way: a run's
 * overrides are recorded by CloudTrail, so a per-patient export is not
 * offered there.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  // The AWS task: the whole clinic, inputs from the environment.
  const fromEnv = process.env.HEALDESK_EXPORT_CLINIC_ID !== undefined;
  const clinicId = fromEnv ? process.env.HEALDESK_EXPORT_CLINIC_ID : arg("clinic");
  const phone = fromEnv ? undefined : arg("phone");
  const email = fromEnv ? undefined : arg("email");
  const all = fromEnv || flag("all");
  const requestedBy = fromEnv ? process.env.HEALDESK_EXPORT_REQUESTED_BY : arg("requested-by");
  const out = resolve(arg("out") ?? "exports");
  const bucket = process.env.HEALDESK_EXPORT_BUCKET;

  if (!clinicId || !UUID.test(clinicId)) throw new Error("--clinic <uuid> is required.");
  if (!requestedBy) throw new Error("--requested-by <who asked, and the ticket> is required; it goes in the audit row.");
  if (!all && !phone && !email) throw new Error("Give --phone, --email, or --all.");
  if (all && (phone || email)) throw new Error("--all is the whole clinic; drop --phone/--email.");
  if (phone && !/^\+\d{7,15}$/.test(phone)) throw new Error("--phone must be E.164, e.g. +15551234567.");
  if (requestedBy.length > 200) throw new Error("Keep who asked to 200 characters.");
  // It goes in the audit row, and on AWS through a recorded override.
  assertNoPhi({ requestedBy }, "requested-by");
  const target = bucket ? exportTarget(clinicId, bucket, process.env.HEALDESK_EXPORT_KEY ?? "") : null;
  if (bucket && !all) throw new Error("The export bucket takes whole-clinic bundles only.");

  const actor = { type: "service", serviceName: `patient-export:${process.env.USER ?? "operator"}` } as const;
  // To the bucket, the upload happens inside the export's transaction: if it
  // fails, the export's audit row rolls back with it, so nothing records a
  // bundle that was never stored (the care page checks for one before it
  // takes a handover).
  const bundle: PatientBundle = await withTenant({ clinicId, actor }, async (tx) => {
    const produced = all ? await exportClinic(tx, requestedBy) : await exportPatient(tx, { phone, email, requestedBy });
    if (target) await storeBundle(target, JSON.stringify(produced, null, 2));
    return produced;
  });

  let file: string;
  if (target) {
    file = `s3://${target.bucket}/${target.key}`;
  } else {
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const stamp = bundle.producedAt.replace(/[:.]/g, "-");
    file = join(out, `${all ? "clinic" : "patient"}-${clinicId}-${stamp}.json`);
    writeFileSync(file, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  }

  // Counts only. The file is the deliverable; the terminal is not a safe place.
  console.info(
    [
      `[healdesk] bundle written: ${file}`,
      `  contacts ${bundle.contacts.length}, conversations ${bundle.conversations.length}, appointments ${bundle.appointments.length},`,
      `  transactions ${bundle.transactions.length}, consent records ${bundle.consentRecords.length}, suppressions ${bundle.suppressions.length},`,
      `  contact attempts ${bundle.contactAttempts.length}, audit rows ${bundle.accountingOfDisclosures.length}`,
      all ? "  Next: hand it over, then mark the export delivered in the ops console." : "  Next: hand it to the clinic by the channel in docs/incident-response.md.",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error(`[healdesk] patient export failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
