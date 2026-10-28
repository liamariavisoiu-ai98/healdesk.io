"use client";

import { useId, type ReactNode } from "react";

/**
 * A switch row that holds no state of its own: the wizard keeps the value and
 * saves it with its step. The same look and the same markup as `SwitchSetting`
 * (a `role="switch"` button, On or Off in words, a 44px target, the line and
 * any explainer read with it), so a switch is the same thing in both places.
 */
export function ToggleRow(props: {
  label: string;
  line: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Cannot be switched on; it can always be switched off. */
  locked?: boolean;
  /** A `SwitchExplainer`, with its id in `explainerId`. */
  explainer?: ReactNode;
  explainerId?: string;
}) {
  const labelId = useId();
  const lineId = useId();
  const disabled = Boolean(props.locked) && !props.checked;
  return (
    <div className="flex items-start justify-between gap-4" data-toggle-row="">
      <div className="min-w-0">
        <p id={labelId} className="font-semibold">
          {props.label}
        </p>
        <p id={lineId} className="text-muted mt-1 text-sm">
          {props.line}
        </p>
        {props.explainer}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-labelledby={labelId}
        aria-describedby={props.explainerId ? `${lineId} ${props.explainerId}` : lineId}
        disabled={disabled}
        onClick={() => props.onChange(!props.checked)}
        className="flex min-h-11 shrink-0 items-center gap-2 rounded-full px-1 disabled:opacity-50"
      >
        <span className="w-7 text-right text-sm font-semibold">{props.checked ? "On" : "Off"}</span>
        <span
          aria-hidden="true"
          className={`flex h-7 w-12 items-center rounded-full p-0.5 transition-colors ${
            props.checked ? "bg-green justify-end" : "bg-line-strong justify-start"
          }`}
        >
          <span className="block h-6 w-6 rounded-full bg-white shadow" />
        </span>
      </button>
    </div>
  );
}
