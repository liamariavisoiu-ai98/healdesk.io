import {
  amendRecordFromShell,
  askLines,
  optionsFrom,
  refusePatientDataInArgs,
  scriptFailure,
  shellOperator,
  typedEntryAllowed,
} from "../src/lib/ops/patient-entry";

/**
 * Append the practice's amendment to a booking request, a conversation or
 * an appointment (docs/handover.md, "Amendments"). Never through apps/web.
 *
 * On the AWS host: not available. An amendment's words are patient data, so
 * they may not be typed there (no ECS Exec, no stdin for a one-off task) nor
 * passed in run-task's overrides (CloudTrail records them). On AWS an
 * amendment waits for the M5 portal, which takes it from the practice
 * behind step-up. This script refuses where NODE_ENV is production, as it is
 * in the image.
 *
 * On a development machine, against a development database:
 *
 *   npm run ops:amend-record -w @healdesk/app -- --clinic <uuid> \
 *     --operator <your work address> --kind booking_request|conversation|appointment \
 *     --record <its id> --requested-by practice|person_via_practice|representative_via_practice \
 *     [--requested-at <ISO time the practice asked>]
 *
 * It then asks for the amendment's words, one line, from the terminal or
 * piped stdin, never the command line. It prints the amendment's id and when
 * it was appended, and nothing it says.
 */
async function main(): Promise<void> {
  if (!typedEntryAllowed()) {
    throw new Error(
      "On the AWS host an amendment's words are not taken: they are patient data, and wait for the M5 portal, which takes them from the practice behind step-up.",
    );
  }
  const args = optionsFrom(process.argv.slice(2), process.env, {});
  refusePatientDataInArgs(args);
  const operator = shellOperator(args);
  const text = (name: string) => {
    const value = args.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const clinicId = text("clinic");
  if (!clinicId) throw new Error("--clinic <uuid> is required.");

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
    console.error(scriptFailure("amend-record", error));
    process.exit(1);
  });
