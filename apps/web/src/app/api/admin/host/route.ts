import { hostStandbyCheck } from "@/lib/admin/ops-client";
import { requireOperator } from "@/lib/admin/operator";
import { isSameOrigin } from "@/lib/admin/same-origin";
import { cleanReason, dispatchHost, githubConfig, REPO_VARIABLE, TOKEN_VARIABLE, type HostMode } from "@/lib/host/github";
import { clientKey, rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/admin/host, the AWS host's switch: dispatch
 * .github/workflows/host.yml with mode active (apply, set up the database,
 * deploy) or standby (snapshot and remove the database, the load balancer,
 * the NAT and the services). /admin/host's two buttons call it; nothing else
 * should.
 *
 * In this order, each before the next:
 *
 *   1. Same origin (lib/admin/same-origin.ts): a page of this site, as the
 *      browser says, or 403.
 *   2. The operator session, `requireOperator()`, or 401. Not wrapped: if the
 *      session check breaks, this fails closed with a 500.
 *   3. A rate limit per address, or 429: a switch takes an hour, and a burst
 *      of clicks would queue runs behind each other.
 *   4. The body: `{ mode: "active" | "standby", confirm?, reason? }`, or 400.
 *      Standby needs `confirm: "standby"`, which the page sends only after
 *      its own confirmation.
 *   5. HEALDESK_GITHUB_ACTIONS_TOKEN, or 503 naming the variable to set.
 *   6. Standby only: apps/app's hostStandbyCheck (counts of production
 *      clinics, agreements in effect and transcripts not yet sent), or 409
 *      with the reason when any is above 0, or 503 when the host cannot be
 *      asked. host.yml cannot ask apps/app itself (it holds no signing
 *      secret), so this is the half of the guard that reads the database.
 *   7. The dispatch, and one structured log line for it, dispatched or not.
 *
 * The token goes to GitHub and nowhere else: no response carries it or
 * GitHub's answer, only sentences written here.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;
const ATTEMPT_LIMIT = 6;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 2048;

function json(body: Record<string, unknown>, status: number, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

function logDispatch(fields: Record<string, unknown>): void {
  console.info(JSON.stringify({ event: "host_dispatch", by: "admin", ...fields }));
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return json({ error: "This switch takes requests from the admin pages only." }, 403);
  }

  if ((await requireOperator()) === null) {
    return json({ error: "Your session has ended. Sign in again." }, 401);
  }

  const limit = await rateLimit(`admin-host:${clientKey(request.headers)}`, ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS);
  if (!limit.ok) {
    return json({ error: "Too many switches in a short time. Wait a few minutes." }, 429, {
      "Retry-After": String(Math.max(limit.retryAfter, 1)),
    });
  }

  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Invalid request." }, 400);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const mode = body.mode;
  if (mode !== "active" && mode !== "standby") {
    return json({ error: "mode must be active or standby." }, 400);
  }
  if (mode === "standby" && body.confirm !== "standby") {
    return json({ error: "Standby needs confirming." }, 400);
  }
  const reason = cleanReason(body.reason) || "from /admin";

  const found = githubConfig();
  if (!found.ok) {
    return json(
      {
        error:
          found.missing === TOKEN_VARIABLE
            ? `${TOKEN_VARIABLE} is not set on this deployment. Set it on Vercel to a fine-grained personal access token of the repository's owner, with Actions read and write on this repository only, then redeploy.`
            : `${REPO_VARIABLE} is not an owner/repository name.`,
        missing: found.missing,
      },
      503,
    );
  }

  if (mode === "standby") {
    const check = await hostStandbyCheck();
    if (!check.ok) {
      logDispatch({ mode, reason, result: "refused", why: `check-${check.code}` });
      return json(
        {
          error:
            check.code === "unreachable" || check.code === "timeout"
              ? "The host did not answer, so nobody could check that nothing real is on it, and standby was not started. If it is in standby already, there is nothing to put away."
              : `${check.message} Standby was not started.`,
        },
        503,
      );
    }
    if (!check.data.ok) {
      const parts: string[] = [];
      if (check.data.productionClinics > 0) parts.push(plural(check.data.productionClinics, "clinic is", "clinics are") + " in production");
      if (check.data.boundAgreements > 0) parts.push(plural(check.data.boundAgreements, "agreement is", "agreements are") + " in effect");
      if (check.data.openTranscripts > 0) parts.push(plural(check.data.openTranscripts, "transcript has", "transcripts have") + " not reached SES yet");
      logDispatch({ mode, reason, result: "refused", why: "something-real", ...check.data });
      return json(
        {
          error: `The host stays on: ${parts.join(", ")}. Standby would stop their service and delete the database they live in.`,
          check: check.data,
        },
        409,
      );
    }
  }

  const dispatched = await dispatchHost(found.config, mode as HostMode, reason);
  logDispatch({
    mode,
    reason,
    result: dispatched.ok ? "dispatched" : "failed",
    githubStatus: dispatched.ok ? undefined : dispatched.status,
  });
  if (!dispatched.ok) return json({ error: dispatched.message }, 502);

  return json(
    {
      ok: true,
      mode,
      message:
        mode === "active"
          ? "Started: host.yml applies, sets up the database and deploys. It takes about an hour; this page follows it."
          : "Started: host.yml snapshots the database and removes it, the load balancer, the NAT and the services. It takes about twenty minutes.",
    },
    202,
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
