"use client";

import { useCallback, useId, useState, type ReactNode } from "react";

import { useAnnounce } from "../feedback";

import { saveSettingAction, type SettingActionResult } from "./actions";

/**
 * Settings' controls (plan Part F2 and F8): a switch, a set of choices, a
 * text field and a set of checkboxes, each of which saves the moment it is
 * changed and says what happened in a toast that names the consequence.
 *
 * Accessibility, as the plan asks: a switch is a button with `role="switch"`,
 * `aria-checked` and `aria-describedby` pointing at its one line; it shows
 * "On" or "Off" in words beside the track, never by colour alone; every
 * target is at least 44px; and every save is announced once, through one
 * polite status region for the page. Nothing animates beyond a colour change,
 * and the global stylesheet stops even that under reduced motion.
 *
 * A save the server refuses puts the control back as it was and shows why;
 * where the refusal is a step-up, the toast links to it.
 */

/** Save one setting and announce the outcome. */
export function useSave(
  slug: string,
): (key: string, value: unknown) => Promise<SettingActionResult> {
  const announce = useAnnounce();
  return useCallback(
    async (key: string, value: unknown) => {
      let result: SettingActionResult;
      try {
        result = await saveSettingAction(slug, key, value);
      } catch {
        result = { ok: false, message: "Something went wrong on our side. Try again in a moment." };
      }
      announce(
        result.ok
          ? { text: result.toast, tone: "ok" }
          : { text: result.message, tone: "problem", stepUpHref: result.stepUpHref },
      );
      return result;
    },
    [slug, announce],
  );
}

// -----------------------------------------------------------------------------
// A switch
// -----------------------------------------------------------------------------

