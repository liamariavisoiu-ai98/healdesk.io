"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { requireOperator } from "@/lib/admin/operator";
import { releaseHeldDemo, requestDemo, runDemoBuild, sendDemoEmail } from "@/lib/demo/build";
import { getDemoSession, isDemoBuildStalled, isDemoSlug, updateDemoSession } from "@/lib/demo/sessions";
import { retryStalledDemo, retryStalledDemos, runRetriedBuilds } from "@/lib/demo/sweep";

/**
 * The console's actions on personalised demos. Each re-checks the operator
 * session itself: a server action is a public POST endpoint, and the page
 * that renders the form being guarded says nothing about who calls it.
 */

export type CreateDemoState =
  | { status: "idle" }
  | { status: "error"; field?: string; error: string }
  | { status: "created"; slug: string; url: string; clinicName: string };

export async function createDemoAction(_prev: CreateDemoState, form: FormData): Promise<CreateDemoState> {
  const operator = await requireOperator();
  if (!operator) return { status: "error", error: "Your session has ended. Sign in again." };

  const sendEmail = form.get("sendEmail") === "on";
  let result;
  try {
    result = await requestDemo({
      clinicName: String(form.get("clinicName") ?? ""),
      websiteUrl: String(form.get("websiteUrl") ?? ""),
      leadEmail: String(form.get("leadEmail") ?? ""),
      phone: String(form.get("phone") ?? ""),
      niche: String(form.get("niche") ?? ""),
      sendEmail,
      createdBy: operator,
    });
  } catch (error) {
    return {
      status: "error",
      error: `The demo register is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!result.ok) return { status: "error", field: result.field, error: result.error };

  const { session, url } = result;
  // The scrape and the structuring run after this action returns; the page's
  // maxDuration bounds them, and the list refreshes itself while it waits.
  after(() => runDemoBuild(session.slug, { sendEmail }).then(() => undefined));
  revalidatePath("/admin/demos");
  return { status: "created", slug: session.slug, url, clinicName: session.clinicName };
}

export async function retryDemoAction(form: FormData): Promise<void> {
  if (!(await requireOperator())) return;
  const slug = form.get("slug");
  if (!isDemoSlug(slug)) return;
  const session = await getDemoSession(slug, { fresh: true });
  if (!session) return;
  // A build or audit in flight is left alone, unless it has outlived the
  // route that ran it (cut off at 300 s) and will never finish.
  const running = session.status === "building" || session.status === "auditing";
  if (running && !isDemoBuildStalled(session)) return;
  // A stalled build started again counts as a retry (lib/demo/sweep.ts), so
  // the sweep's "once, then a person" holds across hand and timer alike; a
  // rebuild of a finished demo is not a retry.
  const marked = isDemoBuildStalled(session)
    ? await retryStalledDemo(session)
    : await updateDemoSession(slug, { status: "building", buildNote: null, buildStartedAt: new Date() });
  // Null means the row is gone, or the sweep or another press got to it
  // between the read above and the write: its build is already running, and
  // a second one must not start.
  if (!marked) return;
  after(() => runDemoBuild(slug).then(() => undefined));
  revalidatePath("/admin/demos");
}

/**
 * "Retry all stalled", from the pipeline strip: every stalled build started
 * again, whatever its count, and run after this returns. Idempotent: a
 * retry sets a fresh clock, so a second press finds nothing stalled and
 * changes nothing. A row that is building, ready, held or failed is never
 * touched (lib/demo/sweep.ts).
 */
export async function retryStalledDemosAction(): Promise<void> {
  if (!(await requireOperator())) return;
  const retried = (await retryStalledDemos()).map((s) => s.slug);
  if (retried.length > 0) after(() => runRetriedBuilds(retried));
  revalidatePath("/admin/demos");
}

/**
 * Ship a held demo anyway. The operator has read the audit's findings and
 * decided; the row records who released it, and the email the request asked
 * for goes now.
 */
export async function releaseDemoAction(form: FormData): Promise<void> {
  const operator = await requireOperator();
  if (!operator) return;
  const slug = form.get("slug");
  if (!isDemoSlug(slug)) return;
  await releaseHeldDemo(slug, operator);
  revalidatePath("/admin/demos");
}

export async function emailDemoAction(form: FormData): Promise<void> {
  if (!(await requireOperator())) return;
  const slug = form.get("slug");
  if (!isDemoSlug(slug)) return;
  const session = await getDemoSession(slug, { fresh: true });
  if (!session) return;
  await sendDemoEmail(session);
  revalidatePath("/admin/demos");
}
