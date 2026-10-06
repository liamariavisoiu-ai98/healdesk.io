/**
 * robots.txt, read the way RFC 9309 says a crawler must read it.
 *
 * The site read fetches a few pages a clinic published for anyone to read,
 * once, because its owner asked us to. That is not crawling in the usual
 * sense, but a site that has said "no robots here" gets no robot from us
 * either: the read stops, and setup asks its three questions instead.
 *
 * The rules that apply are those of the groups naming our product token,
 * HealdeskBot, merged; failing any, those of the `*` groups. Of the rules
 * whose pattern matches a path, the longest wins, and an allow wins a tie.
 * `*` matches any run of characters and a trailing `$` anchors the end.
 */

/** The token a site names to address us, case-insensitively. */
export const ROBOTS_TOKEN = "healdeskbot";

export type RobotsRule = { allow: boolean; pattern: string };

/**
 * What a site's robots.txt said: its rules, or a status that stands for all
 * of them. A 4xx means there is no file, so everything is allowed; a 5xx
 * means the file could not be read, and RFC 9309 says to assume everything
 * is disallowed.
 */
export type Robots =
  | { kind: "rules"; rules: readonly RobotsRule[] }
  | { kind: "allow-all" }
  | { kind: "disallow-all" };

/** Bounds on what an adversarial file can make the matcher do. */
const MAX_RULES = 2_000;
const MAX_PATTERN = 1_000;

type Group = { agents: string[]; rules: RobotsRule[] };

export function parseRobots(text: string, token: string = ROBOTS_TOKEN): RobotsRule[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  let rules = 0;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      // Consecutive user-agent lines share one group; one after a rule starts a new group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase().split(/[\s/]/)[0] ?? "");
      lastWasAgent = true;
      continue;
    }
    // Only a rule ends a run of user-agent lines. Anything else (Sitemap,
    // Crawl-delay) is not ours to read and does not split a group.
    if (key !== "allow" && key !== "disallow") continue;
    lastWasAgent = false;
    if (!current || !value || rules >= MAX_RULES) continue;
    // Past the length cap a rule errs toward not reading: a Disallow is cut
    // short, which widens it, and an Allow is dropped.
    if (value.length > MAX_PATTERN && key === "allow") continue;
    current.rules.push({ allow: key === "allow", pattern: value.slice(0, MAX_PATTERN) });
    rules += 1;
  }
  const ours = groups.filter((group) => group.agents.includes(token.toLowerCase()));
  const chosen = ours.length > 0 ? ours : groups.filter((group) => group.agents.includes("*"));
  return chosen.flatMap((group) => group.rules);
}

/**
 * `*` as "any run", with the classic two-pointer backtrack: linear in the
 * common case and O(pattern × path) at worst, where a regular expression
 * built from a hostile pattern could backtrack exponentially.
 */
function wildcardMatch(pattern: string, path: string): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < path.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === path[s]) {
      p += 1;
      s += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      p += 1;
      mark = s;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      s = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

function ruleMatches(pattern: string, path: string): boolean {
  // Unanchored patterns match a prefix: "/admin" covers "/admin/users".
  return pattern.endsWith("$")
    ? wildcardMatch(pattern.slice(0, -1), path)
    : wildcardMatch(`${pattern}*`, path);
}

/** May we fetch this path (with its query string)? */
export function robotsAllows(robots: Robots, path: string): boolean {
  if (robots.kind === "allow-all") return true;
  if (robots.kind === "disallow-all") return false;
  if (path === "/robots.txt") return true;
  let best: RobotsRule | null = null;
  for (const rule of robots.rules) {
    if (!ruleMatches(rule.pattern, path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}
