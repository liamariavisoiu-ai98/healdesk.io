import { formatReplyBy } from "../src/lib/reply-by";
import {
  optionsFrom,
  recordPatientRequestFromShell,
  refusePatientDataInArgs,
  scriptFailure,
  shellOperator,
} from "../src/lib/ops/patient-entry";

/**
 * Record a request a patient made to healdesk itself about their information
 * at a practice, and pass it to the practice: L32 to its one address, and
 * the request on its own page in the portal, behind the passkey step-up
 * (BAA 1.5.1 clause 14: "It will pass the request to Practice within five
 * business days"; docs/handover.md, "Deletion requests", step 1). Never
 * through apps/web.
 *
 * Ids and closed choices only, on every host: nothing of the patient's is
 * typed, piped or passed, so there is no prompt. On the AWS host, through
 * run-task.sh only, a one-off task of the app's image with these in its
 * environment:
 *
 *   HEALDESK_PATIENT_REQUEST_CLINIC_ID     the clinic's id
 *   HEALDESK_PATIENT_REQUEST_KIND          access | amendment | accounting |
 *                                          deletion | other
 *   HEALDESK_PATIENT_REQUEST_CONTACT_ID    optional: the contact it is about,
 *                                          when one can be named by its id
 *   HEALDESK_PATIENT_REQUEST_RECEIVED_AT   optional: when it reached us, ISO
 *   HEALDESK_OPS_OPERATOR                  the operator's healdesk address
 *
 * On a development machine, against a development database: the same as
 * arguments (--clinic, --kind, --contact, --received-at, --operator).
 *
 *   npm run ops:patient-request -w @healdesk/app -- --clinic <uuid> \
 *     --operator <your work address> --kind access [--contact <uuid>] [--received-at 2026-10-19]
 *
 * It prints the request's id, the day the practice is asked to mark it
 * received by, and what is left to do by hand, and nothing about the person.
 */
const ENV = {
  clinic: "HEALDESK_PATIENT_REQUEST_CLINIC_ID",
  kind: "HEALDESK_PATIENT_REQUEST_KIND",
  contact: "HEALDESK_PATIENT_REQUEST_CONTACT_ID",
  "received-at": "HEALDESK_PATIENT_REQUEST_RECEIVED_AT",
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
  if (!clinicId) {
    throw new Error("--clinic <uuid> (HEALDESK_PATIENT_REQUEST_CLINIC_ID) is required.");
  }
  const outcome = await recordPatientRequestFromShell({
    clinicId,
    kind: text("kind"),
    contactId: text("contact"),
    receivedAt: text("received-at"),
    operator,
  });
  if (outcome.status === "error") throw new Error(outcome.message);
  const by = formatReplyBy(outcome.replyBy);
  console.info(
    [
      `[healdesk] recorded: patient request ${outcome.requestId}, to be marked received by ${by}`,
      outcome.linked
        ? "  The practice is emailed a pointer to it (L32) and sees it on Home in its portal."
        : "  The practice sees it on Home in its portal. Its email (L32) carries no link: BETTER_AUTH_URL is not set here.",
      outcome.contactNamed
        ? "  It names the contact; the practice sees who it is behind its passkey."
        : `  It names no contact: telephone the practice on its published number by ${by} with who asked and how to reach them. Never email their details.`,
      "  Reply to the person yourself: healdesk cannot act on the request and has passed it to the practice, which will answer them.",
      `  Reminders go on the second and fourth business days while nobody marks it received; ops is told on the fourth.`,
    ].join("\n"),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(scriptFailure("patient-request", error));
    process.exit(1);
  });
