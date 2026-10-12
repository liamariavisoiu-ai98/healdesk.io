import {
  askLines,
  erasePersonFromShell,
  optionsFrom,
  refusePatientDataInArgs,
  shellOperator,
  typedEntryAllowed,
} from "../src/lib/ops/patient-entry";

/**
 * Delete one person at a clinic, on the practice's request
 * (docs/handover.md, "Deletion requests"). Never through apps/web.
 *
 * On the AWS host: by contact id, through run-task.sh only. A one-off task
 * of the app's image, with these in its environment and nothing else about
 * the person:
 *
 *   HEALDESK_ERASURE_CLINIC_ID     the clinic's id
 *   HEALDESK_ERASURE_CONTACT_ID    a contact of the person's: the one-step
 *                                  rule runs from its number and address,
 *                                  read inside the transaction
 *   HEALDESK_ERASURE_REQUESTED_BY  practice | person_via_practice |
 *                                  representative_via_practice
 *   HEALDESK_ERASURE_RECEIVED_AT   optional: when the request reached us, ISO
 *   HEALDESK_OPS_OPERATOR          the operator's healdesk address
 *
 * On a development machine, against a development database: the same as
 * arguments (--clinic, --contact, --requested-by, --received-at, --operator),
 * or, without --contact, the number and the address typed at the prompt, one
 * per line (either may be blank), never on the command line. The prompt is
 * refused where NODE_ENV is production, as it is in the image.
 *
 *   npm run ops:erase-person -w @healdesk/app -- --clinic <uuid> \
 *     --operator <your work address> --requested-by practice [--contact <uuid>]
 *
 * It prints the request's id, its deadline and counts, and nothing about the
 * person.
 */
const ENV = {
  clinic: "HEALDESK_ERASURE_CLINIC_ID",
  contact: "HEALDESK_ERASURE_CONTACT_ID",
  "requested-by": "HEALDESK_ERASURE_REQUESTED_BY",
  "received-at": "HEALDESK_ERASURE_RECEIVED_AT",
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
  if (!clinicId) throw new Error("--clinic <uuid> (HEALDESK_ERASURE_CLINIC_ID) is required.");
  const contactId = text("contact");

  let phone: string | undefined;
  let email: string | undefined;
  if (!contactId) {
    if (!typedEntryAllowed()) {
      throw new Error(
        "On the AWS host the person is named by a contact's id only (HEALDESK_ERASURE_CONTACT_ID), through run-task.sh: nothing about a patient is typed or passed there.",
      );
    }
    [phone, email] = await askLines(
      [
        "The person's telephone number (blank if none): ",
        "The person's email address (blank if none): ",
      ],
      { input: process.stdin, output: process.stderr },
    );
  }
  const outcome = await erasePersonFromShell({
    clinicId,
    contactId,
    phone,
    email,
    requestedBy: text("requested-by"),
    receivedAt: text("received-at"),
    operator,
  });
  if (outcome.status === "error") throw new Error(outcome.message);
  console.info(
    [
      `[healdesk] erased: request ${outcome.erasureId}, ${outcome.rows} rows, due by ${outcome.dueBy}`,
      `  numbers ${outcome.identifiers.phones}, addresses ${outcome.identifiers.emails} (those given, and every one on a contact they matched)`,
      outcome.kept.sharedThreads
        ? `  kept for someone else: ${outcome.kept.requests} booking request(s) and ${outcome.kept.drafts} draft(s) on ${outcome.kept.sharedThreads} shared thread(s); tell the practice`
        : "  nothing kept for anyone else",
      "  Next: each subcontractor step on the care page, by the deadline.",
    ].join("\n"),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(
      `[healdesk] erase-person failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
