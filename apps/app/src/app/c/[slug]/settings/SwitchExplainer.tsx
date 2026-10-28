import type { ReactNode } from "react";

import type { SwitchRule } from "@/lib/portal/switch-rules";

/**
 * The words, and a small picture, beside a switch that is unavailable or that
 * changes another switch (owner, 28 October 2026; CLAUDE.md, "Simplicity rule").
 *
 * The words come first and are always on the page: why the switch cannot be
 * used and what unlocks it, then what On and Off do. The picture comes second,
 * hidden from screen readers, and only repeats the words: one box lights up,
 * then the one it affects. Under reduced motion the picture is still, in its
 * last state, and everything works the same. It has a fixed size, so nothing
 * moves when it appears.
 *
 * Pure markup, no state: it renders on the server in Settings and inside the
 * wizard. It never decides availability: the reason and the unlock are passed
 * in from `switchRules` (lib/portal/switch-rules.ts).
 */

export type ExplainerPicture = {
  /** "needs": the first box lights, then the second. "resets": the first goes dark, taking the second with it. */
  mode: "needs" | "resets";
  /** Two short labels, about fourteen characters each at most. */
  from: string;
  to: string;
};

export function SwitchExplainer(props: {
  id: string;
  /** Why the switch cannot be used now: `rule.reason`, verbatim. */
  reason?: string | null;
  /** The button that fixes it, from `UnlockLink`. */
  unlock?: ReactNode;
  /** What On does, one short line. */
  on?: string;
  /** What Off does, one short line. */
  off?: string;
  /** A line about another switch this one moves. */
  note?: string;
  picture?: ExplainerPicture;
}) {
  return (
    <div id={props.id} className="sx text-muted mt-2 grid gap-1 text-sm" data-explainer="">
      {props.reason ? (
        <p data-part="reason" className="text-ink">
          {props.reason}
        </p>
      ) : null}
      {props.unlock ? <div data-part="unlock">{props.unlock}</div> : null}
      {props.on ? (
        <p data-part="on">
          <span className="font-semibold">On:</span> {props.on}
        </p>
      ) : null}
      {props.off ? (
        <p data-part="off">
          <span className="font-semibold">Off:</span> {props.off}
        </p>
      ) : null}
      {props.note ? <p data-part="note">{props.note}</p> : null}
      {props.picture ? <ExplainerSvg {...props.picture} /> : null}
    </div>
  );
}

function ExplainerSvg({ mode, from, to }: ExplainerPicture) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 240 36"
      className={`sx-picture sx-${mode}`}
      data-picture={mode}
    >
      <line className="sx-wire" x1="98" y1="18" x2="142" y2="18" />
      <line className="sx-wire sx-wire-lit" x1="98" y1="18" x2="142" y2="18" />
      <g className="sx-from">
        <rect className="sx-box" x="2" y="4" width="96" height="28" rx="14" />
        <rect className="sx-glow" x="2" y="4" width="96" height="28" rx="14" />
        <text className="sx-text" x="50" y="22" textAnchor="middle">
          {from}
        </text>
      </g>
      <g className="sx-to">
        <rect className="sx-box" x="142" y="4" width="96" height="28" rx="14" />
        <rect className="sx-glow" x="142" y="4" width="96" height="28" rx="14" />
        <text className="sx-text" x="190" y="22" textAnchor="middle">
          {to}
        </text>
      </g>
    </svg>
  );
}

// -----------------------------------------------------------------------------
// The unlock button
// -----------------------------------------------------------------------------

const UNLOCK_WORDS: Record<NonNullable<SwitchRule["unlock"]>, string> = {
  connect_stripe: "Connect Stripe",
  set_deposit: "Set a deposit",
  connect_calendar: "Connect your calendar",
  turn_on_auto_confirm: "Go to Auto-confirm",
};

/** Where each unlock goes. A null target means there is nothing to press (Stripe, when we connect it by hand). */
export type UnlockTargets = Record<NonNullable<SwitchRule["unlock"]>, string | null>;

/** The unlock button for a rule, or nothing when there is none to press. */
export function UnlockLink({
  unlock,
  targets,
}: {
  unlock: SwitchRule["unlock"];
  targets: UnlockTargets;
}) {
  if (!unlock) return null;
  const href = targets[unlock];
  if (!href) return null;
  return (
    <a
      href={href}
      className="border-line text-ink mt-1 inline-flex min-h-11 items-center rounded-full border bg-white px-5 text-sm font-semibold"
    >
      {UNLOCK_WORDS[unlock]}
    </a>
  );
}
