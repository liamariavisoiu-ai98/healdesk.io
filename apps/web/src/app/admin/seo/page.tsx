import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireOperator } from "@/lib/admin/operator";
import { runHealthChecks, type HealthCheck } from "@/lib/admin/seo/health";
import { LAUNCH_PROMISES, STATUS_LABEL, type LaunchStatus } from "@/lib/admin/seo/launch";
import { ENGINES, enginesCiting, monthlyShare, PANEL_QUESTIONS, panelGrid, type CellState } from "@/lib/admin/seo/panel";
import { roadmapBounds, roadmapPosition, SEO_ROADMAP } from "@/lib/admin/seo/roadmap";
import { OWNER_STEPS, STRATEGY_DOC } from "@/lib/admin/seo/steps";
import { readSeoLog, recordPanelRun, recordStepTick, type PanelEntry, type SeoWriteOutcome } from "@/lib/admin/seo/store";
import { FAMILIES, allPieces, formatDate, piecePath } from "@/lib/content/registry";
import type { Stage } from "@/lib/content/types";
import { indexNowPayload, sitemapLocations, submitToIndexNow } from "@/lib/indexnow";
import { site } from "@/lib/site";

import { IndexNowButton, PanelLogForm, RecheckButton, StepList } from "./SeoControls";

/**
 * /admin/seo: the search and AI-visibility strategy as state, not prose (the
 * owner approved the proposal on 19 October 2026; the strategy itself stays
 * in the doc). Top to bottom in the order the owner acts: the scoreboard,
 * their steps beside the live site's health, the pages by stage, the roadmap,
 * what the AI engines say, and what the public copy promises that is not on
 * yet.
 *
 * No database and nothing from apps/app: ticks and panel runs are rows in the
 * marketing Sheet, site health is fetched from the public site, the pages and
 * the roadmap are read from code. Not indexed, like the rest of /admin.
 */

export const metadata: Metadata = { title: "SEO" };
export const dynamic = "force-dynamic";

async function tickStep(stepId: string, done: boolean): Promise<SeoWriteOutcome> {
  "use server";
  const operator = await requireOperator();
  if (!operator) return { ok: false, message: "Your session has ended. Sign in again to tick it." };
  if (typeof stepId !== "string" || typeof done !== "boolean") return { ok: false, message: "That tick could not be read." };
  const outcome = await recordStepTick(stepId, done, operator);
  revalidatePath("/admin/seo");
  return outcome;
}

async function logPanelRun(entry: PanelEntry): Promise<SeoWriteOutcome> {
  "use server";
  const operator = await requireOperator();
  if (!operator) return { ok: false, message: "Your session has ended. Sign in again to log it." };
  const outcome = await recordPanelRun(entry, operator);
  revalidatePath("/admin/seo");
  return outcome;
}

