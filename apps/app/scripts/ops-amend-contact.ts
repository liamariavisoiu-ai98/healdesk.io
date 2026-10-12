import {
  amendContactFromShell,
  askLines,
  parseArgs,
  refusePatientDataInArgs,
  shellOperator,
} from "../src/lib/ops/patient-entry";

/**
 * Correct a contact's name, number or address in place, or clear one, on
 * the practice's direction (docs/handover.md, "Amendments"). Run it in the
 * app's own shell, never through apps/web:
 *
 *   npm run ops:amend-contact -w @healdesk/app -- --clinic <uuid> \
 *     --operator <your work address> --contact <its id, from the patient's export> \
 *     --requested-by practice|person_via_practice|representative_via_practice \
 *     [--clear fullName,phone,email]
 *
 * It then asks for the corrected name, telephone number and email address,
 * one per line (blank leaves a field as it is), from the terminal or piped
 * stdin, never the command line. A field is cleared only when --clear names
 * it. It prints which fields changed, never their values.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  refusePatientDataInArgs(args);
  const operator = shellOperator(args);
  const clinicId = args.get("clinic");
  if (typeof clinicId !== "string") throw new Error("--clinic <uuid> is required.");
  const text = (name: string) => {
    const value = args.get(name);
    return typeof value === "string" ? value : undefined;
  };

  const [fullName, phone, email] = await askLines(
    [
      "Corrected name (blank to leave it): ",
      "Corrected telephone number (blank to leave it): ",
      "Corrected email address (blank to leave it): ",
    ],
    { input: process.stdin, output: process.stderr },
  );
  const outcome = await amendContactFromShell({
    clinicId,
    contactId: text("contact"),
    fullName,
    phone,
    email,
    clear: text("clear")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    requestedBy: text("requested-by"),
    operator,
  });
  if (outcome.status === "error") throw new Error(outcome.message);
  console.info(`[healdesk] corrected: ${outcome.fields.join(", ")}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(
      `[healdesk] amend-contact failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
