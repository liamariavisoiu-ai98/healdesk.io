"use client";

import { type ReactNode, type Ref, useId } from "react";

/**
 * Shared chrome for every checkout step.
 *
 * One decision per screen, progress always visible, and a reassurance line that
 * never leaves, because the two things a clinic owner is actually weighing are
 * "how long will this take" and "what are you getting access to".
 */
export function StepShell({
  step,
  totalSteps,
  eyebrow,
  title,
  subtitle,
  children,
  onBack,
  onClose,
  headingRef,
}: {
  /** Both absent on a one-screen form: no progress bar, no "Step 1 of 1". */
  step?: number;
  totalSteps?: number;
  eyebrow: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onBack?: () => void;
  /**
   * Present only when the flow is hosted in something dismissable.
   *
   * On its own page the site chrome supplies the way out. In a modal it does
   * not, and Escape is deliberately blocked once an agreement has been signed,
   * so without this the buyer can reach a screen with no exit at all.
   */
  onClose?: () => void;
  /**
   * The heading, which the flow focuses when the step changes, so a keyboard
   * or screen reader user starts the new step at its title instead of at the
   * top of the document or on a button that no longer exists.
   */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="mx-auto w-full max-w-[720px]">
      <div className="mb-8">
        <div className="mb-3 flex items-center gap-3">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="text-muted hover:text-ink -ml-2 min-h-11 rounded-md px-2 text-sm font-semibold transition-colors"
            >
              ← Back
            </button>
          ) : (
            <span />
          )}
          {step && totalSteps ? (
            <span className="text-muted ml-auto text-xs font-bold tracking-[0.14em] uppercase">
              Step {step} of {totalSteps}
            </span>
          ) : (
            <span className="ml-auto" />
          )}

          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-muted hover:text-ink -mr-2 grid size-11 shrink-0 place-items-center rounded-full text-lg leading-none transition-colors"
            >
              <span aria-hidden>&times;</span>
            </button>
          ) : null}
        </div>

        {step && totalSteps ? (
          <div
            className="bg-line/40 flex h-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-valuenow={step}
            aria-valuemin={1}
            aria-valuemax={totalSteps}
            aria-label={`Step ${step} of ${totalSteps}`}
          >
            <span
              className="bg-brand-gradient h-full transition-[width] duration-500 ease-panel"
              style={{ width: `${(step / totalSteps) * 100}%` }}
            />
          </div>
        ) : null}
      </div>

      <p className="text-muted text-xs font-bold tracking-[0.14em] uppercase">
        {eyebrow}
      </p>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="font-display mt-2 text-[clamp(31.2px,4.32vw,48px)] leading-[1.06] font-medium tracking-[-0.024em] outline-none"
      >
        {title}
      </h1>
      {subtitle ? (
        <p className="text-muted mt-3 text-[19.2px] font-medium">{subtitle}</p>
      ) : null}

      <div className="mt-8">{children}</div>
    </div>
  );
}

/**
 * The line under every checkout step. What healdesk can reach is only what
 * the clinic signs in to (its calendar, its channels, its payment account),
 * and never its clinical records: v1 reads no EMR or point of sale.
 */
export function Reassurance() {
  return (
    <p className="text-muted mt-10 text-center text-xs">
      No access to your clinical records · Every connection is a sign-in you can revoke
    </p>
  );
}

/**
 * The deep gradient, because white on the brand gradient's orange end is
 * 2.67:1 and this button's label is white body text (globals.css explains
 * the stops).
 */
