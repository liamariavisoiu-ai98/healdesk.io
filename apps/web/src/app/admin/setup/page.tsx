import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireOperator } from "@/lib/admin/operator";
import { checkoutMode, setupLinksOpen } from "@/lib/checkout-mode";
import { channelList } from "@/lib/email/setup-emails";
import { declineSetupRequest, sendSetupLink } from "@/lib/setup-links";
import { listSetupRequests } from "@/lib/setup-requests";
import type { SetupRequest } from "@/lib/sheets/schema";
import { isMarketingStoreConfigured } from "@/lib/sheets/client";

/**
 * /admin/setup: the "Tell us about your clinic" requests, and their setup links.
 *
 * ## The job this page does
 *
 * Every request was promised a reply by the next business day (P2), so this
 * is a queue to empty daily. Each row shows what the clinic asked for and how
 * far its link has got: sent, opened, signed, paid. The actions are the three
 * an operator needs: send the link, send a new one (which stops the old one
 * working), or decline.
 *
 * ## Why "Send" can be refused
 *
 * A setup link promises the purchase the plan describes, and until the launch
 * checklist is done (Gate A) the checkout cannot honour it. Production
 * refuses to send until `HEALDESK_SETUP_LINKS=open` (lib/checkout-mode.ts),
 * and the page says so above the queue rather than letting the button fail.
 *
 * ## No JavaScript, on purpose
 *
 * Plain forms posting to server actions that redirect back with the outcome
 * in the query string, the same way sign-out works. Each action checks the
 * operator itself: the layout is not a security boundary.
 */

export const metadata: Metadata = {
  title: "Setup requests",
};

export const dynamic = "force-dynamic";

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
  revalidatePath("/admin/setup");
  redirect(`/admin/setup?result=${outcome.ok ? "sent" : outcome.reason}`);
}

async function decline(formData: FormData): Promise<void> {
  "use server";
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const id = String(formData.get("id") ?? "");
  const found = UUID.test(id) && (await declineSetupRequest(id));
  revalidatePath("/admin/setup");
  redirect(`/admin/setup?result=${found ? "declined" : "not_found"}`);
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

function progress(request: SetupRequest, now: Date): string[] {
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
  if (request.signedAt) steps.push(`Signed ${when(request.signedAt)}`);
  if (request.paidAt) steps.push(`Paid ${when(request.paidAt)}`);
  if (request.unsubscribedAt) steps.push(`Unsubscribed ${when(request.unsubscribedAt)}`);
  if (request.status === "declined") steps.push("Declined");
  return steps;
}

export default async function SetupRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string }>;
}) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { result } = await searchParams;
  const now = new Date();

  const heading = (
    <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">Setup requests</h1>
  );

  if (!isMarketingStoreConfigured()) {
    return (
      <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
        {heading}
        <p className="text-muted mt-3 max-w-[60ch] text-[15.6px]">
          No lead register is configured, so requests are not being kept. Set{" "}
          <code className="font-mono">MARKETING_SHEET_ID</code> and{" "}
          <code className="font-mono">GOOGLE_SERVICE_ACCOUNT_JSON</code>. See .env.example.
        </p>
      </main>
    );
  }

  let requests: SetupRequest[] = [];
  let loadError: string | null = null;
  try {
    requests = await listSetupRequests(200);
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  const open = setupLinksOpen();
  const mode = checkoutMode();

  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
      {heading}
      <p className="text-muted mt-3 max-w-[70ch] text-[15.6px]">
        Each request was promised a reply by the next business day. Checkout is{" "}
        <strong className="text-ink">{mode === "public" ? "open to everyone" : "by setup link only"}</strong>, and
        setup links are{" "}
        <strong className="text-ink">{open ? "open" : "closed until the launch checklist is complete"}</strong>.
      </p>

      {result && RESULTS[result] ? (
        <p className="border-line mt-6 rounded-xl border bg-white px-4 py-3 text-[15.6px] font-semibold" role="status">
          {RESULTS[result]}
        </p>
      ) : null}

      {loadError ? (
        <p className="text-red-deep mt-6 text-[15.6px] font-semibold">
          The register could not be read: {loadError}
        </p>
      ) : requests.length === 0 ? (
        <p className="text-muted mt-6 text-[15.6px]">No requests yet.</p>
      ) : (
        <ul className="mt-6 grid gap-3">
          {requests.map((request) => {
            const paid = request.status === "paid" || Boolean(request.paidAt);
            const canSend = open && !paid && !request.unsubscribedAt;
            return (
              <li key={request.id} className="border-line rounded-2xl border bg-white p-5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[19.2px] font-bold">{request.clinicName}</span>
                  <span className="text-muted text-sm">asked {when(request.createdAt)}</span>
                </div>
                <p className="text-muted mt-1 text-sm break-words">
                  {request.name} · <a className="text-ink underline underline-offset-2" href={`mailto:${request.email}`}>{request.email}</a> ·{" "}
                  {request.website ?? "no website"} · {channelList(request.channels)}
                  {request.leadId ? " · from the Day 7 email" : ""}
                </p>
                {progress(request, now).length ? (
                  <p className="mt-2 text-sm font-semibold">{progress(request, now).join(" · ")}</p>
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
    </main>
  );
}
