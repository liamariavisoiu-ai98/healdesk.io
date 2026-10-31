import type { TextCheck } from "@/lib/portal/switch-rules";

import { UnlockLink, type UnlockTargets } from "./SwitchExplainer";

/**
 * What must hold before the payment-link text can work, under its switch, in
 * Settings and in the wizard's deposits step alike (owner, 30 October 2026).
 *
 * It never decides anything: the checks, their order and whether each is met
 * are switch-rules.ts's (`text_payment_link.checks`), the same list the
 * server reads before it lets the switch be set, so the page and the server
 * cannot disagree. The switch's own check follows the toggle above it as the
 * clinic moves it (withTextSwitch, in the caller).
 *
 * Real text first: a summary line, then a list where each step says done or
 * not yet in words beside its glyph (never colour alone) and who it is for,
 * quietly. Only the first unmet step the clinic can act on has a button; a
 * step that is healdesk's says so in a line, with no button. Pure markup, no
 * state and no motion, so it reads the same with animation off and renders on
 * the server or inside the wizard; its rows have a fixed shape, so nothing
 * shifts when a step changes.
 */
export function TextChecklist(props: { id: string; checks: readonly TextCheck[]; targets: UnlockTargets }) {
  const done = props.checks.filter((c) => c.met).length;
  const total = props.checks.length;
  const summary = done === total ? "Texting is ready" : `${done} of ${total} steps done`;
  const actionable = props.checks.find((c) => !c.met && c.who === "you" && c.unlock && props.targets[c.unlock]);
  const summaryId = `${props.id}-summary`;
  return (
    <div id={props.id} className="tcl mt-2 text-sm" data-text-checklist="">
      <p id={summaryId} className="text-ink font-semibold" role="status" aria-live="polite">
        {summary}
      </p>
      <ul aria-labelledby={summaryId} className="mt-1 grid gap-1">
        {props.checks.map((check) => (
          <li key={check.id} className="tcl-row" data-check={check.id} data-met={check.met ? "yes" : "no"}>
            <span aria-hidden="true" className={check.met ? "tcl-glyph tcl-met" : "tcl-glyph"}>
              {check.met ? "✓" : "○"}
            </span>
            <span className="min-w-0">
              <span className="text-ink">{check.label}</span>
              <span className="text-muted">
                {" "}
                · {check.met ? "Done" : "Not yet"} · {check.who === "you" ? "You" : "Healdesk"}
              </span>
              {check.waiting ? <span className="text-muted block">{check.waiting}</span> : null}
              {actionable && actionable.id === check.id ? (
                <span className="block">
                  <UnlockLink unlock={check.unlock} targets={props.targets} />
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
