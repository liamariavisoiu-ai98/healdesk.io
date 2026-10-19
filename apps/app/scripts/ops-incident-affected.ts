import { recordAffectedFromShell } from "../src/lib/incidents/affected-entry";
import {
  optionsFrom,
  refusePatientDataInArgs,
  scriptFailure,
  shellOperator,
} from "../src/lib/ops/patient-entry";

/**
 * Record who an incident affected, for the practice to read on the
 * incident's page behind its passkey step-up (plan Annex X5, L29: the list
 * of individuals is never emailed; lib/incidents/affected.ts). Never through
 * apps/web. By ids only, everywhere: nothing about a person is typed or
 * passed, so there is no prompt.
 *
 * On the AWS host: through run-task.sh only, as a one-off task of the app's
 * image with these in its environment and nothing else:
 *
 *   HEALDESK_INCIDENT_CLINIC_ID    the clinic's id
 *   HEALDESK_INCIDENT_ID           the incident's id, from /admin/incidents
 *   HEALDESK_INCIDENT_CONTACT_IDS  the contacts' ids, comma-separated, at most
 *                                  1,000 a run
 *   HEALDESK_INCIDENT_ACTION       optional: add (the default), or remove for
 *                                  a contact named in error
 *   HEALDESK_OPS_OPERATOR          the operator's healdesk address
 *
 * The task is `ops_script["incident-affected"]` in infra/aws/ecs.tf, mirroring
 * erase-person's: DATABASE_URL (the runtime role) as its one secret,
 * NODE_ENV=production and no task role, logging to
 * /healdesk/production/incident-affected. Run it with
 * `bash infra/aws/scripts/run-task.sh incident-affected <clinic id>
 * <incident id> <contact ids> <you@healdesk.io> [add|remove]`, which takes at
 * most 150 contacts a run (ECS's 8,192 characters of overrides).
 *
 * On a development machine, against a development database, the same as
 * arguments:
 *
 *   npm run ops:incident-affected -w @healdesk/app -- --clinic <uuid> \
 *     --incident <uuid> --contacts <uuid,uuid> --operator <your work address> \
 *     [--action remove]
 *
 * It prints counts, and nothing about anyone.
 */
const ENV = {
  clinic: "HEALDESK_INCIDENT_CLINIC_ID",
  incident: "HEALDESK_INCIDENT_ID",
  contacts: "HEALDESK_INCIDENT_CONTACT_IDS",
  action: "HEALDESK_INCIDENT_ACTION",
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
  const outcome = await recordAffectedFromShell({
    clinicId: text("clinic"),
    incidentId: text("incident"),
    contactIds: text("contacts"),
    action: text("action"),
    operator,
  });
  if (outcome.status === "error") throw new Error(outcome.message);
  console.info(
    [
      `[healdesk] incident's affected list: ${outcome.action === "add" ? "added" : "removed"} ${outcome.changed}, unchanged ${outcome.unchanged}, ${outcome.total} on it now`,
      "  The practice reads it on the incident's page in its portal, behind its passkey, once a report has gone.",
    ].join("\n"),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(scriptFailure("incident-affected", error));
    process.exit(1);
  });
