import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describeError } from "../src/lib/log";
import { exportClinic, exportPatient, type PatientBundle } from "../src/lib/patient-rights/export";
import { exportTarget, storeBundle } from "../src/lib/patient-rights/export-store";
import { isPatientRequester, PATIENT_REQUESTERS } from "../src/lib/patient-rights/requesters";
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
 *   npm run patient-export -w @healdesk/app -- --clinic <uuid> --phone +15551234567 --requested-by person_via_practice
 *   npm run patient-export -w @healdesk/app -- --clinic <uuid> --email someone@example.com --requested-by practice
 *   npm run patient-export -w @healdesk/app -- --clinic <uuid> --contact <uuid> --requested-by practice
 *   npm run patient-export -w @healdesk/app -- --clinic <uuid> --all --requested-by practice
 *
 * --contact names the person by a contact's id: that contact, and every
 * contact carrying its number or its address (exportPatient).
 *
 * --requested-by is one of PATIENT_REQUESTERS (practice, person_via_practice,
 * representative_via_practice), chosen, never typed: the audit row outlives
 * the person. A whole clinic's bundle is always the practice's.
 *
 * Optional: --out <dir> (default ./exports). The file is written 0600 and
 * named by clinic id and time, never by the patient.
 *
 * On the AWS host it runs as the one-off patient-export task
 * (infra/aws/scripts/run-task.sh patient-export <clinic id>),
 * whose disk goes with it, so the bundle goes to the export bucket instead
 * (lib/patient-rights/export-store.ts). The task takes its inputs from the
 * environment, never the command line:
 *
 *   HEALDESK_EXPORT_CLINIC_ID     the clinic's id
 *   HEALDESK_EXPORT_CONTACT_ID    optional: one person's bundle, named by a
 *                                 contact's id; without it, the whole clinic
 *   HEALDESK_EXPORT_REQUESTED_BY  one of PATIENT_REQUESTERS; the whole
 *                                 clinic's is always `practice`
 *   HEALDESK_EXPORT_BUCKET        where it lands, and
 *   HEALDESK_EXPORT_KEY           clinic-<clinic id>-<UTC time>.json for the
 *                                 whole clinic, clinic-<clinic id>-patient-
 *                                 <UTC time>.json for one person
 *
 * A patient's phone number or email never travels that way: a run's
 * overrides are recorded by CloudTrail, so on the AWS host a person is named
 * by a contact's id only, as a deletion is (ops-erase-person.ts).
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
  // The AWS task: inputs from the environment, the whole clinic unless a
  // contact's id names one person. A contact id that is set but empty is a
  // mistake, not a whole-clinic run.
  const fromEnv = process.env.HEALDESK_EXPORT_CLINIC_ID !== undefined;
  const clinicId = fromEnv ? process.env.HEALDESK_EXPORT_CLINIC_ID : arg("clinic");
  const contactId = fromEnv ? process.env.HEALDESK_EXPORT_CONTACT_ID : arg("contact");
  const phone = fromEnv ? undefined : arg("phone");
  const email = fromEnv ? undefined : arg("email");
  const all = fromEnv ? contactId === undefined : flag("all");
  const requestedBy = fromEnv ? process.env.HEALDESK_EXPORT_REQUESTED_BY : arg("requested-by");
  const out = resolve(arg("out") ?? "exports");
  const bucket = process.env.HEALDESK_EXPORT_BUCKET;

  if (!clinicId || !UUID.test(clinicId)) throw new Error("--clinic <uuid> is required.");
  if (!requestedBy)
    throw new Error(
      `--requested-by <${PATIENT_REQUESTERS.join("|")}> is required; it goes in the audit row.`,
    );
  if (contactId !== undefined && !UUID.test(contactId))
    throw new Error("--contact (HEALDESK_EXPORT_CONTACT_ID) must be the contact's uuid.");
  if (!all && !phone && !email && !contactId)
    throw new Error("Give --phone, --email, --contact, or --all.");
  if (all && (phone || email || contactId))
    throw new Error("--all is the whole clinic; drop --phone/--email/--contact.");
  if (contactId && (phone || email))
    throw new Error("Name the person by --contact, or by --phone/--email, not both.");
  if (phone && !/^\+\d{7,15}$/.test(phone))
    throw new Error("--phone must be E.164, e.g. +15551234567.");
  if (!isPatientRequester(requestedBy)) {
    throw new Error(
      `--requested-by is one of ${PATIENT_REQUESTERS.join(", ")}: chosen, never typed.`,
    );
  }
  if (all && requestedBy !== "practice")
    throw new Error("A whole clinic's bundle is the practice's: --requested-by practice.");
  // The bucket takes the whole clinic, or one person named by a contact's id:
  // never a bundle found by a typed number or address.
  if (bucket && !all && !contactId)
    throw new Error("The export bucket takes a whole clinic, or one person by --contact.");
  const target = bucket
    ? exportTarget(
        clinicId,
        bucket,
        process.env.HEALDESK_EXPORT_KEY ?? "",
        all ? "clinic" : "patient",
      )
    : null;

  const actor = {
    type: "service",
    serviceName: `patient-export:${process.env.USER ?? "operator"}`,
  } as const;
  // To the bucket, the upload happens inside the export's transaction: if it
  // fails, the export's audit row rolls back with it, so nothing records a
  // bundle that was never stored (the care page checks for one before it
  // takes a handover).
  const bundle: PatientBundle = await withTenant({ clinicId, actor }, async (tx) => {
    const produced = all
      ? await exportClinic(tx, requestedBy)
      : await exportPatient(
          tx,
          contactId ? { contactId, requestedBy } : { phone, email, requestedBy },
        );
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
      `  contact attempts ${bundle.contactAttempts.length}, deposits ${bundle.depositPayments.length}, audit rows ${bundle.accountingOfDisclosures.length}`,
      all
        ? "  Next: hand it over, then mark the export delivered in the ops console."
        : "  Next: hand it to the clinic by the channel in docs/incident-response.md.",
    ].join("\n"),
  );
}

// describeError, not error.message: a failed query's message carries its
// parameters, and a per-patient export's are a phone number or an email.
main().catch((error: unknown) => {
  console.error(`[healdesk] patient export failed: ${describeError(error)}`);
  process.exit(1);
});
