import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireOperator } from "@/lib/admin/operator";
import { ACTIVE_COSTS, dollars, STANDBY_COSTS, total, type CostLine } from "@/lib/host/costs";
import { DEFAULT_REPO, githubConfig, listHostRuns, REPO_VARIABLE, TOKEN_VARIABLE, type HostRun } from "@/lib/host/github";
import { hostState, probeLiveness, type HostState, type Liveness } from "@/lib/host/state";

import { HostSwitch } from "./HostSwitch";

/**
 * /admin/host: whether the AWS host (apps/app, infra/aws) is on, and the
 * switch that puts it in standby or brings it back.
 *
 * The state is read from .github/workflows/host.yml's runs on GitHub, with
 * HEALDESK_GITHUB_ACTIONS_TOKEN, and from one probe of HEALDESK_APP_URL; the
 * buttons post to /api/admin/host, which dispatches host.yml. Nothing here
 * talks to AWS: the workflow does, with roles AWS gives only to the owner's
 * runs of main.
 *
 * Guarded like every page under /admin: `requireOperator()` here, and again
 * in the route behind the buttons.
 */

export const metadata: Metadata = { title: "Host" };
export const dynamic = "force-dynamic";

const STATE_LABEL: Record<HostState["state"], string> = {
  active: "Active",
  standby: "Standby",
  switching: "Switching",
  unsettled: "Unsettled",
  unknown: "Unknown",
};

const LIVENESS_LABEL: Record<Liveness, string> = {
  answers: "the app answers its liveness probe",
  edge: "the host's load balancer answers (the internal host serves only the signed routes)",
  unreachable: "nothing answers at the host's address",
  unconfigured: "HEALDESK_APP_URL is not set on this deployment",
};

export default async function HostPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");

  const found = githubConfig();
  const [runs, liveness] = await Promise.all([found.ok ? listHostRuns(found.config) : Promise.resolve(null), probeLiveness()]);
  const state = hostState(runs?.ok ? runs.runs : [], liveness);
  const repo = found.ok ? found.config.repo : process.env[REPO_VARIABLE]?.trim() || DEFAULT_REPO;

  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">Host</h1>
      <p className="text-muted mt-3 max-w-[70ch] text-[15.6px]">
        The AWS host runs apps/app: the database, the load balancer, the NAT and the task. Standby removes those, which
        bill by the hour, after a snapshot of the database, and keeps the key, the secrets, the images and the network,
        so turning it on again brings the same host back. Until the first clinic pays it holds synthetic data only.
      </p>

      <section className="border-line mt-8 rounded-md border bg-white p-5" aria-labelledby="host-state">
        <p id="host-state" className="text-[24px] font-bold">
          {STATE_LABEL[state.state]}
          {state.state === "switching" && state.mode ? (
            <span className="text-muted text-[17px] font-semibold"> to {state.mode}</span>
          ) : null}
        </p>
        <p className="mt-2 max-w-[70ch] text-[15.6px]">{state.note}</p>
        <p className="text-muted mt-2 text-sm">Right now, {LIVENESS_LABEL[liveness]}.</p>
        {state.run ? (
          <p className="text-muted mt-1 text-sm">
            From the run of {when(state.run.createdAt)}:{" "}
            <a className="text-ink underline underline-offset-2" href={state.run.url} rel="noreferrer" target="_blank">
              open it in GitHub
            </a>
            .
          </p>
        ) : null}

        {!found.ok ? (
          <div role="status" className="border-red/30 bg-red/[0.06] mt-5 rounded-md border p-4 text-sm">
            <p className="font-bold">The switch is not set up on this deployment.</p>
            {found.missing === TOKEN_VARIABLE ? (
              <p className="mt-1 max-w-[70ch]">
                Set <code className="font-mono">{TOKEN_VARIABLE}</code> on Vercel (Production) to a fine-grained personal
                access token of the repository owner, scoped to <code className="font-mono">{repo}</code> only, with{" "}
                <strong>Actions: read and write</strong>, then redeploy. The runs it starts carry the owner&apos;s id,
                which AWS requires. <code className="font-mono">{REPO_VARIABLE}</code> is optional (default{" "}
                <code className="font-mono">{DEFAULT_REPO}</code>).
              </p>
            ) : (
              <p className="mt-1">
                <code className="font-mono">{REPO_VARIABLE}</code> must be an owner/repository name.
              </p>
            )}
          </div>
        ) : runs && !runs.ok ? (
          <p role="status" className="text-red-deep mt-4 text-sm font-semibold">
            {runs.message}
          </p>
        ) : null}

        <HostSwitch configured={found.ok} switching={state.state === "switching"} />
      </section>

      {state.state === "standby" || state.state === "switching" || liveness === "unreachable" ? (
        <p className="mt-6 max-w-[70ch] text-[15.6px]">
          <strong>Keep this session.</strong> Signing in to /admin asks the host for the second factor, so with the host
          in standby a new sign-in cannot finish. If you are signed out, turn it on from GitHub: Actions, Host (AWS), Run
          workflow, mode active. A first paid invoice turns it on by itself.
        </p>
      ) : null}

      <section className="mt-10" aria-labelledby="host-runs">
        <h2 id="host-runs" className="text-sm font-bold tracking-[0.08em] uppercase">
          Last switches
        </h2>
        {runs?.ok && runs.runs.length > 0 ? (
          <ul className="mt-4 grid gap-2">
            {runs.runs.slice(0, 8).map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        ) : (
          <p className="text-muted mt-4 text-sm">{found.ok && runs?.ok ? "No switch has been made from host.yml yet." : "Not readable without the token."}</p>
        )}
      </section>

      <section className="mt-10" aria-labelledby="host-costs">
        <h2 id="host-costs" className="text-sm font-bold tracking-[0.08em] uppercase">
          What each state costs a month (estimates)
        </h2>
        <div className="mt-4 grid gap-6 lg:grid-cols-2">
          <CostTable title="Active, the lean profile" lines={ACTIVE_COSTS} />
          <CostTable title="Standby" lines={STANDBY_COSTS} />
        </div>
        <p className="text-muted mt-4 max-w-[70ch] text-sm">
          US East, on-demand, 730 hours; fixed-rate lines are exact and usage lines are low-traffic guesses (infra/aws
          README, Costs and Standby). Turning on takes about an hour (apply, the database from its snapshot, the deploy
          and its image build); standby about twenty minutes. A month with both is billed by the hour for the time it
          was on.
        </p>
      </section>
    </main>
  );
}

