import {
  amendRecordFromShell,
  askLines,
  parseArgs,
  refusePatientDataInArgs,
  shellOperator,
} from "../src/lib/ops/patient-entry";

/**
 * Append the practice's amendment to a booking request, a conversation or
 * an appointment (docs/handover.md, "Amendments"). Run it in the app's own
 * shell, never through apps/web:
 *
 *   npm run ops:amend-record -w @healdesk/app -- --clinic <uuid> \
 *     --operator <your work address> --kind booking_request|conversation|appointment \
 *     --record <its id, from the patient's export> \
 *     --requested-by practice|person_via_practice|representative_via_practice \
 *     [--requested-at <ISO time the practice asked>]
 *
 * It then asks for the amendment's words, one line, from the terminal or
 * piped stdin, never the command line. It prints the amendment's id and when
 * it was appended, and nothing it says.
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

  const [amendment] = await askLines(["The amendment, as the practice directed it (one line): "], {
    input: process.stdin,
    output: process.stderr,
  });
  const outcome = await amendRecordFromShell({
    clinicId,
    targetKind: text("kind"),
    targetId: text("record"),
    amendment,
    requestedBy: text("requested-by"),
    requestedAt: text("requested-at"),
    operator,
  });
  if (outcome.status === "error") throw new Error(outcome.message);
  console.info(
    `[healdesk] amended: amendment ${outcome.amendmentId}, appended ${outcome.recordedAt}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(
      `[healdesk] amend-record failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
