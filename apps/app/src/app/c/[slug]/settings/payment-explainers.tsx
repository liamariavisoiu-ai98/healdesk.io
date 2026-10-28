import type { SwitchRule } from "@/lib/portal/switch-rules";

import {
  SwitchExplainer,
  UnlockLink,
  type ExplainerPicture,
  type UnlockTargets,
} from "./SwitchExplainer";

/**
 * What each payment switch says beside itself, in Settings and in the wizard.
 *
 * Availability is never decided here: every explainer takes the `SwitchRule`
 * that `switchRules` produced and prints its `reason` as given, with the
 * button for its `unlock`. This file only holds the words for On and Off and
 * picks the picture that matches the rule's unlock (lib/portal/switch-rules.ts).
 */

export const TEXT_LINK_LINE =
  "After a booking on a call, AYA is designed to offer to text a payment link, once, only if the caller agrees.";
export const DEPOSITS_LINE = "Let AYA ask for a deposit when a treatment needs one.";
export const PAYMENT_ASK_LINE = "How much AYA asks the patient to pay when a booking is made.";

/** The first box of the picture: what has to be in place. */
const NEEDS_LABEL: Record<NonNullable<SwitchRule["unlock"]>, string> = {
  connect_stripe: "Stripe",
  set_deposit: "A deposit",
  connect_calendar: "Calendar",
  turn_on_auto_confirm: "Auto-confirm",
};

function needsPicture(rule: SwitchRule, to: string): ExplainerPicture | undefined {
  return rule.unlock ? { mode: "needs", from: NEEDS_LABEL[rule.unlock], to } : undefined;
}

export function DepositsExplainer(props: {
  id: string;
  rule: SwitchRule;
  targets: UnlockTargets;
}) {
  if (props.rule.enabled) return null;
  return (
    <SwitchExplainer
      id={props.id}
      reason={props.rule.reason}
      unlock={<UnlockLink unlock={props.rule.unlock} targets={props.targets} />}
      picture={needsPicture(props.rule, "Deposits")}
    />
  );
}

export function TextLinkExplainer(props: {
  id: string;
  rule: SwitchRule;
  targets: UnlockTargets;
}) {
  return (
    <SwitchExplainer
      id={props.id}
      reason={props.rule.reason}
      unlock={<UnlockLink unlock={props.rule.unlock} targets={props.targets} />}
      on="AYA offers to text the link once the booking is made."
      off="Your team collects the deposit."
      picture={needsPicture(props.rule, "Text link")}
    />
  );
}

export function FullPaymentExplainer(props: {
  id: string;
  rule: SwitchRule;
  targets: UnlockTargets;
}) {
  return (
    <SwitchExplainer
      id={props.id}
      reason={props.rule.reason}
      unlock={<UnlockLink unlock={props.rule.unlock} targets={props.targets} />}
      on="AYA asks for the whole price, not only the deposit."
      off="AYA asks for the deposit only."
      note={
        props.rule.enabled
          ? "If you turn off Auto-confirm or disconnect Stripe or your calendar, this goes back to Deposit only, and we tell you."
          : undefined
      }
      picture={
        props.rule.enabled
          ? { mode: "resets", from: "Auto-confirm", to: "Full payment" }
          : needsPicture(props.rule, "Full payment")
      }
    />
  );
}