async function pingIndexNow(): Promise<SeoWriteOutcome & { sent?: number }> {
  "use server";
  if (!(await requireOperator())) return { ok: false, message: "Your session has ended. Sign in again." };
  try {
    const response = await fetch(new URL("/sitemap.xml", site.url), { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { ok: false, message: `The live sitemap answered ${String(response.status)}.` };
    const payload = indexNowPayload(site.url, sitemapLocations(await response.text()));
    const status = await submitToIndexNow(payload);
    if (status === 200 || status === 202) return { ok: true, sent: payload.urlList.length };
    return { ok: false, message: `IndexNow answered ${String(status)}.` };
  } catch {
    return { ok: false, message: "IndexNow could not be reached. Try again in a minute." };
  }
}

const STAGES: readonly { stage: Stage; label: string }[] = [
  { stage: "draft", label: "Draft" },
  { stage: "audited", label: "Audited" },
  { stage: "live", label: "Live" },
];

/** The roadmap board's validated status colours (components/admin/RoadmapBoard.tsx), each with its word. */
const GOOD = "#5A9A16";
const BLUE = "#14539E";
const AMBER = "#8A4A0C";

const LAUNCH_COLOUR: Record<LaunchStatus, string> = { on: GOOD, building: BLUE, off: "#B42318", owner: AMBER };

export default async function SeoPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");

  const [log, health] = await Promise.all([readSeoLog(), runHealthChecks()]);
  const ticks = log.ok ? log.ticks : {};
  const runs = log.ok ? log.runs : [];
  const grid = panelGrid(runs);
  const pieces = allPieces();
  const livePieces = pieces.filter((piece) => piece.stage === "live").length;
  const stepsDone = OWNER_STEPS.filter((step) => ticks[step.id]).length;
  const checksPassing = health.filter((check) => check.ok === true).length;
  const citing = enginesCiting(grid);
  const openLaunch = LAUNCH_PROMISES.filter((item) => item.status !== "on");
  const today = new Date().toISOString().slice(0, 10);
  const bounds = roadmapBounds();

  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">SEO</h1>
      <p className="text-muted mt-3 max-w-[72ch] text-[15.6px]">
        Is healdesk findable, what is waiting on you, and what ships next. The strategy itself lives in{" "}
        <a className="text-ink underline underline-offset-2" href={STRATEGY_DOC} rel="noreferrer" target="_blank">
          the strategy doc
        </a>
        ; this page tracks its state.
      </p>

      {!log.ok ? (
        <p role="status" className="border-red/30 bg-red/[0.06] mt-6 rounded-md border p-4 text-sm">
          {log.reason} Ticks and panel runs cannot be shown or saved until it is.
        </p>
      ) : null}

      <section aria-label="Scoreboard" className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile href="#pages" value={`${String(livePieces)} of ${String(pieces.length)}`} label="Pages live" />
        <Tile href="#your-steps" value={`${String(stepsDone)} of ${String(OWNER_STEPS.length)}`} label="Your steps done" />
        <Tile href="#site-health" value={`${String(checksPassing)} of ${String(health.length)}`} label="Site checks passing" />
        <Tile href="#ai-visibility" value={`${String(citing)} of ${String(ENGINES.length)}`} label="Engines citing healdesk" />
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section id="your-steps" aria-labelledby="steps-heading" className="border-line scroll-mt-24 rounded-md border bg-white p-5">
          <h2 id="steps-heading" className="text-[17px] font-bold">
            Your steps
          </h2>
          <p className="text-muted mt-1 text-sm">Only you can do these. Tick each one when it is done; the doc has the text to paste.</p>
          <StepList steps={OWNER_STEPS} ticks={ticks} canSave={log.ok} tick={tickStep} />
        </section>

        <section id="site-health" aria-labelledby="health-heading" className="border-line scroll-mt-24 rounded-md border bg-white p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="health-heading" className="text-[17px] font-bold">
              Site health
            </h2>
            <div className="ml-auto flex flex-wrap gap-2">
              <RecheckButton />
              <IndexNowButton ping={pingIndexNow} />
            </div>
          </div>
          <p className="text-muted mt-1 text-sm">Checked against {site.url} just now, as search and AI engines see it.</p>
          <ul className="mt-4 grid gap-2">
            {health.map((check) => (
              <HealthRow key={check.id} check={check} />
            ))}
          </ul>
        </section>
      </div>

      <section id="pages" aria-labelledby="pages-heading" className="border-line mt-6 scroll-mt-24 rounded-md border bg-white p-5">
        <h2 id="pages-heading" className="text-[17px] font-bold">
          Pages
        </h2>
        <p className="text-muted mt-1 text-sm">From the content registry in code. Only Live pages are public; a legal page goes live after its audit passes.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {STAGES.map(({ stage, label }) => {
            const inStage = pieces.filter((piece) => piece.stage === stage);
            return (
              <div key={stage}>
                <h3 className="text-muted text-sm font-bold">
                  {label} <span className="font-normal">({inStage.length})</span>
                </h3>
                <ul className="mt-2 grid gap-2">
                  {inStage.map((piece) => (
                    <li key={piece.slug} className="border-line rounded-md border px-3 py-2 text-sm">
                      {stage === "live" ? (
                        <a className="font-semibold underline-offset-2 hover:underline" href={piecePath(piece)} target="_blank" rel="noreferrer">
                          {piece.title}
                        </a>
                      ) : (
                        <span className="font-semibold">{piece.title}</span>
                      )}
                      <span className="text-muted mt-0.5 block text-xs">
                        {FAMILIES[piece.family].label}
                        {piece.legal ? ", legal" : ""} · reviewed {formatDate(piece.lastReviewed)}
                      </span>
                    </li>
                  ))}
                  {inStage.length === 0 ? <li className="text-muted text-sm">None.</li> : null}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="roadmap-heading" className="border-line mt-6 rounded-md border bg-white p-5">
        <h2 id="roadmap-heading" className="text-[17px] font-bold">
          Roadmap
        </h2>
        <p className="text-muted mt-1 text-sm">October 2026 to April 2027, drawn to scale; the line is today.</p>
        <ol className="mt-4 grid gap-2">
          {SEO_ROADMAP.map((row) => {
            const left = roadmapPosition(row.start, bounds) * 100;
            const width = Math.max((roadmapPosition(row.end, bounds) - roadmapPosition(row.start, bounds)) * 100, 1.2);
            return (
              <li key={row.id} className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] items-center gap-3 text-sm">
                <span className={row.accent ? "font-bold" : ""}>{row.label}</span>
                <span className="relative block h-3" aria-label={`${formatDate(row.start)} to ${formatDate(row.end)}`}>
                  <span className="bg-paper-2 absolute inset-0 rounded-full" />
                  <span
                    className="absolute top-0 h-3 rounded-full"
                    style={{ left: `${String(left)}%`, width: `${String(width)}%`, background: row.accent ? BLUE : "#8A8A8A" }}
                  />
                  <span
                    aria-hidden="true"
                    className="absolute -top-1 h-5 w-px"
                    style={{ left: `${String(roadmapPosition(today, bounds) * 100)}%`, background: "#B42318" }}
                  />
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <section id="ai-visibility" aria-labelledby="ai-heading" className="border-line mt-6 scroll-mt-24 rounded-md border bg-white p-5">
        <h2 id="ai-heading" className="text-[17px] font-bold">
          AI visibility
        </h2>
        <p className="text-muted mt-1 text-sm">
          A question counts as cited in an engine when two of its last three logged runs named healdesk or cited healdesk.io.
        </p>
        <div className="-mx-5 mt-4 overflow-x-auto px-5">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead>
              <tr>
                <th scope="col" className="border-line border-b py-2 pr-3 font-semibold">
                  Question
                </th>
                {ENGINES.map((engine) => (
                  <th key={engine.id} scope="col" className="border-line border-b px-2 py-2 text-center font-semibold">
                    {engine.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PANEL_QUESTIONS.map((question) => (
                <tr key={question.id}>
                  <th scope="row" className="border-line border-b py-2 pr-3 font-normal">
                    {question.text}
                  </th>
                  {ENGINES.map((engine) => (
                    <td key={engine.id} className="border-line border-b px-2 py-2 text-center">
                      <Cell state={grid[question.id]?.[engine.id] ?? "none"} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <MonthlyShare months={monthlyShare(runs)} />
        <PanelLogForm canSave={log.ok} log={logPanelRun} />
      </section>

      <section aria-labelledby="launch-heading" className="border-line mt-6 rounded-md border bg-white p-5">
        <h2 id="launch-heading" className="text-[17px] font-bold">
          Promised on the site, not on yet
        </h2>
        <p className="text-muted mt-1 max-w-[80ch] text-sm">
          The public copy states each of these as on (your rule of 19 October 2026). {openLaunch.length} are not on in
          production yet; no clinic goes live while one that blocks go-live is open.
        </p>
        <ul className="mt-4 grid gap-2">
          {LAUNCH_PROMISES.map((item) => (
            <li key={item.id} className="border-line rounded-md border px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span
                  className="inline-flex items-center gap-1.5 text-xs font-bold"
                  style={{ color: LAUNCH_COLOUR[item.status] }}
                >
                  <span aria-hidden="true" className="inline-block size-2 rounded-full" style={{ background: LAUNCH_COLOUR[item.status] }} />
                  {STATUS_LABEL[item.status]}
                </span>
                <span className="font-semibold">{item.promise}</span>
                {item.blocksGoLive && item.status !== "on" ? <span className="text-red-deep text-xs font-bold">blocks go-live</span> : null}
              </div>
              <p className="mt-1">{item.left}</p>
              <p className="text-muted mt-1 text-xs">
                Stated on: {item.where}. In the repo: <code className="font-mono">{item.evidence}</code>
              </p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function Tile({ href, value, label }: { href: string; value: string; label: string }) {
  return (
    <a href={href} className="border-line hover:border-line-strong block min-h-11 rounded-md border bg-white px-4 py-3 transition-colors">
      <span className="block text-[22px] font-bold">{value}</span>
      <span className="text-muted block text-sm">{label}</span>
    </a>
  );
}

function HealthRow({ check }: { check: HealthCheck }) {
  const colour = check.ok === true ? GOOD : check.ok === false ? "#B42318" : AMBER;
  const word = check.ok === true ? "Pass" : check.ok === false ? "Fail" : "No answer";
  return (
    <li className="flex gap-3 text-sm">
      <span className="w-[5.5rem] shrink-0 text-xs font-bold" style={{ color: colour }}>
        <span aria-hidden="true" className="mr-1.5 inline-block size-2 rounded-full" style={{ background: colour }} />
        {word}
      </span>
      <span>
        <span className="font-semibold">{check.label}</span>
        <span className="text-muted block text-xs">{check.detail}</span>
      </span>
    </li>
  );
}

const CELL: Record<CellState, { word: string; colour: string }> = {
  cited: { word: "Cited", colour: GOOD },
  "not-cited": { word: "Not cited", colour: "#B42318" },
  "too-few": { word: "Too few runs", colour: AMBER },
  none: { word: "Not run", colour: "#8A8A8A" },
};

function Cell({ state }: { state: CellState }) {
  const { word, colour } = CELL[state];
  return (
    <span className="text-xs font-semibold" style={{ color: colour }}>
      {word}
    </span>
  );
}

function MonthlyShare({ months }: { months: { month: string; runs: number; share: number }[] }) {
  if (months.length === 0) return <p className="text-muted mt-3 text-sm">No runs logged yet: the baseline is step one.</p>;
  return (
    <ul className="mt-3 flex flex-wrap gap-2 text-sm">
      {months.map(({ month, runs, share }) => (
        <li key={month} className="border-line rounded-full border px-3 py-1">
          {month}: {Math.round(share * 100)}% of {runs} runs named or cited healdesk
        </li>
      ))}
    </ul>
  );
}
