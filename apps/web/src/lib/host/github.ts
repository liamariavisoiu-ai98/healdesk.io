/**
 * GitHub, for the AWS host's switch: dispatch .github/workflows/host.yml and
 * read its last runs.
 *
 * ## Whose token, and why it has to be the owner's
 *
 * HEALDESK_GITHUB_ACTIONS_TOKEN is a fine-grained personal access token of the
 * repository's owner, with Actions read and write on this repository and
 * nothing else. A run dispatched with it carries the owner's actor id, and the
 * AWS roles host.yml assumes trust a run of main started by the owner and no
 * other (infra/aws/iam.tf, the bootstrap stack). A token of anyone else, or a
 * GitHub App's, would dispatch a run AWS then refuses.
 *
 * What the token can do is what Actions on this repository can do: start and
 * cancel workflows, read their logs. That is a lot, so it lives in Vercel's
 * environment, is read here and nowhere else, and never reaches a browser:
 * no response of this app carries it, no error repeats GitHub's body, and no
 * log line names it.
 *
 * Server-side only, like lib/admin/ops-client.ts.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/host/github is server-side only: it holds HEALDESK_GITHUB_ACTIONS_TOKEN.");
}

/** The repository host.yml lives in, unless HEALDESK_GITHUB_REPO names another. */
export const DEFAULT_REPO = "liamariavisoiu-ai98/healdesk.io";
export const HOST_WORKFLOW = "host.yml";
export const TOKEN_VARIABLE = "HEALDESK_GITHUB_ACTIONS_TOKEN";
export const REPO_VARIABLE = "HEALDESK_GITHUB_REPO";

const API = "https://api.github.com";
const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TIMEOUT_MS = 8_000;

export type HostMode = "active" | "standby";

export type GitHubConfig = { token: string; repo: string };

/** The token and the repository, or null with the variable to set. */
export function githubConfig(): { ok: true; config: GitHubConfig } | { ok: false; missing: string } {
  const token = process.env[TOKEN_VARIABLE]?.trim();
  if (!token) return { ok: false, missing: TOKEN_VARIABLE };
  const repo = process.env[REPO_VARIABLE]?.trim() || DEFAULT_REPO;
  if (!REPO_SHAPE.test(repo)) return { ok: false, missing: REPO_VARIABLE };
  return { ok: true, config: { token, repo } };
}

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "healdesk-admin",
  };
}

/**
 * A reason as it may travel in a run's name: printable, one line, short. The
 * caller's words are not trusted to be any of those.
 */
export function cleanReason(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[^A-Za-z0-9 .,:'()/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export type DispatchResult =
  | { ok: true }
  | { ok: false; status: number | null; message: string };

/**
 * Start host.yml on main. GitHub answers 204 (or 200, when it returns the
 * run's details) and nothing else means it started; the run itself appears in
 * the list a moment later. GitHub's body is never passed on: it can quote the
 * request, and the sentences here are the ones an operator can act on.
 */
export async function dispatchHost(
  config: GitHubConfig,
  mode: HostMode,
  reason: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DispatchResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}/repos/${config.repo}/actions/workflows/${HOST_WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { ...headers(config.token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { mode, reason: cleanReason(reason) } }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: null, message: "GitHub did not answer, so the workflow was not started. Try again in a minute." };
  }
  void response.body?.cancel().catch(() => undefined);
  if (response.status === 204 || response.status === 200) return { ok: true };
  if (response.status === 401) {
    return { ok: false, status: 401, message: `GitHub refused ${TOKEN_VARIABLE}: it has expired or been revoked. Make a new one and set it on Vercel.` };
  }
  if (response.status === 403 || response.status === 404) {
    return {
      ok: false,
      status: response.status,
      message: `GitHub would not start ${HOST_WORKFLOW} on ${config.repo}: ${TOKEN_VARIABLE} needs Actions read and write on that repository, and the workflow must be on main.`,
    };
  }
  if (response.status === 422) {
    return { ok: false, status: 422, message: `GitHub refused the dispatch: ${HOST_WORKFLOW} on main does not take these inputs (mode, reason).` };
  }
  return { ok: false, status: response.status, message: `GitHub answered ${response.status}, so the workflow was not started.` };
}

export type HostRun = {
  id: number;
  /** From the run's name ("Host active (reason)"); null for a run named otherwise. */
  mode: HostMode | null;
  reason: string;
  status: "queued" | "in_progress" | "completed" | "other";
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
};

const RUN_NAME = /^Host (active|standby)(?: \((.*)\))?$/;

/** One run from GitHub's list, read field by field; null when it is not a run. */
export function readRun(value: unknown): HostRun | null {
  if (typeof value !== "object" || value === null) return null;
  const run = value as Record<string, unknown>;
  if (typeof run.id !== "number" || typeof run.html_url !== "string" || !run.html_url.startsWith("https://github.com/")) {
    return null;
  }
  const title = typeof run.display_title === "string" ? run.display_title : "";
  const match = RUN_NAME.exec(title);
  const status = run.status;
  return {
    id: run.id,
    mode: match ? (match[1] as HostMode) : null,
    reason: cleanReason(match?.[2] ?? ""),
    status:
      status === "queued" || status === "in_progress" || status === "completed"
        ? status
        : status === "waiting" || status === "requested" || status === "pending"
          ? "queued"
          : "other",
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    createdAt: typeof run.created_at === "string" ? run.created_at : "",
    updatedAt: typeof run.updated_at === "string" ? run.updated_at : "",
    url: run.html_url,
  };
}

export type RunsResult = { ok: true; runs: HostRun[] } | { ok: false; message: string };

/** host.yml's newest runs on main, newest first. */
export async function listHostRuns(config: GitHubConfig, fetchImpl: typeof fetch = fetch, perPage = 10): Promise<RunsResult> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${API}/repos/${config.repo}/actions/workflows/${HOST_WORKFLOW}/runs?branch=main&per_page=${perPage}`,
      { headers: headers(config.token), cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
  } catch {
    return { ok: false, message: "GitHub did not answer, so the last switches cannot be shown." };
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      message:
        response.status === 404
          ? `GitHub has no ${HOST_WORKFLOW} on ${config.repo} that ${TOKEN_VARIABLE} can read (it may not be on main yet).`
          : `GitHub answered ${response.status} to the list of runs.`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, message: "GitHub's list of runs could not be read." };
  }
  const runs = (body as { workflow_runs?: unknown }).workflow_runs;
  if (!Array.isArray(runs)) return { ok: false, message: "GitHub's list of runs could not be read." };
  return {
    ok: true,
    runs: runs
      .map(readRun)
      .filter((run): run is HostRun => run !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}