function RunRow({ run }: { run: HostRun }) {
  const outcome = run.status === "completed" ? (run.conclusion ?? "finished") : run.status === "other" ? "waiting" : run.status.replace("_", " ");
  return (
    <li className="border-line flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border bg-white px-4 py-3 text-sm">
      <span className="font-bold">{run.mode ?? "?"}</span>
      {run.reason ? <span className="text-muted">({run.reason})</span> : null}
      <span className={run.conclusion === "success" || run.status !== "completed" ? "" : "text-red-deep font-semibold"}>{outcome}</span>
      <span className="text-muted">{when(run.createdAt)}</span>
      <a className="ml-auto underline underline-offset-2" href={run.url} rel="noreferrer" target="_blank">
        GitHub
      </a>
    </li>
  );
}

function CostTable({ title, lines }: { title: string; lines: readonly CostLine[] }) {
  return (
    <table className="border-line w-full border-collapse rounded-md border bg-white text-sm">
      <caption className="mb-2 text-left font-bold">
        {title}: about {dollars(Math.round(total(lines)))}
      </caption>
      <tbody>
        {lines.map((line) => (
          <tr key={line.item} className="border-line border-t">
            <td className="px-3 py-2">
              {line.item}
              {line.note ? <span className="text-muted"> ({line.note})</span> : null}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{dollars(line.dollars)}</td>
          </tr>
        ))}
        <tr className="border-line border-t font-bold">
          <td className="px-3 py-2">Total, estimated</td>
          <td className="px-3 py-2 text-right tabular-nums">{dollars(total(lines))}</td>
        </tr>
      </tbody>
    </table>
  );
}

/** "14 Oct 2026, 09:12 UTC": runs are UTC on GitHub and here. */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "an unknown time";
  return `${at.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
}
