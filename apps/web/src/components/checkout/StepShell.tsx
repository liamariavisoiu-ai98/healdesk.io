"use client";

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
}) {
  return (
    <div className="mx-auto w-full max-w-[720px]">
      <div className="mb-8">
        <div className="mb-3 flex items-center gap-3">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="text-muted hover:text-ink text-sm font-semibold transition-colors"
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
              className="text-muted hover:text-ink -mr-1 grid size-7 shrink-0 place-items-center rounded-full text-lg leading-none transition-colors"
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
      <h1 className="font-display mt-2 text-[clamp(31.2px,4.32vw,48px)] leading-[1.06] font-medium tracking-[-0.024em]">
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
 * The line under every checkout step. "Calendar access only" because the one
 * system healdesk connects to and writes into is the clinic's Google Calendar;
 * the old "Read-only access" stopped being true when v1 started booking.
 */
export function Reassurance() {
  return (
    <p className="text-muted mt-10 text-center text-xs">
      Calendar access only · Revoke any time · We never see clinical notes
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
      className="bg-brand-gradient-deep shadow-brand inline-flex items-center gap-2 rounded-full px-8 py-4 text-base font-bold text-white transition-all duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** A large, obviously-clickable choice. Used for every single-select step. */
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
