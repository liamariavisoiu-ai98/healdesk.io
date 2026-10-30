import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { Section } from "@/components/admin/ui";
import { requireOperator } from "@/lib/admin/operator";
import { listDemoCallbacks, markDemoCallbackCalled } from "@/lib/demo/callbacks";
import { demoUrl } from "@/lib/demo/sessions";
import { POLICY } from "@/lib/legal";
import type { DemoCallbackRow } from "@/lib/sheets/schema";
import { isMarketingStoreConfigured } from "@/lib/sheets/client";

/**
 * Queues › Demo call backs: the clinic owners who asked Aya, on a demo call,
 * for someone from the team to ring them (lib/demo/callbacks.ts; owner,
 * 26 October 2026). Each was promised a call on the number shown, about the
 * line shown, and nothing else. "Called" deletes the row, number and all,
 * which is what the Privacy page promises; one nobody marks is deleted after
 * POLICY.demoCallbackRetentionDays by the daily purge.
 *
 * Sheet-backed, so it shows while the AWS host is in standby. A plain form
 * posting to a server action that redirects back with `?callback=`, as the
 * setup requests do; the action checks the operator itself.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESULTS: Record<string, string> = {
  called: "Marked called. The number is deleted.",
  not_found: "That call back is already gone.",
};

async function markCalled(formData: FormData): Promise<void> {
  "use server";
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const id = String(formData.get("id") ?? "");
  const found = UUID.test(id) && (await markDemoCallbackCalled(id));
  revalidatePath("/admin/queues");
  redirect(`/admin/queues?callback=${found ? "called" : "not_found"}#demo-callbacks`);
}

/** "26 Oct, 09:14", New York time, where the demos call from. */
function when(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

/** "+15125550147" as "+1 512 555 0147", for dialling by eye. */
function dialable(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

export default async function DemoCallbacksSection({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { result } = await searchParams;
  const now = new Date();

  if (!isMarketingStoreConfigured()) {
    return (
      <Section id="demo-callbacks" title="Demo call backs">
        <p className="text-muted max-w-[60ch] text-sm">No lead register is configured, so call backs are not being kept.</p>
      </Section>
    );
  }

  let callbacks: DemoCallbackRow[] = [];
  let loadError: string | null = null;
  try {
    callbacks = await listDemoCallbacks();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <Section id="demo-callbacks" title={`Demo call backs${loadError ? "" : ` (${callbacks.length})`}`}>
      <p className="text-muted text-sm">
        Asked for on a demo call. Call each on the number shown, about what is shown, and nothing else; then mark it
        called. Unmarked ones are deleted after {POLICY.demoCallbackRetentionDays} days.
      </p>

      {result && RESULTS[result] ? (
        <p className="border-line mt-3 rounded-sm border bg-white px-4 py-3 text-sm font-semibold" role="status">
          {RESULTS[result]}
        </p>
      ) : null}

      {loadError ? (
        <p role="status" className="text-red-deep mt-4 text-sm font-semibold">
          Could not read the call backs: {loadError}
        </p>
      ) : callbacks.length === 0 ? (
        <p className="text-muted mt-4 text-sm">None waiting.</p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {callbacks.map((callback) => (
            <li key={callback.id} className="border-line rounded-md border bg-white p-5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-lg font-bold">
                  {callback.firstName || "Someone"} at {callback.clinicName || "a clinic"}
                </span>
                <span className="text-muted text-sm">asked {when(callback.requestedAt)}</span>
                {callback.test ? <span className="text-sm font-semibold">Test call</span> : null}
              </div>
              <p className="mt-1 text-sm break-words">
                <a className="font-semibold underline underline-offset-2" href={`tel:${callback.phoneE164}`}>
                  {dialable(callback.phoneE164)}
                </a>
                {" · "}
                {callback.topic || "nothing said about what to discuss"}
                {" · "}
                <a className="underline underline-offset-2" href={demoUrl(callback.slug)}>
                  their demo
                </a>
                {callback.offerEndsAt && callback.offerEndsAt.getTime() > now.getTime() ? ` · discount ends ${when(callback.offerEndsAt)}` : ""}
              </p>
              <form action={markCalled} className="mt-4">
                <input type="hidden" name="id" value={callback.id} />
                <button type="submit" className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white">
                  Called
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
