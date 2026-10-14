import { sendSafely, type OutboundEmail, type SendResult } from "@/lib/email";
import { site } from "@/lib/site";

import { dispatchHost, githubConfig, type DispatchResult, type GitHubConfig } from "./github";

/**
 * A first paid invoice while the AWS host is in standby: turn the host on.
 *
 * The Stripe webhook (app/api/webhooks/stripe) provisions the account by
 * calling apps/app. In standby there is nothing at HEALDESK_APP_URL (the DNS
 * records go with the load balancer), so the call fails as unreachable, the
 * webhook answers 500, and Stripe redelivers the event for about three days.
 * The account is made on the first redelivery after the host answers, which
 * without this would be whenever somebody next looked.
 *
 * So when the provision call fails because nothing answered (a network error,
 * or the 502, 503 or 504 a load balancer or a starting host gives), and
 * HEALDESK_GITHUB_ACTIONS_TOKEN is set, this dispatches host.yml with mode
 * active and reason "first paid invoice", and emails the administrator
 * (HEALDESK_ADMIN_EMAIL, through this app's Resend sender) that a payment
 * arrived while the host was in standby and that it is being turned on. The
 * webhook still answers 500, so Stripe keeps retrying until provisioning
 * succeeds; this changes when that happens, not whether.
 *
 * At most once an hour per process, because Stripe retries and every retry
 * lands here: the dispatch and the email are both skipped inside the hour.
 * Across Vercel's instances GitHub's concurrency group keeps all but one run
 * waiting, and the email's idempotency key names the hour, so Resend sends
 * one an hour whichever instance asks.
 *
 * It never throws: a webhook that failed because waking failed would be a
 * second problem on top of the first. Nothing about the payment beyond
 * Stripe's event id goes into the email, and that is not a patient's.
 */

export const WAKE_REASON = "first paid invoice";
export const WAKE_INTERVAL_MS = 60 * 60 * 1000;

/** What the provision relay said (the route's RelayResult, by shape). */
export type ProvisionAttempt = { kind: string; status?: number };

export type WakeOutcome =
  | "not-needed"
  | "no-token"
  | "already-asked"
  | { dispatched: DispatchResult; emailed: SendResult | "no-address" };

type Deps = {
  now?: () => number;
  dispatch?: (config: GitHubConfig) => Promise<DispatchResult>;
  email?: (message: OutboundEmail) => Promise<SendResult>;
};

let lastAttemptAt: number | null = null;

/** Tests only: forget the last attempt. */
export function __resetWakeForTests(): void {
  lastAttemptAt = null;
}

/** Whether the relay's failure means nothing answered, rather than an answer of no. */
export function hostDidNotAnswer(attempt: ProvisionAttempt): boolean {
  if (attempt.kind === "unreachable") return true;
  return attempt.kind === "retryable" && (attempt.status === 502 || attempt.status === 503 || attempt.status === 504);
}

export async function wakeHostForPaidInvoice(
  attempt: ProvisionAttempt,
  eventId: string,
  deps: Deps = {},
): Promise<WakeOutcome> {
  try {
    if (!hostDidNotAnswer(attempt)) return "not-needed";

    const found = githubConfig();
    if (!found.ok) {
      console.warn("[healdesk] host wake: provisioning found no host, and HEALDESK_GITHUB_ACTIONS_TOKEN is not set to turn it on");
      return "no-token";
    }

    const now = (deps.now ?? Date.now)();
    if (lastAttemptAt !== null && now - lastAttemptAt < WAKE_INTERVAL_MS) return "already-asked";
    lastAttemptAt = now;

    const dispatched = await (deps.dispatch ?? ((config) => dispatchHost(config, "active", WAKE_REASON)))(found.config);
    console.info(
      JSON.stringify({
        event: "host_dispatch",
        mode: "active",
        reason: WAKE_REASON,
        by: "stripe-webhook",
        result: dispatched.ok ? "dispatched" : "failed",
        githubStatus: dispatched.ok ? undefined : dispatched.status,
      }),
    );

    const to = process.env.HEALDESK_ADMIN_EMAIL?.trim();
    if (!to) return { dispatched, emailed: "no-address" };

    const hour = new Date(now).toISOString().slice(0, 13);
    const emailed = await (deps.email ?? sendSafely)({
      to,
      subject: dispatched.ok
        ? "A payment arrived while the AWS host was in standby: it is being turned on"
        : "A payment arrived while the AWS host was in standby, and it could not be turned on",
      text: [
        "A first paid invoice reached healdesk.io while the AWS host was not answering (in standby, or down),",
        "so the account could not be made yet. Stripe keeps sending the event, for up to three days, and the",
        "account is made on the first delivery after the host answers.",
        "",
        dispatched.ok
          ? "The host workflow (host.yml, mode active) has been started to turn it on. That takes about half an hour to forty minutes: apply, database, deploy."
          : `The host workflow could not be started: ${dispatched.message} Turn it on from ${site.url}/admin/host or from GitHub (Actions, Host, mode active).`,
        "",
        `Follow it at ${site.url}/admin/host.`,
        `Stripe event: ${eventId}`,
      ].join("\n"),
      tag: "host-wake",
      idempotencyKey: `host-wake:${hour}`,
    });
    if (emailed.status !== "sent") {
      console.error("[healdesk] host wake: the administrator's email did not go", emailed.status);
    }
    return { dispatched, emailed };
  } catch (error) {
    console.error("[healdesk] host wake failed", error instanceof Error ? error.name : "unknown error");
    return "not-needed";
  }
}
