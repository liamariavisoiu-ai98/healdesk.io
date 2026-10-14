import { audienceFor, type Channel } from "@healdesk/catalog";

import type { ActorContext } from "@/lib/audit";
import { loadSetupState, type SetupState } from "@/lib/setup/state";

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
 * Business data only: the practice, its settings and its channels. Nothing
 * here reads a patient.
 */
export type PortalPage = {
  actor: PortalActor;
  actorContext: ActorContext;
  state: SetupState;
  locations: PortalGrant[];
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
  return { actor, actorContext, state, locations };
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
  liveChannels: Channel[];
  timeZone: string;
  locations: PortalGrant[];
} {
  return {
    slug: portal.clinicSlug,
    clinicName: page.state.clinic.name,
    section,
    audience: audienceFor(page.state.clinic.specialty),
    status: answeringStatus(page.state.channels),
    liveChannels: page.state.channels.filter((c) => c.liveAt !== null).map((c) => c.channel),
    timeZone: page.state.clinic.timezone,
    locations: page.locations,
  };
}