export function PrimaryButton({
  children,
  disabled,
  type = "button",
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  type?: "button" | "submit";
  onClick?: () => void;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="bg-brand-gradient-deep shadow-brand inline-flex min-h-12 items-center gap-2 rounded-full px-8 py-4 text-base font-bold text-white transition-all duration-200 motion-safe:hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** A large, obviously-clickable choice. */
export function ChoiceCard({
  selected,
  onSelect,
  title,
  description,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description?: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={[
        "group relative w-full rounded-2xl border p-5 text-left transition-all duration-200",
        selected
          ? "border-red bg-orange/[0.06] shadow-brand"
          : "border-line hover:border-line-strong bg-white",
      ].join(" ")}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={[
            "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 transition-colors",
            selected ? "border-red bg-red" : "border-line-strong",
          ].join(" ")}
        >
          {selected ? (
            <span className="size-1.5 rounded-full bg-white" />
          ) : null}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-display text-[22.8px] leading-tight font-medium">
              {title}
            </span>
            {badge ? (
              <span className="bg-paper-2 text-muted rounded-full px-2.5 py-1 text-[13.2px] font-bold tracking-[0.06em] uppercase">
                {badge}
              </span>
            ) : null}
          </span>
          {description ? (
            <span className="text-muted mt-1.5 block text-sm font-medium">
              {description}
            </span>
          ) : null}
        </span>
      </div>
    </button>
  );
}

/** The small caps label every field and group in the flow carries. */
export const FIELD_LABEL = "text-[15.6px] font-bold tracking-[0.04em] uppercase";

export type RadioOption<T extends string> = {
  id: T;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
};

/**
 * One answer from several, as a real radio group.
 *
 * Native radio inputs, visually hidden inside their labels, so the arrow keys
 * move between answers and the space bar picks one exactly as a browser's
 * own radio group does, and a screen reader hears "radio button, 2 of 5". The
 * container carries `role="radiogroup"` and the visible question as its name.
 * Every target is at least 44px tall.
 *
 * `layout="chips"` wraps short answers onto lines; `"cards"` stacks answers
 * that need a sentence each.
 */
export function RadioGroup<T extends string>({
  label,
  hint,
  name,
  options,
  value,
  onChange,
  layout = "chips",
  invalid,
  labelClassName = FIELD_LABEL,
}: {
  label: ReactNode;
  hint?: ReactNode;
  name: string;
  options: readonly RadioOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  layout?: "chips" | "cards";
  invalid?: boolean;
  labelClassName?: string;
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined} aria-invalid={invalid || undefined}>
      <p id={`${id}-label`} className={labelClassName}>
        {label}
      </p>
      {hint ? (
        <p id={`${id}-hint`} className="text-muted mt-1.5 text-sm">
          {hint}
        </p>
      ) : null}
      <div className={layout === "chips" ? "mt-3 flex flex-wrap gap-2" : "mt-3 grid gap-2"}>
        {options.map((option) => {
          const checked = option.id === value;
          return (
            <label
              key={option.id}
              className={[
                "relative flex min-h-11 items-start gap-3 border transition-colors has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-orange",
                layout === "chips" ? "rounded-full px-4 py-2.5" : "rounded-xl px-4 py-3",
                option.disabled
                  ? "border-line cursor-not-allowed bg-paper-2 opacity-60"
                  : checked
                    ? "border-red bg-red/[0.06] cursor-pointer"
                    : "border-line hover:border-line-strong cursor-pointer bg-white",
              ].join(" ")}
            >
              <input
                type="radio"
                name={name}
                value={option.id}
                checked={checked}
                disabled={option.disabled}
                onChange={() => onChange(option.id)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={[
                  "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border-2",
                  checked ? "border-red bg-red" : "border-line-strong bg-white",
                ].join(" ")}
              >
                {checked ? <span className="size-1.5 rounded-full bg-white" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{option.label}</span>
                {option.description ? (
                  <span className="text-muted mt-0.5 block text-xs leading-relaxed">{option.description}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** A labelled text input with an optional hint, in the flow's style. */
export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = "text",
  readOnly,
  disabled,
  invalid,
  maxLength,
  autoComplete,
  inputMode,
  inputClassName,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  type?: string;
  readOnly?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  maxLength?: number;
  autoComplete?: string;
  inputMode?: "url" | "email" | "text";
  inputClassName?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={`block ${FIELD_LABEL}`}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        disabled={disabled}
        maxLength={maxLength}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-invalid={invalid || undefined}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={[
          "text-ink placeholder:text-muted mt-2 w-full rounded-xl border px-4 py-3 outline-none transition-colors disabled:opacity-50",
          readOnly ? "bg-paper-2" : "bg-white",
          invalid ? "border-red" : "border-line focus:border-orange",
          // The type size is the caller's when it styles the input at all, so
          // two font sizes never compete in one class list.
          inputClassName ?? "text-[19.2px]",
        ].join(" ")}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-muted mt-1.5 text-xs">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
