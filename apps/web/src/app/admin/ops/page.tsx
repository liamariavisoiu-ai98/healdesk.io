import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireOperator } from "@/lib/admin/operator";
import {
  fetchClinicHealth,
  fetchClinics,
  fetchJobs,
  issueConnectLink as issueConnectLinkUpstream,
  recordClinicTouch as recordTouchUpstream,
  toggleJob as toggleJobUpstream,
  type CareOutcome,
  type IssueLinkOutcome,
  type OpsResult,
  type ToggleJobOutcome,
} from "@/lib/admin/ops-client";

import { OpsConsole } from "./OpsConsole";

/**
 * /admin/ops, the operational console, moved here from apps/app.
 *
 * ## The guard is on this page, not on the layout above it
 *
 * A layout is not protection. It does not re-run on client navigation and it
 * never runs at all for a route handler, so a check written once in
 * `admin/layout.tsx` would be a check that a router transition can skip. The
 * same rule already governs `resolveTenantContext()` in apps/app, and it is
 * written out there for the same reason it is written out here.
 *
 * The server actions below check too, and not as a courtesy: a server action is
 * a POST endpoint that can be reached directly with nothing but its id. They do
 * it by construction rather than by remembering, because every one of them goes
 * through `ops-client`, which asks `requireOperator()` before it will sign
 * anything. There is no path from this file to apps/app that skips it.
 *
 * ## Why the two reads are settled independently
 *
 * Each crosses a network and each can fail on its own. A `Promise.all` over two
 * calls that reject would take the whole console down with the weaker of them,
 * and the section most likely to be wanted when something is wrong is the job
 * kill switch. `ops-client` returns failures as values, so this is a
 * `Promise.all` over two promises that do not reject, and each section renders
 * its own outcome.
 *
 * ## There is no team management here, and that is the point
 *
 * The console this replaces had an invite form and a member list. Staff
 * invitations went with the clinic console: there is one administrator, the
 * account model is two environment variables and an authenticator app, and
 * there is nothing to invite anybody to. `ops-client` cannot even ask for those
 * operations, which is a firmer statement than a screen that omits them.
 */

export const metadata: Metadata = {
  title: "Ops",
};

/**
 * Never cached, at any layer. `requireOperator()` reads cookies and would force
 * this dynamic anyway; saying so out loud means the guarantee does not depend
 * on noticing that side effect. A cached ops console is a console that shows an
 * operator a job as "off" while it is running.
 */
export const dynamic = "force-dynamic";

export default async function OpsPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");

  const [clinics, jobs, health] = await Promise.all([fetchClinics(), fetchJobs(), fetchClinicHealth()]);

  return (
    <OpsConsole
      clinics={clinics}
      jobs={jobs}
      health={health}
      actions={{ toggleJob, issueConnectLink, recordTouch }}
    />
  );
}

/**
 * The two acts, each a thin wrapper over `ops-client`.
 *
 * They exist for one reason the client component cannot supply: knowing which
 * path to revalidate. `ops-client` is transport and deliberately knows nothing
 * about routes; a component in the browser cannot revalidate anything. So the
 * split is transport in the library, freshness here, presentation in the client
 * component.
 *
 * Neither re-derives the operator and neither accepts one as an argument. That
 * is the whole point: the identity that lands in the audit row comes from the
 * session cookie inside `callOps`, so a POST straight at one of these action
 * ids with no cookie gets a refusal rather than an action attributed to nobody.
 */

async function toggleJob(
  name: string,
  enabled: boolean,
): Promise<OpsResult<ToggleJobOutcome>> {
  "use server";

  const result = await toggleJobUpstream(name, enabled);
  // Even on failure: the operator should see the list they are working from
  // refresh under them rather than wonder whether it moved.
  revalidatePath("/admin/ops");
  return result;
}

async function issueConnectLink(
  clinicId: string,
  recipientEmail: string | null,
): Promise<OpsResult<IssueLinkOutcome>> {
  "use server";

  const result = await issueConnectLinkUpstream(clinicId, recipientEmail);

  /**
   * So the connection tag on the card behind the control catches up.
   *
   * Safe alongside a token that exists only in this return value: the refresh
   * re-renders the server tree, and the control holding the URL is a client
   * component at a stable key in that list, so React reconciles it rather than
   * remounting it. If that ever stopped being true the link would vanish before
   * it could be copied, which is why it is written down here rather than left
   * as something the next person has to rediscover.
   */
  revalidatePath("/admin/ops");
  return result;
}

async function recordTouch(
  clinicId: string,
  input: { kind: "call" | "email" | "note"; summary: string; outcome?: string },
): Promise<OpsResult<CareOutcome>> {
  "use server";

  const result = await recordTouchUpstream(clinicId, input);
  revalidatePath("/admin/ops");
  return result;
}
