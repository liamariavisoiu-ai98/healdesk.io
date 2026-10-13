import { SEGMENT_DEFINITIONS, type Segment } from "@healdesk/catalog";

export { SEGMENTS, SEGMENT_LABELS, type Segment } from "@healdesk/catalog";

/**
 * Classification rules and launch guidance.
 *
 * The enum lives in @healdesk/catalog, and so — since the veterinary and
 * massage labels were added — do the per-label decision rules, as
 * `SEGMENT_DEFINITIONS`. They used to be a prose block here, and the enum
 * gained six segments in one commit without the block learning any of them:
 * the classifier was still told to file chiropractors under `other-medical`
 * while the report tallied a `chiropractic` bucket it could never fill.
 * A Record over the enum makes that a type error. What stays here is the
 * rendering into the column layout the prompt uses, and the prospecting-side
 * judgement about which segments are worth launching into.
 */

const ID_COLUMN = 18;

/**
 * The definitions as the classifier sees them: one label per line, the id in
 * a fixed-width column, the rule wrapped underneath it. Column layout rather
 * than JSON because the model reads it once per clinic and a table of
 * fifteen-word rules scans better than fifteen quoted strings.
 */
export const SEGMENT_RULES = Object.entries(SEGMENT_DEFINITIONS)
  .map(([id, rule]) => {
    const words = rule.split(" ");
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      if (line && line.length + 1 + word.length > 62) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
    const indent = " ".repeat(ID_COLUMN);
    return [id.padEnd(ID_COLUMN) + lines[0], ...lines.slice(1).map((l) => indent + l)].join("\n");
  })
  .join("\n");

/**
 * Segments worth a tuned agent, and why.
 *
 * Ordered by the criteria that actually drive value for this product — see
 * docs/state-of-play.md, Part 3. Ticket size is deliberately NOT here. It was
 * left out when the plan was $249 a month, on the reasoning that one booked
 * appointment covered the cost in every one of these segments. Since the
 * step pricing of 13 October 2026 a plan runs from $40 a month (100 web chat
 * conversations) to $2,100 (1,500 voice minutes and 1,500 Meta Chat
 * conversations), $400 for the sheet's own example of 500 voice minutes
 * (packages/catalog/src/plans.ts), so that reasoning needs re-checking per
 * segment, at the step a clinic of that segment would pick, before it is
 * relied on.
 */
export const LAUNCH_PRIORITY: Partial<Record<Segment, string>> = {
  injectables:
    "Only segment with transaction-level evidence of phone dependence (78% of ~20,000 appointments booked by phone, not online). Largest procedure volume, >90% independently owned, one decider. Weakness: high repeat-patient share, so the answered-call story must target NEW patients specifically.",
  "body-contouring":
    "High consideration, consultation-gated, largely new-patient traffic — so defection on an unanswered call is high. Weakness: several materially different device conversations, so one agent config serves fewer clinics.",
  "weight-loss-glp1":
    "Mostly new-to-practice cold traffic asking the same few questions about price and start date. Weakness: compounding enforcement since the FDA shortage delistings makes these clinics the likeliest to churn, and callers drift toward clinical questions. v1 does no clinical intake: it takes callback-slip details and routes anything clinical to staff.",
};

/** Segments to avoid at launch, with the reason stated so it is re-checkable. */
export const LAUNCH_AVOID: Partial<Record<Segment, string>> = {
  "laser-skin":
    "Likely the largest bucket and the worst fit: chain-dominated (Milan 400+, LaserAway ~200, Ideal Image 140+), so many rows collapse to a handful of central buyers who already run call centres. Lowest lifetime value — the course completes and the patient leaves.",
  "not-a-target": "Not a clinic.",
};
