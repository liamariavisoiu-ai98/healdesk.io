/**
 * The AI visibility panel: fixed questions asked of five AI engines, logged
 * at /admin/seo, read as a frequency rather than a rank. AI recommendations
 * are unstable from one run to the next (strategy, "How engines choose whom
 * to name"), so a question counts as cited in an engine only when at least two
 * of its last three logged runs cite healdesk.io or name healdesk.
 *
 * Pure: the grid and the shares are computed here from rows the store read,
 * so client components and tests use it directly.
 */

export const ENGINES = [
  { id: "chatgpt", label: "ChatGPT" },
  { id: "perplexity", label: "Perplexity" },
  { id: "ai-mode", label: "AI Mode" },
  { id: "claude", label: "Claude" },
  { id: "copilot", label: "Copilot" },
] as const;

export type EngineId = (typeof ENGINES)[number]["id"];

/** The baseline set from the strategy doc's "Drafts for you": two per question group. */
export const PANEL_QUESTIONS = [
  { id: "missed-after-hours", group: "Operations", text: "How many calls does a med spa miss after hours?" },
  { id: "plastic-after-hours", group: "Operations", text: "What happens to after-hours calls at a plastic surgery practice?" },
  { id: "best-med-spa", group: "Category", text: "What is the best AI receptionist for med spas?" },
  { id: "cost", group: "Category", text: "How much does an AI receptionist cost for a clinic?" },
  { id: "baa", group: "Risk", text: "Does an AI receptionist need a business associate agreement?" },
  { id: "disclosure", group: "Risk", text: "Does an AI phone assistant have to tell callers it is an AI?" },
  { id: "fertility", group: "Evaluation", text: "Which AI receptionists work for fertility clinics?" },
  { id: "vendor-questions", group: "Evaluation", text: "What should I ask an AI receptionist vendor before buying?" },
  { id: "forwarding", group: "Set-up", text: "How do I set up conditional call forwarding for my clinic's phone line?" },
  { id: "instagram-dms", group: "Set-up", text: "Can an AI answer Instagram DMs for a med spa?" },
] as const;

export type QuestionId = (typeof PANEL_QUESTIONS)[number]["id"];

export type PanelRun = {
  ranOn: string;
  engine: string;
  questionId: string;
  named: boolean;
  cited: boolean;
};

export type CellState = "cited" | "not-cited" | "too-few" | "none";

const ENGINE_IDS = new Set<string>(ENGINES.map((engine) => engine.id));
const QUESTION_IDS = new Set<string>(PANEL_QUESTIONS.map((question) => question.id));

export function isEngine(value: unknown): value is EngineId {
  return typeof value === "string" && ENGINE_IDS.has(value);
}

export function isQuestion(value: unknown): value is QuestionId {
  return typeof value === "string" && QUESTION_IDS.has(value);
}

/**
 * Each question by each engine: cited when two of the last three runs named
 * or cited healdesk; not cited when three runs exist and fewer than two did;
 * too few runs to say otherwise; none when nothing is logged.
 */
export function panelGrid(runs: readonly PanelRun[]): Record<string, Record<string, CellState>> {
  const grid: Record<string, Record<string, CellState>> = {};
  for (const question of PANEL_QUESTIONS) {
    const row: Record<string, CellState> = {};
    for (const engine of ENGINES) {
      const last = runs
        .filter((run) => run.questionId === question.id && run.engine === engine.id)
        .sort((a, b) => b.ranOn.localeCompare(a.ranOn))
        .slice(0, 3);
      const hits = last.filter((run) => run.named || run.cited).length;
      row[engine.id] = last.length === 0 ? "none" : hits >= 2 ? "cited" : last.length < 3 ? "too-few" : "not-cited";
    }
    grid[question.id] = row;
  }
  return grid;
}

/** Engines that cite healdesk for at least one question, for the scoreboard. */
export function enginesCiting(grid: Record<string, Record<string, CellState>>): number {
  return ENGINES.filter((engine) => PANEL_QUESTIONS.some((question) => grid[question.id]?.[engine.id] === "cited"))
    .length;
}

/** The share of logged runs in each month that named or cited healdesk, oldest month first. */
export function monthlyShare(runs: readonly PanelRun[]): { month: string; runs: number; share: number }[] {
  const byMonth = new Map<string, { runs: number; hits: number }>();
  for (const run of runs) {
    const month = run.ranOn.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const entry = byMonth.get(month) ?? { runs: 0, hits: 0 };
    entry.runs += 1;
    if (run.named || run.cited) entry.hits += 1;
    byMonth.set(month, entry);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, { runs: count, hits }]) => ({ month, runs: count, share: count === 0 ? 0 : hits / count }));
}

/**
 * The sources an answer cited, as the owner pasted them: public URLs only,
 * one per line or separated by spaces, at most twenty, each under 300
 * characters. Anything that is not an http(s) URL is dropped, so free text
 * never reaches the Sheet.
 */
export function cleanSources(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const urls: string[] = [];
  for (const token of raw.split(/\s+/)) {
    if (urls.length >= 20) break;
    if (token.length === 0 || token.length > 300) continue;
    try {
      const url = new URL(token);
      if (url.protocol === "https:" || url.protocol === "http:") urls.push(url.toString());
    } catch {
      // not a URL: dropped
    }
  }
  return urls.join(" ");
}
