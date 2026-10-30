"use client";

import { useState, useTransition } from "react";

import { useApprovalPasscodeSet } from "./approval-passcode-context";

import type { OpsFailure, OpsResult } from "@/lib/admin/ops-client";
import type { Tone } from "@/lib/admin/strip-types";

/**
 * The admin console's shared pieces (E1 §3, the admin redesign of 23 October
 * 2026). Until then `Section` was copied into six panels, `Tag`, `Failure`,
 * `Empty` and `Row` lived only in OpsConsole.tsx and were re-invented ad hoc
 * elsewhere, and "done" rendered in an inherited colour because no
 * `--color-done` token existed. One file, five tones, one meaning each.
 *
 * Client-safe on purpose: it imports TYPES only from the server-only admin
 * modules (lib/admin/client-imports.test.ts), so a "use client" panel can
 * import it and a server page can render it.
 *
 * Red is for blocking only. A job that is on is not red.
 */

/** The pill behind a word, per tone. */
const PILL: Record<Tone, string> = {
  ok: "bg-tint-mint text-ink",
  warn: "bg-tint-butter text-ink",
  bad: "bg-red/10 text-red-deep",
  info: "bg-tint-sky text-ink",
  muted: "bg-paper-2 text-muted",
};

/** The dot before a word, per tone. */
const DOT: Record<Tone, string> = {
  ok: "bg-mint",
  warn: "bg-sun",
  bad: "bg-red",
  info: "bg-ink/40",
  muted: "bg-line-strong",
};

/** The text colour of an outcome line, per tone. */
const TEXT: Record<Tone, string> = {
  ok: "text-done",
  warn: "text-ink",
  bad: "text-red-deep",
  info: "text-ink",
  muted: "text-muted",
};

export const TONES: readonly Tone[] = ["ok", "warn", "bad", "info", "muted"];

