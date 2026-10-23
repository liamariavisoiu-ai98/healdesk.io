import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { InboxList } from "@/components/admin/InboxList";
import { loadOpsInbox } from "@/lib/admin/inbox";
import { runInboxOp } from "@/lib/admin/inbox-ops";
import { requireOperator } from "@/lib/admin/operator";
import type { InboxButton } from "@/lib/admin/strip-types";

/**
 * /admin, Home: what needs me today, in order (E1 §2). One list, nothing
 * else: each row a count, one sentence, the clinic when there is one, and
 * one button. Ordered by deadline, then severity. The commit feed that was
 * here until 23 October 2026 is System › Changes (owner, D11).
 *
 * The list is lib/admin/inbox.ts: lane A2's `opsInbox` from apps/app once it
 * lands, composed here from the queues, the blocked clinics and the
 * first-weeks flags until then, with any read that failed named above the
 * list. The op button runs through lib/admin/inbox-ops.ts, a closed switch
 * over typed ops-client calls with ids checked first; the operator identity
 * comes from the session cookie inside ops-client, never from this page.
 *
 * The guard is on this page: a layout is not a security boundary.
 */

export const metadata: Metadata = { title: "Home" };
export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const inbox = await loadOpsInbox();

  async function run(button: Extract<InboxButton, { kind: "op" }>) {
    "use server";
    if (!(await requireOperator())) return { ok: false as const, code: "unauthenticated" as const, message: "Your session has ended. Sign in again." };
    const result = await runInboxOp(button);
    revalidatePath("/admin");
    return result;
  }

  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">What needs you today</h1>
      <InboxList inbox={inbox} run={run} />
    </main>
  );
}
