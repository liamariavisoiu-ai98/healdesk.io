"use client";

import { useState, useTransition } from "react";

import { CodeField, isCompleteCode, Section } from "@/components/admin/ui";
import type {
  AddressChangeRow,
  ChangeClinicEmailOutcome,
  ClinicSignInView,
  CoveredAnswer,
  OpsResult,
  SetCoveredEntityOutcome,
} from "@/lib/admin/ops-client";

type Actions = {
  changeEmail: (input: {
    newEmail: string;
    code: string;
    calledBack: boolean;
  }) => Promise<OpsResult<ChangeClinicEmailOutcome>>;
  stopChange: () => Promise<OpsResult<{ status: "stopped" | "none" }>>;
  /** Every answer with the operator's fresh authenticator code (lib/admin/agreement-answer.ts). */
  setCovered: (
    answer: CoveredAnswer,
    code: string,
  ) => Promise<OpsResult<SetCoveredEntityOutcome | { status: "code_refused"; message: string }>>;
};

/** "2026-10-09 14:32 UTC": the console's clock, as everywhere else in it. */
function utc(iso: string | null): string {
  if (!iso) return "";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const STATUS_WORDS: Record<AddressChangeRow["status"], string> = {
  awaiting_confirmation: "waiting for the new address to confirm",
  pending: "confirmed, taking effect",
  applied: "applied",
  stopped: "stopped",
  expired: "link expired unused",
  failed: "closed without effect",
};

export function AccountPanel({
  view,
  actions,
  devices,
}: {
  view: OpsResult<ClinicSignInView>;
  actions: Actions;
  /** The sign-in's devices and the two acts on them (DevicesSection.tsx). */
  devices?: React.ReactNode;
}) {
  if (!view.ok) {
    return (
      <div className="py-6">
        <p className="text-red-deep font-semibold">{view.message}</p>
      </div>
    );
  }
  const v = view.data;
  const open = v.changes.find(
    (c) => c.status === "awaiting_confirmation" || c.status === "pending",
  );

  return (
    /* The shell above carries the name and the id; the sections say the rest. */
    <div>

      <Section title="The clinic's address">
        <p className="text-sm">
          <span className="font-semibold">{v.address ?? "No sign-in on file."}</span>
        </p>
        <p className="text-muted mt-1 text-sm">
          Its sign-in, the Stripe customer&rsquo;s email and the agreement&rsquo;s notice address.
          They move together, 72 hours after a change is confirmed.
        </p>
        {open ? (
          <OpenChange change={open} onStop={actions.stopChange} />
        ) : (
          <ChangeForm onChange={actions.changeEmail} />
        )}
        {v.changes.length > 0 ? (
          <ul className="mt-4 grid gap-2 text-sm">
            {v.changes.map((c) => (
              <li key={c.id} className="border-line rounded-sm border bg-white px-3 py-2">
                <span className="font-semibold">{c.newEmail}</span> in place of {c.oldEmail}:{" "}
                {STATUS_WORDS[c.status]}
                {c.status === "pending" && c.effectiveAt ? ` at ${utc(c.effectiveAt)}` : ""}
                {c.resolvedAt && c.status !== "pending" ? ` on ${utc(c.resolvedAt)}` : ""}
                <span className="text-muted block">
                  {c.source === "operator" ? "Entered by ops" : "Asked for in Settings"} by{" "}
                  {c.requestedBy}, {utc(c.createdAt)}
                  {c.stoppedBy ? ` · stopped by the ${c.stoppedBy}` : ""}
                  {c.status === "failed" && c.resolution
                    ? ` · ${c.resolution.replace(/_/g, " ")}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {devices}

      <Section title="Covered entity">
        <CoveredEntity view={v} onSet={actions.setCovered} />
      </Section>
    </div>
  );
}

function OpenChange({
  change,
  onStop,
}: {
  change: AddressChangeRow;
  onStop: Actions["stopChange"];
}) {
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="border-line mt-4 rounded-sm border px-4 py-3 text-sm">
      <p>
        Changing to <span className="font-semibold">{change.newEmail}</span>:{" "}
        {change.status === "pending"
          ? `takes effect at ${utc(change.effectiveAt)}, the end of the objection window.`
          : "waiting for the new address to use its confirmation link."}
      </p>
      <p className="text-muted mt-1">
        If either address objects, or the practice calls to say it wasn&rsquo;t them, stop it.
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await onStop();
            setNote(
              !result.ok
                ? result.message
                : result.data.status === "stopped"
                  ? "Stopped."
                  : "Nothing was open.",
            );
          })
        }
        className="border-line-strong hover:border-ink mt-3 rounded-full border px-5 py-2 text-sm font-bold disabled:opacity-50"
      >
        {pending ? "Stopping…" : "Stop this change"}
      </button>
      {note ? (
        <p role="status" className="mt-2 font-semibold">
          {note}
        </p>
      ) : null}
    </div>
  );
}

function ChangeForm({ onChange }: { onChange: Actions["changeEmail"] }) {
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="border-line mt-4 grid gap-3 border-t pt-4 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        start(async () => {
          const result = await onChange({
            newEmail: String(form.get("newEmail") ?? ""),
            code: String(form.get("code") ?? ""),
            calledBack: form.get("calledBack") === "on",
          });
          if (!result.ok) return setNote({ tone: "bad", text: result.message });
          if (result.data.status !== "entered")
            return setNote({ tone: "bad", text: result.data.message });
          setNote({
            tone: "ok",
            text: `Entered. It takes effect at ${utc(result.data.effectiveAt)}${
              result.data.emailed
                ? ", and both addresses have been told."
                : ". The notice to both addresses did not all go: check Resend."
            }`,
          });
        });
      }}
    >
      <p className="font-semibold">Change the address (the clinic lost it)</p>
      <p className="text-muted">
        Only after calling the practice back on its published number. A billing match on the help
        page is evidence, not enough on its own.
      </p>
      <label className="grid gap-1">
        <span className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">
          New address
        </span>
        <input
          name="newEmail"
          type="email"
          autoComplete="off"
          required
          className="border-line rounded-sm border bg-white px-3 py-2.5"
        />
      </label>
      <label className="flex items-center gap-2">
        <input name="calledBack" type="checkbox" />I called the practice back on its published
        number, and it confirmed this address.
      </label>
      <label className="grid gap-1">
        <span className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">
          Code from your authenticator
        </span>
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          className="border-line w-40 rounded-sm border bg-white px-3 py-2.5 font-mono"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="bg-ink w-fit rounded-full px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
      >
        {pending ? "Entering…" : "Enter the change"}
      </button>
      {note ? (
        <p
          role="status"
          className={note.tone === "bad" ? "text-red-deep font-semibold" : "font-semibold"}
        >
          {note.text}
        </p>
      ) : null}
    </form>
  );
}

const ANSWERS: { value: CoveredAnswer; label: string }[] = [
  { value: "yes", label: "Yes: it bills health insurance electronically" },
  { value: "no", label: "No" },
  { value: "not_sure", label: "Not sure" },
];

function CoveredEntity({ view, onSet }: { view: ClinicSignInView; onSet: Actions["setCovered"] }) {
  const c = view.coveredEntity;
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [code, setCode] = useState("");

  if (c.regime === "non-hipaa") {
    return (
      <p className="text-muted text-sm">
        A veterinary practice is outside HIPAA, so there is no covered-entity status to record. It
        stays under its data protection agreement.
      </p>
    );
  }

  return (
    <div className="text-sm">
      <p>
        Under a{" "}
        <span className="font-semibold">
          {c.agreementKind === "dpa"
            ? "data protection agreement"
            : c.agreementKind === "baa"
              ? "business associate agreement"
              : "no recorded agreement"}
        </span>
        . Recorded answer:{" "}
        <span className="font-semibold">
          {c.isCoveredEntity === null ? "not sure, or not asked" : c.isCoveredEntity ? "yes" : "no"}
        </span>
        .
      </p>
      {c.agreementKind === "dpa" ? (
        <p className="text-muted mt-1">
          A &ldquo;Yes&rdquo; or &ldquo;Not sure&rdquo; means the data protection agreement no
          longer covers this practice: the database refuses its client data from that moment until a
          business associate agreement is signed, and its re-sign starts.
        </p>
      ) : (
        <p className="text-muted mt-1">
          Recorded only: a business associate agreement covers the practice either way.
        </p>
      )}
      <form
        className="mt-3 grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const answer = new FormData(event.currentTarget).get("answer");
          if (answer !== "yes" && answer !== "no" && answer !== "not_sure") return;
          start(async () => {
            const result = await onSet(answer, code);
            setCode("");
            if (!result.ok) return setNote({ tone: "bad", text: result.message });
            if (result.data.status !== "recorded")
              return setNote({ tone: "bad", text: result.data.message });
            setNote({
              tone: "ok",
              text: result.data.supersedeStarted
                ? `Recorded. Its client data is refused until a business associate agreement is signed${
                    result.data.linkSent
                      ? "; the re-sign link has gone to the clinic."
                      : "; the re-sign link is not sent yet."
                  }`
                : "Recorded.",
            });
          });
        }}
      >
        <p className="font-semibold">Does the practice bill any health insurance electronically?</p>
        {ANSWERS.map((a) => (
          <label key={a.value} className="flex items-center gap-2">
            <input type="radio" name="answer" value={a.value} required />
            {a.label}
          </label>
        ))}
        <CodeField value={code} onChange={setCode} disabled={pending} approval />
        <button
          type="submit"
          disabled={pending || !isCompleteCode(code)}
          className="bg-ink mt-1 w-fit rounded-full px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
        >
          {pending ? "Recording…" : "Record the answer"}
        </button>
        {note ? (
          <p
            role="status"
            className={note.tone === "bad" ? "text-red-deep font-semibold" : "font-semibold"}
          >
            {note.text}
          </p>
        ) : null}
      </form>
    </div>
  );
}
