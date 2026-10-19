import { unsafeDb } from "@/db";
import { recordSecurityEvent } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import type { ShellOperator } from "@/lib/ops/patient-entry";
import { withTenant } from "@/lib/tenant";

import { AffectedListError, changeAffectedContacts, UUID } from "./affected";

/**
 * Who an incident affected, recorded by the operator from the app's own
 * shell (`npm run ops:incident-affected -w @healdesk/app`), as the
 * patient-rights scripts are (lib/ops/patient-entry.ts): never through
 * apps/web, which has no business associate agreement behind it. By ids
 * only, on the AWS host as everywhere: a clinic, an incident and the
 * contacts, each a uuid, which carry nothing about a person. The incident's
 * page in the portal is where the practice then reads who they are
 * (lib/portal/incidents.ts).
 *
 * Returns counts, and writes the same audit row inside the tenant and a
 * security event naming the operator, as the shell's other entries do.
 */

/** The most contacts one run names: a list longer than this goes in more than one run. */
export const MAX_CONTACTS_PER_RUN = 1000;

export type ShellAffectedOutcome =
  | {
      status: "recorded";
      action: "add" | "remove";
      /** Contacts put on the list, or taken off it. */
      changed: number;
      /** Already on it, or not on it: nothing changed for them. */
      unchanged: number;
      /** How many the list names now. */
      total: number;
    }
  | { status: "error"; message: string };

export async function recordAffectedFromShell(input: {
  clinicId: string | undefined;
  incidentId: string | undefined;
  /** Comma- or space-separated contact ids. */
  contactIds: string | undefined;
  action?: string;
  operator: ShellOperator;
}): Promise<ShellAffectedOutcome> {
  const error = (message: string): ShellAffectedOutcome => ({ status: "error", message });
  const action = input.action === undefined || input.action === "" ? "add" : input.action;
  if (action !== "add" && action !== "remove") return error("--action is add or remove.");
  if (!input.clinicId || !UUID.test(input.clinicId)) return error("--clinic <uuid> is required.");
  if (!input.incidentId || !UUID.test(input.incidentId)) {
    return error("--incident <uuid> is required: the incident's id from /admin/incidents.");
  }
  const ids = (input.contactIds ?? "").split(/[\s,]+/).filter(Boolean);
  if (ids.length === 0) {
    return error("--contacts <uuid,uuid,...> is required: each person by a contact's id.");
  }
  if (!ids.every((id) => UUID.test(id))) {
    return error(
      "Each contact is named by its id, a uuid: nothing else about a person is taken here.",
    );
  }
  if (ids.length > MAX_CONTACTS_PER_RUN) {
    return error(`At most ${MAX_CONTACTS_PER_RUN} contacts a run: record the rest in another.`);
  }
  const clinic = (await listClinics()).find((c) => c.id === input.clinicId);
  if (!clinic) return error("No such clinic.");
  if (clinic.destroyedAt) {
    return error("This clinic's data has been destroyed: healdesk holds no one to list.");
  }

  let result: Awaited<ReturnType<typeof changeAffectedContacts>>;
  try {
    result = await withTenant(
      { clinicId: clinic.id, actor: { type: "service", serviceName: input.operator.label } },
      (tx) =>
        changeAffectedContacts(tx, {
          incidentId: input.incidentId!,
          contactIds: ids,
          action,
          recordedBy: input.operator.label,
        }),
    );
  } catch (thrown) {
    if (thrown instanceof AffectedListError) return error(thrown.message);
    throw thrown;
  }
  const changed = result.changed;
  log.info("incident affected list changed", {
    clinicId: clinic.id,
    incidentId: input.incidentId,
    count: changed,
  });
  try {
    await recordSecurityEvent(unsafeDb, {
      event: action === "add" ? "incident_affected_recorded" : "incident_affected_removed",
      actorLabel: input.operator.label,
      userId: null,
      organizationId: null,
      ipAddress: null,
      userAgent: "ops-shell",
      metadata: {
        clinicSlug: clinic.slug,
        incidentId: input.incidentId,
        changed,
        total: result.total,
      },
    });
  } catch (thrown) {
    log.error("ops shell: could not record event", {
      event: "incident_affected",
      error: describeError(thrown),
    });
  }
  return { status: "recorded", action, changed, unchanged: result.unchanged, total: result.total };
}