/** One card with one small-caps heading: every section of every admin panel. */
export function Section({
  title,
  id,
  children,
}: {
  title: React.ReactNode;
  /** An anchor, so a link can land on the section (`#jobs`). */
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="border-line mt-8 scroll-mt-24 rounded-md border bg-white p-5">
      <h2 className="text-sm font-bold tracking-[0.08em] uppercase">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A small-caps label in a pill: a classification, a state word. */
export function Tag({ tone = "muted", children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-1 text-xs font-bold tracking-[0.06em] uppercase ${PILL[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * A dot and one or two words: a table cell's state. With `href` it is a link
 * to the tab that owns the state, so a click on a chip opens the right place.
 */
export function Chip({
  tone,
  href,
  title,
  children,
}: {
  tone: Tone;
  href?: string;
  title?: string;
  children: React.ReactNode;
}) {
  const className = `inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${PILL[tone]}${href ? " hover:ring-line-strong hover:ring-1" : ""}`;
  const inner = (
    <>
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} />
      <span>{children}</span>
    </>
  );
  return href ? (
    <a href={href} title={title} className={className}>
      {inner}
    </a>
  ) : (
    <span title={title} className={className}>
      {inner}
    </span>
  );
}

/**
 * A section that could not be read: says which, and says the sentence
 * `ops-client` wrote, which is never an upstream error body. `unauthenticated`
 * gets a link rather than a retry, because the operator's next move is a door.
 * Never a zero where nothing was read.
 */
export function Failure({ failure, what }: { failure: OpsFailure; what: string }) {
  return (
    <p role="status" className="text-red-deep mt-4 text-sm font-semibold">
      Could not read {what}: {failure.message}
      {failure.code === "unauthenticated" ? (
        <>
          {" "}
          <a href="/admin/sign-in" className="underline">
            Sign in
          </a>
        </>
      ) : null}
    </p>
  );
}

/** An empty state in one line, saying which empty: "No X." */
export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted mt-4 text-sm">{children}</p>;
}

/** One fact in a `<dl>`: a label on the left, the value on the right. */
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-4 py-0.5">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

const BUTTON_BASE =
  "inline-flex min-h-11 items-center rounded-full px-4 py-1.5 text-sm font-bold transition-colors disabled:opacity-50";
const VARIANT = {
  primary: `${BUTTON_BASE} bg-ink text-white`,
  secondary: `${BUTTON_BASE} border-line-strong hover:border-ink border`,
  destructive: `${BUTTON_BASE} border-line-strong hover:border-red border`,
} as const;

export type ActionVariant = keyof typeof VARIANT;

type ActionState = "idle" | "armed" | "working" | "done" | "refused" | "failed";

/** What every typed ops operation answers with, as this button reads it. */
export type ActionOutcome = { status: string; message?: string; auditRecorded?: boolean };

export const UNAUDITED =
  "Done, but the audit entry could not be written. Tell whoever keeps the security log.";

/**
 * The one button pattern for send, retry and audit: idle → working → done,
 * refused or failed, the outcome in one `role="status"` line beneath. The
 * label is a verb ("Send", "Send again", "Retry", "Run audit"). A failed call
 * says the ops client's own sentence, a refusal says upstream's, and an act
 * whose audit row was not written says so: an unrecorded act that looks
 * recorded is what an audit trail exists to stop.
 *
 * A button with `confirm` (every `destructive` one, and any other given a
 * sentence) asks once: the first press shows the sentence and a second
 * button; nothing runs until that is pressed. Anything irreversible to a
 * clinic (a send, a refund, a close) still needs the fresh-code step its
 * panel already has; this button only stops a slip of the hand.
 */
export function ActionButton<T extends ActionOutcome>({
  label,
  run,
  done,
  variant = "secondary",
  confirm,
  disabled = false,
}: {
  label: string;
  run: () => Promise<OpsResult<T>>;
  /** The sentence to show once it went; null for none. */
  done?: (data: T) => string | null;
  variant?: ActionVariant;
  /** The sentence shown before the second press; a destructive button asks even without one. */
  confirm?: string;
  disabled?: boolean;
}) {
  const [state, setState] = useState<ActionState>("idle");
  const [said, setSaid] = useState<{ tone: Tone; text: string } | null>(null);
  const [pending, start] = useTransition();

  function go(): void {
    setSaid(null);
    setState("working");
    start(async () => {
      const result = await run();
      if (!result.ok) {
        setState("failed");
        setSaid({ tone: "bad", text: result.message });
        return;
      }
      const data = result.data;
      if (data.status === "refused") {
        setState("refused");
        setSaid({ tone: "bad", text: data.message ?? "Refused." });
        return;
      }
      const text = done?.(data) ?? null;
      setState("done");
      if (data.auditRecorded === false) {
        setSaid({ tone: "warn", text: text ? `${text} ${UNAUDITED}` : UNAUDITED });
        return;
      }
      setSaid(text ? { tone: "ok", text } : null);
    });
  }

  const working = pending || state === "working";
  return (
    <div className="inline-flex flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled || working}
          aria-busy={working || undefined}
          onClick={() => {
            if ((variant === "destructive" || confirm !== undefined) && state !== "armed") {
              setState("armed");
              return;
            }
            go();
          }}
          className={VARIANT[variant]}
        >
          {working ? "Working…" : state === "armed" ? `Yes, ${label.toLowerCase()}` : label}
        </button>
        {state === "armed" ? (
          <>
            <span className="text-sm">{confirm ?? "Are you sure?"}</span>
            <button
              type="button"
              onClick={() => setState("idle")}
              className="text-muted inline-flex min-h-11 items-center text-sm underline"
            >
              Cancel
            </button>
          </>
        ) : null}
      </div>
      {said ? (
        <p role="status" className={`text-sm ${TEXT[said.tone]} ${said.tone === "bad" ? "font-semibold" : ""}`}>
          {said.text}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A clinic's id, selectable and one click to copy: the id every operator task
 * needs (run-task.sh, the db-apply and db-query workflows). Ids are text on
 * every admin page (app/admin/ids-visible.test.ts), never only inside a link.
 */
export function ClinicId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <p className="text-muted mt-1.5 flex flex-wrap items-center gap-x-2 text-xs">
      <span>Clinic id</span>
      <code className="font-mono select-all">{id}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(id).then(() => setCopied(true));
        }}
        className="text-red-deep hover:text-red font-semibold"
      >
        {copied ? "Copied" : "Copy id"}
      </button>
    </p>
  );
}

/**
 * The fresh authenticator code a step-up act asks for at the moment of the
 * act (lib/admin/fresh-code.ts), or, with `approval`, the approval passcode
 * (lib/admin/approval-passcode.ts), as the Account tab's forms draw it: six
 * digits, numeric keypad, one-time-code autofill. Controlled, so a panel
 * can hand the code to an ActionButton's `run` and keep the button disabled
 * until six digits are typed; the check itself is the server's.
 */
export function CodeField({
  value,
  onChange,
  disabled = false,
  approval = false,
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  /**
   * An approval decision or a covered-entity answer (lane P7h): the box asks
   * for the approval passcode, the authenticator code still accepted, and
   * says so when this deployment has no passcode.
   */
  approval?: boolean;
}) {
  const passcodeSet = useApprovalPasscodeSet();
  return (
    <label className="grid gap-1">
      <span className="text-muted text-xs font-bold tracking-[0.06em] uppercase">
        {approval ? "Approval passcode (or authenticator code)" : "Code from your authenticator"}
      </span>
      {approval && passcodeSet === false ? (
        <span className="text-muted text-xs">
          The approval passcode is not set on this deployment: only your authenticator code works.
        </span>
      ) : null}
      <input
        name="code"
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        disabled={disabled}
        className="border-line w-40 rounded-sm border bg-white px-3 py-2.5 font-mono"
      />
    </label>
  );
}

/** Whether a typed code is one the server could accept: six digits. */
export function isCompleteCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

// E1 §3 names an `IssueAnchor` too. Nothing can render one until apps/app's
// alerts carry an id that a tab's row holds, so it is not here: no dead code.
