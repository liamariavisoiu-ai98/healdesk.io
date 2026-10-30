import { getPlan } from "@healdesk/catalog";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { Section } from "@/components/admin/ui";
import { requireOperator } from "@/lib/admin/operator";
import { checkoutMode, setupLinksOpen } from "@/lib/checkout-mode";
import { packagesByRef, recordsConfigured, type ChosenPackage } from "@/lib/checkout/records";
import { channelList } from "@/lib/email/setup-emails";
import { declineSetupRequest, sendSetupLink } from "@/lib/setup-links";
import { listSetupRequests } from "@/lib/setup-requests";
import type { SetupRequest } from "@/lib/sheets/schema";
import { isMarketingStoreConfigured } from "@/lib/sheets/client";

/**
 * Queues › Setup requests: the "Tell us about your clinic" requests, and
 * their setup links. Until the admin redesign (23 October 2026) this was
 * /admin/setup, which redirects here.
 *
 * ## The job this does
 *
 * Every request was promised a reply by the next business day (P2), so this
 * is a queue to empty daily. Each row shows what the clinic asked for and how
 * far its link has got: sent, opened, the package chosen, signed, paid. The
 * package is read from the purchase record its latest press of Pay left in
 * the Sheet (lib/checkout/records.ts), whose ref is the request's id. The
 * actions are the three an operator needs: send the link, send a new one
 * (which stops the old one working), or decline.
 *
 * ## Why "Send" can be refused
 *
 * A setup link promises the purchase the plan describes, and until the launch
 * checklist is done (Gate A) the checkout cannot honour it. Production
 * refuses to send until `HEALDESK_SETUP_LINKS=open` (lib/checkout-mode.ts),
 * and the section says so above the queue rather than letting the button fail.
 *
 * ## No JavaScript, on purpose
 *
 * Plain forms posting to server actions that redirect back with the outcome
 * in `?setup=`, the same way sign-out works. Each action checks the operator
 * itself: the layout is not a security boundary.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESULTS: Record<string, string> = {
  sent: "Setup link sent.",
  declined: "Request declined. No email was sent; reply in person if one is due.",
  closed:
    "Setup links are closed. They open with HEALDESK_SETUP_LINKS=open, once the launch checklist (Gate A) is complete.",
  not_found: "That request no longer exists.",
  paid: "That clinic has already bought.",
  unsubscribed: "They unsubscribed from these emails. Reply to them by hand instead.",
  unsigned: "This deployment can't sign setup links: HEALDESK_GATE_SECRET is missing.",
  email_failed: "The link was saved but the email didn't send. Check Resend, then send a new link.",
};

async function sendLink(formData: FormData): Promise<void> {
  "use server";
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const id = String(formData.get("id") ?? "");
  const outcome = UUID.test(id) ? await sendSetupLink(id) : ({ ok: false, reason: "not_found" } as const);
  revalidatePath("/admin/queues");
  redirect(`/admin/queues?setup=${outcome.ok ? "sent" : outcome.reason}#setup-requests`);
}

async function decline(formData: FormData): Promise<void> {
  "use server";
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const id = String(formData.get("id") ?? "");
  const found = UUID.test(id) && (await declineSetupRequest(id));
  revalidatePath("/admin/queues");
  redirect(`/admin/queues?setup=${found ? "declined" : "not_found"}#setup-requests`);
}

/** "6 Oct, 14:07", New York time, where the requests come from. */
function when(date: Date | null): string {
  if (!date) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** "AYA Voice + Web Chat, 500 minutes and 300 conversations, monthly", or the plan id when the catalog no longer has it. */
function packageLine(chosen: ChosenPackage): string {
  const name = getPlan(chosen.plan)?.name ?? chosen.plan;
  const period = chosen.billingInterval === "year" ? "annual" : chosen.billingInterval === "month" ? "monthly" : null;
  return `Package: ${name}${period ? `, ${period}` : ""}`;
}

function progress(request: SetupRequest, now: Date, chosen?: ChosenPackage): string[] {
  const steps: string[] = [];
  if (request.invitedAt) {
    const expired = request.linkExpiresAt && request.linkExpiresAt.getTime() <= now.getTime();
    steps.push(
      `Link sent ${when(request.invitedAt)}${
        request.linkExpiresAt ? (expired ? " (expired)" : ` · works until ${when(request.linkExpiresAt)}`) : ""
      }`,
    );
  }
  if (request.remindedAt) steps.push(`Reminded ${when(request.remindedAt)}`);
  if (request.openedAt) steps.push(`Opened ${when(request.openedAt)}`);
  if (chosen) steps.push(packageLine(chosen));
  if (request.signedAt) steps.push(`Signed ${when(request.signedAt)}`);
  if (request.paidAt) steps.push(`Paid ${when(request.paidAt)}`);
  if (request.unsubscribedAt) steps.push(`Unsubscribed ${when(request.unsubscribedAt)}`);
  if (request.status === "declined") steps.push("Declined");
  return steps;
}

export default async function SetupRequestsSection({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { result } = await searchParams;
  const now = new Date();

  if (!isMarketingStoreConfigured()) {
    return (
      <Section id="setup-requests" title="Setup requests">
        <p className="text-muted max-w-[60ch] text-sm">
          No lead register is configured, so requests are not being kept. Set{" "}
          <code className="font-mono">MARKETING_SHEET_ID</code> and{" "}
          <code className="font-mono">GOOGLE_SERVICE_ACCOUNT_JSON</code>. See .env.example.
        </p>
      </Section>
    );
  }

  let requests: SetupRequest[] = [];
  let loadError: string | null = null;
  try {
    requests = await listSetupRequests(200);
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  // The packages chosen: progress, never a reason the queue cannot be read.
  let packages = new Map<string, ChosenPackage>();
  if (!loadError && requests.length > 0 && recordsConfigured()) {
    try {
      packages = await packagesByRef(requests.map((r) => r.id));
    } catch (error) {
      console.error("[healdesk] queues: setup requests could not read the purchase records", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const open = setupLinksOpen();
  const mode = checkoutMode();
  const waiting = requests.filter((r) => r.status === "new" && !r.invitedAt).length;

  return (
    <Section id="setup-requests" title={`Setup requests${loadError ? "" : ` (${waiting} without a link)`}`}>
      <p className="text-muted text-sm">
        Reply by the next business day. Checkout is{" "}
        <strong className="text-ink">{mode === "public" ? "open to everyone" : "by setup link only"}</strong>; setup links
        are <strong className="text-ink">{open ? "open" : "closed until the launch checklist is complete"}</strong>.
      </p>

      {result && RESULTS[result] ? (
        <p className="border-line mt-3 rounded-sm border bg-white px-4 py-3 text-sm font-semibold" role="status">
          {RESULTS[result]}
        </p>
      ) : null}

      {loadError ? (
        <p role="status" className="text-red-deep mt-4 text-sm font-semibold">
          Could not read the setup requests: {loadError}
        </p>
      ) : requests.length === 0 ? (
        <p className="text-muted mt-4 text-sm">No requests yet.</p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {requests.map((request) => {
            const paid = request.status === "paid" || Boolean(request.paidAt);
            const canSend = open && !paid && !request.unsubscribedAt;
            return (
              <li key={request.id} className="border-line rounded-md border bg-white p-5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-lg font-bold">{request.clinicName}</span>
                  <span className="text-muted text-sm">asked {when(request.createdAt)}</span>
                </div>
                <p className="text-muted mt-1 text-sm break-words">
                  {request.name} · <a className="text-ink underline underline-offset-2" href={`mailto:${request.email}`}>{request.email}</a> ·{" "}
                  {request.website ?? "no website"} · {channelList(request.channels)}
                  {request.leadId ? " · from the Day 7 email" : ""}
                </p>
                {progress(request, now, packages.get(request.id)).length ? (
                  <p className="mt-2 text-sm font-semibold">
                    {progress(request, now, packages.get(request.id)).join(" · ")}
                  </p>
                ) : null}

                {!paid ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <form action={sendLink}>
                      <input type="hidden" name="id" value={request.id} />
                      <button
                        type="submit"
                        disabled={!canSend}
                        className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-40"
                      >
                        {request.invitedAt ? "Send a new link" : "Send setup link"}
                      </button>
                    </form>
                    {request.status !== "declined" ? (
                      <form action={decline}>
                        <input type="hidden" name="id" value={request.id} />
                        <button
                          type="submit"
                          className="border-line-strong text-ink min-h-11 rounded-full border-[1.5px] px-5 text-sm font-bold"
                        >
                          Decline
                        </button>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
