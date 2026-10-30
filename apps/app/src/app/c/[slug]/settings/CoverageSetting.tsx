"use client";

import type { CoverageModeId } from "@healdesk/catalog";
import { useState } from "react";

import type { ForwardingView } from "@/lib/setup/forwarding";

import { coverageSavedAction } from "../forwarding-actions";
import { ForwardingStepsPanel } from "../ForwardingStepsPanel";

import { ChoiceSetting } from "./controls";

/**
 * Settings → Channels, "Which calls reach AYA" (spec, "Every switch in the
 * portal": voice coverage "Shows the matching forwarding instructions again
 * whenever it is changed"; plan F2). Which calls reach AYA is carried out by
 * the codes the clinic dials, so a changed mode with no new steps on screen
 * would change nothing on the line. Once phone is ready for forwarding:
 *
 *   - the steps for the mode chosen, folded away until wanted;
 *   - after a change, open: the undo for the mode just left, then the steps
 *     for the new one, for the clinic's phone system and carrier, with the
 *     same pickers as the wizard's forwarding screen.
 *
 * The page is read again after the save, so Safety net's undo steps follow
 * the new mode too.
 */
export function CoverageSetting(props: {
  slug: string;
  legend: string;
  line: string;
  applies?: string | null;
  options: readonly { id: CoverageModeId; label: string; line: string }[];
  initial: CoverageModeId;
  /** The forwarding steps for each mode, for this clinic's line. */
  views: Readonly<Record<CoverageModeId, ForwardingView>>;
}) {
  const [mode, setMode] = useState<CoverageModeId>(props.initial);
  const [left, setLeft] = useState<CoverageModeId | null>(null);
  const changed = left !== null && left !== mode;

  return (
    <div>
      <ChoiceSetting
        slug={props.slug}
        settingKey="coverage_mode"
        legend={props.legend}
        line={props.line}
        applies={props.applies}
        options={props.options}
        initial={props.initial}
        onSaved={(next, before) => {
          // The mode the line was set up for: the first one left, until it is chosen again.
          setLeft((first) => first ?? before);
          setMode(next);
          void coverageSavedAction(props.slug).catch(() => undefined);
        }}
      />
      {changed ? (
        <section
          aria-labelledby="coverage-steps-heading"
          className="border-line bg-paper-2 mb-3 grid gap-2 rounded-md border px-4 py-3"
        >
          <h3 id="coverage-steps-heading" className="font-semibold">
            Change your call forwarding to match
          </h3>
          <p className="text-sm">
            Which calls reach AYA depends on the forwarding set on your main line. Update it to
            match your new choice.
          </p>
          <ForwardingStepsPanel
            slug={props.slug}
            view={props.views[mode]}
            previous={props.views[left!]}
          />
        </section>
      ) : (
        <details className="mb-3 text-sm">
          <summary className="min-h-11 cursor-pointer py-2 font-semibold">
            Your call forwarding steps for this choice
          </summary>
          <ForwardingStepsPanel slug={props.slug} view={props.views[mode]} />
        </details>
      )}
    </div>
  );
}
