"use server";

import { revalidatePath } from "next/cache";

import { unsafeDb } from "@/db";
import { recordSecurityEvent } from "@/lib/audit";
import { setJobEnabled } from "@/lib/scheduler/jobs";
import { requestMeta, requireSession } from "@/lib/session";

/**
 * Ops actions.
 *
 * Every one re-checks the session itself. The proxy redirect is a convenience
 * for browsers, not a security boundary — a server action is a POST endpoint
 * that can be reached directly.
 */

export async function toggleJob(formData: FormData): Promise<void> {
  const session = await requireSession();

  const name = String(formData.get("name") ?? "");
  const enabled = String(formData.get("enabled") ?? "") === "true";
  if (!name) throw new Error("Missing job name.");

  await setJobEnabled(name, enabled, session.userId);

  // Enabling a job that mails customers is exactly the kind of act that needs
  // an answer to "who turned this on, and when".
  const meta = await requestMeta();
  await recordSecurityEvent(unsafeDb, {
    event: enabled ? "job_enabled" : "job_disabled",
    actorLabel: session.email,
    userId: session.userId,
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent ?? null,
    metadata: { job: name },
  });

  revalidatePath("/");
}
