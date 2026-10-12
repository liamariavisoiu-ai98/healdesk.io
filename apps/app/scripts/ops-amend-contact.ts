import {
  amendContactFromShell,
  askLines,
  optionsFrom,
  refusePatientDataInArgs,
  scriptFailure,
  shellOperator,
  typedEntryAllowed,
} from "../src/lib/ops/patient-entry";

/**
 * Correct a contact's name, number or address in place, or clear one, on
 * the practice's direction (docs/handover.md, "Amendments"). Never through
 * apps/web.
 *
 * On the AWS host: by contact id, through run-task.sh only, and only to
 * clear fields. A corrected name, number or address is patient data, so it
 * may not be typed there nor passed in run-task's overrides (CloudTrail
 * records them); on AWS a correction with new values waits for the M5
 * portal, which takes it from the practice behind step-up. A one-off task
 * that clears takes these in its environment:
 *
 *   HEALDESK_AMEND_CLINIC_ID     the clinic's id
 *   HEALDESK_AMEND_CONTACT_ID    the contact's id
 *   HEALDESK_AMEND_CLEAR         fields to clear: fullName,phone,email
 *   HEALDESK_AMEND_REQUESTED_BY  practice | person_via_practice |
 *                                representative_via_practice
 *   HEALDESK_OPS_OPERATOR        the operator's healdesk address
 *
 * On a development machine, against a development database: the same as
 * arguments (--clinic, --contact, --clear, --requested-by, --operator), and
 * the corrected name, number and address typed at the prompt, one per line
 * (blank leaves a field as it is), never on the command line. A field is
 * cleared only when --clear names it. It prints which fields changed, never
 * their values.
 *
 *   npm run ops:amend-contact -w @healdesk/app -- --clinic <uuid> \
 *     --operator <your work address> --contact <uuid> --requested-by practice [--clear email]
 */
const ENV = {
  clinic: "HEALDESK_AMEND_CLINIC_ID",
  contact: "HEALDESK_AMEND_CONTACT_ID",
  clear: "HEALDESK_AMEND_CLEAR",
  "requested-by": "HEALDESK_AMEND_REQUESTED_BY",
  operator: "HEALDESK_OPS_OPERATOR",
};

async function main(): Promise<void> {
  const args = optionsFrom(process.argv.slice(2), process.env, ENV);
  refusePatientDataInArgs(args);
  const operator = shellOperator(args);
  const text = (name: string) => {
    const value = args.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const clinicId = text("clinic");
  if (!clinicId) throw new Error("--clinic <uuid> (HEALDESK_AMEND_CLINIC_ID) is required.");
  const clear = text("clear")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let fullName: string | undefined;
  let phone: string | undefined;
  let email: string | undefined;
  if (typedEntryAllowed()) {
    [fullName, phone, email] = await askLines(
      [
        "Corrected name (blank to leave it): ",
        "Corrected telephone number (blank to leave it): ",
        "Corrected email address (blank to leave it): ",
      ],
      { input: process.stdin, output: process.stderr },
    );
  } else if (!clear?.length) {
    throw new Error(
      "On the AWS host a correction can only clear fields (HEALDESK_AMEND_CLEAR): new values are patient data, and wait for the M5 portal, which takes them from the practice behind step-up.",
    );
  }
  const outcome = await amendContactFromShell({
    clinicId,
    contactId: text("contact"),
    fullName,
    phone,
    email,
    clear,
    requestedBy: text("requested-by"),
    operator,
  });
  if (outcome.status === "error") throw new Error(outcome.message);
  console.info(`[healdesk] corrected: ${outcome.fields.join(", ")}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(scriptFailure("amend-contact", error));
    process.exit(1);
  });
