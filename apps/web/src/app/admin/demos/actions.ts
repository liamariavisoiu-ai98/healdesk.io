"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { requireOperator } from "@/lib/admin/operator";
import { requestDemo, runDemoBuild, sendDemoEmail } from "@/lib/demo/build";
import { getDemoSession, isDemoSlug, updateDemoSession } from "@/lib/demo/sessions";

/**
 * The console's three actions on personalised demos. Each re-checks the
 * operator session itself: a server action is a public POST endpoint, and the
 * page that renders the form being guarded says nothing about who calls it.
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
  if (!session || session.status === "building") return;
  await updateDemoSession(slug, { status: "building", buildNote: null });
  after(() => runDemoBuild(slug).then(() => undefined));
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