export function SwitchSetting(props: {
  slug: string;
  settingKey: string;
  label: string;
  /** What the switch does, in one line (spec, "Admin portal principles"). */
  line: string;
  /** "Applies when phone opens.", while the channels it governs are not answering. */
  applies?: string | null;
  initial: boolean;
  /** Why it cannot be switched on now, when it cannot; the switch is then disabled. */
  blockedLine?: string | null;
  /**
   * A `SwitchExplainer` for this switch, shown under its line. When it is
   * given, it says why the switch is blocked, so `blockedLine` only disables
   * the switch and is not repeated in the line. Pass its id as `explainerId`
   * so a screen reader reads it with the switch.
   */
  explainer?: ReactNode;
  explainerId?: string;
}) {
  const save = useSave(props.slug);
  const [on, setOn] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const labelId = useId();
  const lineId = useId();

  async function toggle() {
    const next = !on;
    setOn(next);
    setBusy(true);
    const result = await save(props.settingKey, next);
    if (!result.ok) setOn(!next);
    setBusy(false);
  }

  const blocked = Boolean(props.blockedLine) && !on;
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p id={labelId} className="font-semibold">
          {props.label}
        </p>
        <p id={lineId} className="text-muted mt-1 text-sm">
          {props.line}
          {props.applies ? ` ${props.applies}` : ""}
          {blocked && !props.explainer ? ` ${props.blockedLine}` : ""}
        </p>
        {props.explainer}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={labelId}
        aria-describedby={props.explainerId ? `${lineId} ${props.explainerId}` : lineId}
        disabled={busy || blocked}
        onClick={() => void toggle()}
        className="flex min-h-11 shrink-0 items-center gap-2 rounded-full px-1 disabled:opacity-50"
      >
        <span className="w-7 text-right text-sm font-semibold">{on ? "On" : "Off"}</span>
        <span
          aria-hidden="true"
          className={`flex h-7 w-12 items-center rounded-full p-0.5 transition-colors ${
            on ? "bg-green justify-end" : "bg-line-strong justify-start"
          }`}
        >
          <span className="block h-6 w-6 rounded-full bg-white shadow" />
        </span>
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// One of several choices
// -----------------------------------------------------------------------------

export function ChoiceSetting<T extends string>(props: {
  slug: string;
  settingKey: string;
  legend: string;
  line?: string;
  applies?: string | null;
  options: readonly { id: T; label: string; line?: string; disabled?: boolean }[];
  initial: T;
  /** Told of each choice the server saved, with the one it replaced. */
  onSaved?: (next: T, before: T) => void;
  /** A `SwitchExplainer` for the choice that is unavailable or moves a switch. */
  explainer?: ReactNode;
  explainerId?: string;
}) {
  const save = useSave(props.slug);
  const [value, setValue] = useState<T>(props.initial);
  const [busy, setBusy] = useState(false);
  const name = useId();
  const lineId = useId();

  async function choose(next: T) {
    if (next === value) return;
    const before = value;
    setValue(next);
    setBusy(true);
    const result = await save(props.settingKey, next);
    if (!result.ok) setValue(before);
    else props.onSaved?.(next, before);
    setBusy(false);
  }

  return (
    <fieldset
      className="grid gap-2 py-3"
      aria-describedby={
        [props.line || props.applies ? lineId : null, props.explainerId ?? null]
          .filter(Boolean)
          .join(" ") || undefined
      }
    >
      <legend className="font-semibold">{props.legend}</legend>
      {props.line || props.applies ? (
        <p id={lineId} className="text-muted -mt-1 text-sm">
          {props.line}
          {props.line && props.applies ? " " : ""}
          {props.applies}
        </p>
      ) : null}
      {props.options.map((option) => {
        const id = `${name}-${option.id}`;
        return (
          <label
            key={option.id}
            htmlFor={id}
            className={`border-line flex min-h-11 gap-3 rounded-md border bg-white px-4 py-3 ${
              option.disabled && value !== option.id ? "opacity-60" : "cursor-pointer"
            }`}
          >
            <input
              id={id}
              type="radio"
              name={name}
              value={option.id}
              checked={value === option.id}
              disabled={busy || (option.disabled === true && value !== option.id)}
              onChange={() => void choose(option.id)}
              className="mt-1 h-5 w-5 shrink-0"
            />
            <span>
              <span className="block font-semibold">{option.label}</span>
              {option.line ? <span className="text-muted block text-sm">{option.line}</span> : null}
            </span>
          </label>
        );
      })}
      {props.explainer}
    </fieldset>
  );
}

// -----------------------------------------------------------------------------
// A text field with its own Save
// -----------------------------------------------------------------------------

export function TextSetting(props: {
  slug: string;
  settingKey: string;
  label: string;
  hint?: string | null;
  applies?: string | null;
  initial: string;
  placeholder?: string;
  type?: "text" | "tel";
  inputMode?: "text" | "tel";
  autoComplete?: string;
  multiline?: boolean;
  maxLength?: number;
  /** Shown before the field, e.g. the locked AI line a greeting follows. */
  before?: ReactNode;
  /** A "Use the default" button, which saves an empty value. */
  resetLabel?: string;
}) {
  const save = useSave(props.slug);
  const [value, setValue] = useState(props.initial);
  const [saved, setSaved] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const hintId = useId();

  async function submit(next: string) {
    setBusy(true);
    const result = await save(props.settingKey, next);
    if (result.ok) {
      setSaved(next);
      setValue(next);
    }
    setBusy(false);
  }

  const describedBy = props.hint || props.applies ? hintId : undefined;
  const common = {
    id,
    value,
    maxLength: props.maxLength,
    placeholder: props.placeholder,
    "aria-describedby": describedBy,
    className: "border-line w-full rounded-md border bg-white px-4 py-3 text-base",
  };
  return (
    <form
      noValidate
      className="grid gap-2 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(value);
      }}
    >
      <label htmlFor={id} className="font-semibold">
        {props.label}
      </label>
      {props.before}
      {props.multiline ? (
        <textarea {...common} rows={3} onChange={(event) => setValue(event.target.value)} />
      ) : (
        <input
          {...common}
          type={props.type ?? "text"}
          inputMode={props.inputMode}
          autoComplete={props.autoComplete ?? "off"}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
      {describedBy ? (
        <p id={hintId} className="text-muted text-sm">
          {props.hint}
          {props.hint && props.applies ? " " : ""}
          {props.applies}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || value === saved}
          className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {props.resetLabel && saved !== "" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit("")}
            className="border-line min-h-11 rounded-full border px-5 text-sm font-semibold disabled:opacity-50"
          >
            {props.resetLabel}
          </button>
        ) : null}
      </div>
    </form>
  );
}

// -----------------------------------------------------------------------------
// Several checkboxes, saved as one list
// -----------------------------------------------------------------------------

export function ChecklistSetting(props: {
  slug: string;
  settingKey: string;
  legend: string;
  line?: string;
  applies?: string | null;
  options: readonly { id: string; label: string }[];
  initial: readonly string[];
}) {
  const save = useSave(props.slug);
  const [chosen, setChosen] = useState<string[]>([...props.initial]);
  const [busy, setBusy] = useState(false);
  const name = useId();
  const lineId = useId();

  async function toggle(id: string) {
    const before = chosen;
    const next = chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id];
    setChosen(next);
    setBusy(true);
    const result = await save(props.settingKey, next);
    if (!result.ok) setChosen(before);
    setBusy(false);
  }

  return (
    <fieldset className="grid gap-2 py-3" aria-describedby={lineId}>
      <legend className="font-semibold">{props.legend}</legend>
      <p id={lineId} className="text-muted -mt-1 text-sm">
        {props.line}
        {props.line && props.applies ? " " : ""}
        {props.applies}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {props.options.map((option) => {
          const id = `${name}-${option.id}`;
          return (
            <label
              key={option.id}
              htmlFor={id}
              className="border-line flex min-h-11 cursor-pointer items-center gap-2 rounded-md border bg-white px-3 py-2"
            >
              <input
                id={id}
                type="checkbox"
                checked={chosen.includes(option.id)}
                disabled={busy}
                onChange={() => void toggle(option.id)}
                className="h-5 w-5 shrink-0"
              />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
