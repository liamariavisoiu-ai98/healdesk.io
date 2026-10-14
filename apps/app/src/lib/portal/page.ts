import { audienceFor } from "@healdesk/catalog";
import { sql } from "drizzle-orm";

import type { ActorContext } from "@/lib/audit";
import { loadSetupState, type SetupState } from "@/lib/setup/state";
import { withTenant } from "@/lib/tenant";

import { portalGrants, type PortalContext, type PortalGrant } from "./access";
import { portalActor, type PortalActor } from "./actor";
import { answeringStatus, type AnsweringStatus } from "./header";
import type { PortalSection } from "./nav";

/**
 * What every portal screen reads before its own data: who is acting (the
 * device whose passkey is live, or the sign-in), the clinic's setup state,
 * and the locations this sign-in opens, for the shell. The page calls
 * requirePortal(slug) itself first and passes the context in, so the guard is
 * visible in every page file.
 *
 * Business data only: the practice, its settings and its channels, and
 * whether a patient screen has anything to show. Nothing here reads a
 * patient.
 */
export type PortalPage = {
  actor: PortalActor;
  actorContext: ActorContext;
  state: SetupState;
  locations: PortalGrant[];
  /** The patient screens the menu links to (openPatientScreens). */
  opened: PortalSection[];
};

export async function loadPortalPage(
  portal: PortalContext,
  now: Date = new Date(),
): Promise<PortalPage | null> {
  const actor = await portalActor(portal);
  const actorContext: ActorContext = { type: "user", userId: portal.userId, label: actor.label };
  const state = await loadSetupState({
    clinicId: portal.clinicId,
    userId: portal.userId,
    actor: actorContext,
    now,
  });
  if (!state) return null;
  const locations = await portalGrants(portal.userId);
  const opened = await openPatientScreens(portal.clinicId, actorContext, state);
  return { actor, actorContext, state, locations, opened };
}

/**
 * Which patient screens the menu links to: each once a channel has gone
 * live, or once there is something for it to show. Conversations: a call,
 * a web chat or a Meta thread. Whether one exists, never what it says.
 */
export async function openPatientScreens(
  clinicId: string,
  actor: ActorContext,
  state: Pick<SetupState, "channels">,
): Promise<PortalSection[]> {
  if (state.channels.some((c) => c.liveAt !== null)) return ["conversations"];
  const any = await withTenant({ clinicId, actor }, async (tx) => {
    const found = await tx.db.execute<{ any: boolean }>(
      sql`select exists (select 1 from conversations where clinic_id = ${clinicId}::uuid)
              or exists (select 1 from chat_threads where clinic_id = ${clinicId}::uuid
                           and channel in ('messenger', 'instagram', 'whatsapp')) as any`,
    );
    return found.rows[0]?.any === true;
  });
  return any ? ["conversations"] : [];
}

/** The shell's props for a screen, from what loadPortalPage read. */
export function shellProps(
  portal: PortalContext,
  page: PortalPage,
  section: PortalSection,
): {
  slug: string;
  clinicName: string;
  section: PortalSection;
  audience: "patients" | "clients";
  status: AnsweringStatus;
  timeZone: string;
  locations: PortalGrant[];
  opened: PortalSection[];
} {
  return {
    slug: portal.clinicSlug,
    clinicName: page.state.clinic.name,
    section,
    audience: audienceFor(page.state.clinic.specialty),
    status: answeringStatus(page.state.channels),
    timeZone: page.state.clinic.timezone,
    locations: page.locations,
    opened: page.opened,
  };
}
