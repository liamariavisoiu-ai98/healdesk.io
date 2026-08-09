"use client";

/**
 * Shared chrome for every checkout step.
 *
 * One decision per screen, progress always visible, and a reassurance line that
 * never leaves — because the two things a clinic owner is actually weighing are
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
}: {
  step: number;
  totalSteps: number;
  eyebrow: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onBack?: () => void;
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
          <span className="text-muted ml-auto text-xs font-bold tracking-[0.14em] uppercase">
            Step {step} of {totalSteps}
          </span>
        </div>

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
      </div>

      <p className="text-muted text-xs font-bold tracking-[0.14em] uppercase">
        {eyebrow}
      </p>
      <h1 className="font-display mt-2 text-[clamp(26px,3.6vw,40px)] leading-[1.06] font-medium tracking-[-0.024em]">
        {title}
      </h1>
      {subtitle ? (
        <p className="text-muted mt-3 text-[16px] font-medium">{subtitle}</p>
      ) : null}

      <div className="mt-8">{children}</div>
    </div>
  );
}

export function Reassurance() {
  return (
    <p className="text-muted mt-10 text-center text-xs">
      Read-only access · Revoke any time · We never see clinical notes
    </p>
  );
}

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
      className="bg-brand-gradient shadow-brand inline-flex items-center gap-2 rounded-full px-8 py-4 text-base font-bold text-white transition-all duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-40"
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
            <span className="font-display text-[19px] leading-tight font-medium">
              {title}
            </span>
            {badge ? (
              <span className="bg-paper-2 text-muted rounded-full px-2.5 py-1 text-[11px] font-bold tracking-[0.06em] uppercase">
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
