"use client";

import type { ConnectionGuide } from "@healdesk/catalog";
import { useActionState, useState } from "react";

import { connectPlatform, type ConnectState } from "../actions";

/**
 * The connection wizard.
 *
 * One step visible at a time, with a copy button on anything the clinic has to
 * paste elsewhere. The design assumption is that the person doing this has
 * never seen an API key and is doing it between patients — so nothing is
 * clever, everything is skippable, and the credential form only appears once
 * they've been through the steps.
 *
 * The last screen reads back what the connection can and cannot see. That is
 * the point of the whole flow: it demonstrates the read-only promise rather
 * than asserting it.
 */
export function ConnectWizard({
  guide,
  platformName,
  clinicSlug,
}: {
  guide: ConnectionGuide;
  platformName: string;
  clinicSlug: string;
}) {
  const [state, action, pending] = useActionState<ConnectState, FormData>(
    connectPlatform,
    { status: "idle" },
  );
  const [step, setStep] = useState(0);
  const atForm = step >= guide.steps.length;

  if (state.status === "saved") {
    return (
      <div className="rounded-2xl border border-[color:var(--color-line)] bg-white p-6">
        <p className="text-lg font-semibold">Connected to {platformName}.</p>

        {state.note ? (
          <p className="mt-2 text-sm text-[color:var(--color-muted)]">
            {state.note}
          </p>
        ) : null}

        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <div>
            <p className="text-[13px] font-bold tracking-[0.04em] uppercase">
              What we can see
            </p>
            <ul className="mt-2 space-y-1.5 text-sm">
              {state.canSee.map((item) => (
                <li key={item}>✓ {item}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-[13px] font-bold tracking-[0.04em] uppercase">
              What we cannot
            </p>
            <ul className="mt-2 space-y-1.5 text-sm text-[color:var(--color-muted)]">
              {state.cannotSee.map((item) => (
                <li key={item}>✕ {item}</li>
              ))}
            </ul>
          </div>
        </div>

        <a
          href={`/c/${clinicSlug}`}
          className="mt-8 inline-block rounded-full bg-[color:var(--color-ink)] px-6 py-3 text-sm font-bold text-white"
        >
          Done
        </a>
      </div>
    );
  }

  return (
    <div>
      {guide.vendorRequestNeeded ? (
        <p className="mb-6 rounded-xl border border-[color:var(--color-red)]/30 bg-[color:var(--color-red)]/[0.06] px-4 py-3 text-sm font-medium">
          {guide.vendorRequestNeeded}
        </p>
      ) : null}

      {!guide.verified ? (
        <p className="mb-6 text-xs text-[color:var(--color-muted)]">
          {platformName} may have moved these screens since we last checked. If
          something doesn&apos;t match, reply to your setup email and we&apos;ll
          walk through it with you.
        </p>
      ) : null}

      {/* --------------- Steps --------------- */}
      <ol className="grid gap-3">
        {guide.steps.map((s, index) => {
          const done = index < step;
          const current = index === step;

          return (
            <li
              key={s.title}
              className={[
                "rounded-2xl border p-5 transition-opacity",
                current
                  ? "border-[color:var(--color-red)] bg-white"
                  : "border-[color:var(--color-line)] bg-white",
                !current && !done ? "opacity-45" : "",
              ].join(" ")}
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden
                  className={[
                    "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-bold",
                    done
                      ? "bg-[color:var(--color-ink)] text-white"
                      : current
                        ? "bg-[color:var(--color-red)] text-white"
                        : "bg-[color:var(--color-paper-2)] text-[color:var(--color-muted)]",
                  ].join(" ")}
                >
                  {done ? "✓" : index + 1}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="font-medium">{s.title}</p>
                  {s.detail && (current || done) ? (
                    <p className="mt-1.5 text-sm text-[color:var(--color-muted)]">
                      {s.detail}
                    </p>
                  ) : null}

                  {current && s.copyable ? (
                    <CopyRow value={s.copyable} />
                  ) : null}

                  {current && s.link ? (
                    <a
                      href={s.link.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-3 inline-block text-sm font-bold text-[color:var(--color-red)] underline"
                    >
                      {s.link.label} ↗
                    </a>
                  ) : null}

                  {current ? (
                    <div className="mt-4 flex gap-3">
                      <button
                        type="button"
                        onClick={() => setStep(step + 1)}
                        className="rounded-full bg-[color:var(--color-ink)] px-5 py-2.5 text-sm font-bold text-white"
                      >
                        {index === guide.steps.length - 1 ? "I've done this" : "Done, next"}
                      </button>
                      {step > 0 ? (
                        <button
                          type="button"
                          onClick={() => setStep(step - 1)}
                          className="text-sm font-semibold text-[color:var(--color-muted)]"
                        >
                          Back
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {/* --------------- Credential form --------------- */}
      {atForm ? (
        <form
          action={action}
          className="mt-6 rounded-2xl border border-[color:var(--color-line)] bg-white p-5"
        >
          <input type="hidden" name="clinicSlug" value={clinicSlug} />
          <input type="hidden" name="platformId" value={guide.platformId} />

          <p className="text-[13px] font-bold tracking-[0.04em] uppercase">
            Paste your credentials
          </p>
          <p className="mt-1.5 text-sm text-[color:var(--color-muted)]">
            Encrypted before they touch our database, and never shown again.
          </p>

          <div className="mt-4 grid gap-4">
            {guide.fields.map((field) => (
              <label key={field.name} className="block">
                <span className="text-sm font-semibold">{field.label}</span>
                <input
                  name={field.name}
                  type={field.secret ? "password" : "text"}
                  placeholder={field.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={
                    state.status === "error" && state.field === field.name
                      ? true
                      : undefined
                  }
                  className={[
                    "mt-1.5 w-full rounded-xl border bg-white px-4 py-3 text-[15px] outline-none",
                    state.status === "error" && state.field === field.name
                      ? "border-[color:var(--color-red)]"
                      : "border-[color:var(--color-line)] focus:border-[color:var(--color-orange)]",
                  ].join(" ")}
                />
                {field.help ? (
                  <span className="mt-1 block text-xs text-[color:var(--color-muted)]">
                    {field.help}
                  </span>
                ) : null}
              </label>
            ))}
          </div>

          {state.status === "error" ? (
            <p className="mt-3 text-sm font-semibold text-[color:var(--color-red)]">
              {state.message}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={pending}
            className="mt-5 rounded-full bg-[color:var(--color-ink)] px-6 py-3 text-sm font-bold text-white disabled:opacity-50"
          >
            {pending ? "Connecting…" : "Connect"}
          </button>

          <button
            type="button"
            onClick={() => setStep(guide.steps.length - 1)}
            className="ml-4 text-sm font-semibold text-[color:var(--color-muted)]"
          >
            Back
          </button>
        </form>
      ) : null}
    </div>
  );
}

function CopyRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-3 flex items-center gap-2 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper-2)] px-3 py-2">
      <code className="min-w-0 flex-1 truncate text-sm">{value}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        }}
        className="shrink-0 rounded-full bg-white px-3 py-1.5 text-xs font-bold"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
