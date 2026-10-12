import {
  askLines,
  erasePersonFromShell,
  parseArgs,
  refusePatientDataInArgs,
  shellOperator,
} from "../src/lib/ops/patient-entry";

/**
 * Delete one person at a clinic, on the practice's request
 * (docs/handover.md, "Deletion requests"). Run it in the app's own shell,
 * never through apps/web:
 *
 *   npm run ops:erase-person -w @healdesk/app -- --clinic <uuid> \
 *     --operator <your work address> --requested-by practice|person_via_practice|representative_via_practice \
 *     [--received-at <ISO time the request reached us>]
 *
 * It then asks for the person's telephone number and email address (either
 * may be blank), one per line, from the terminal or piped stdin. Neither is
 * ever taken from the command line, where it would land in the shell's
 * history and the process listing. It prints the request's id, its deadline
 * and counts, and nothing about the person.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  refusePatientDataInArgs(args);
  const operator = shellOperator(args);
  const clinicId = args.get("clinic");
  if (typeof clinicId !== "string") throw new Error("--clinic <uuid> is required.");
  const requestedBy = args.get("requested-by");
  const receivedAt = args.get("received-at");

  const [phone, email] = await askLines(
    [
      "The person's telephone number (blank if none): ",
      "The person's email address (blank if none): ",
    ],
    { input: process.stdin, output: process.stderr },
  );
  const outcome = await erasePersonFromShell({
    clinicId,
    phone,
    email,
    requestedBy: typeof requestedBy === "string" ? requestedBy : undefined,
    receivedAt: typeof receivedAt === "string" ? receivedAt : undefined,
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
