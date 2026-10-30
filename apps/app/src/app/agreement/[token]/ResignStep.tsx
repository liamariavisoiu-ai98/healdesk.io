"use client";

import { AGREEMENT_COPY } from "@healdesk/catalog";
import { useEffect, useRef, useState } from "react";

import { renderResignPreview, type ResignDocument } from "@/lib/agreements/resign-preview";

import { signResignAction, type ResignActionResult } from "./actions";

/**
 * The re-sign screen: the funnel's agreement step (apps/web's AgreementStep)
 * for the Business Associate Agreement, with every answer the practice's own.
 *
 * What it keeps of the step, rule for rule:
 *   - the explainer above the document, the kind's own (BAA_EXPLAINER's
 *     bullets for this version) and the notes beside its clauses;
 *   - the document rendered in the browser by the catalog's one builder and
 *     hashed, so the server, which renders its own, refuses anything else;
 *   - reading to the end before the signature unlocks: a marker after the
 *     last line, inside the scroll box on a wider screen and inline below
 *     640px, and the signature `inert` until it is seen;
 *   - the typed name is the signature, rendered into the document, so the
 *     preview follows it as it is typed; the address is locked to the
 *     clinic's one address; the assent sentence is the one the server stores,
 *     and its box never arrives ticked.
 *
 * What it leaves out, because nothing here is the practice's to choose: the
 * covered-entity question (the answer is why it is here, or, from an older
 * BAA, the one on record), the specialty, the booking system and the Google
 * account, which the agreement in force recorded.
 */

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function signingDate(): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date());
}

/** SHA-256 of the displayed text, hex, or null outside a secure context. */
async function sha256(text: string): Promise<string | null> {
  if (typeof globalThis.crypto?.subtle?.digest !== "function") return null;
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export function ResignStep(props: {
  token: string;
  clinicName: string;
  document: ResignDocument;
  /** The agreement it replaces: the DPA, or an older version of the BAA. */
  replaces: { kind: "baa" | "dpa"; version: string };
  /** Whether AYA is held paused until it is signed. */
  holdsPause: boolean;
}) {
  const { document } = props;
  const copy = AGREEMENT_COPY.baa;
  const explainer = copy.explainer(document.templateVersion);

  const [name, setName] = useState(document.signatoryName);
  const [title, setTitle] = useState(document.signatoryTitle);
  const [agreed, setAgreed] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [endMarker, setEndMarker] = useState<HTMLDivElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signed, setSigned] = useState<Extract<ResignActionResult, { ok: true }> | null>(null);
  const signedRef = useRef<HTMLDivElement>(null);

  const preview = renderResignPreview(
    document,
    { signatoryName: name, signatoryTitle: title },
    today(),
  );

  const readToEnd =
    reachedEnd || (endMarker !== null && typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (!endMarker || readToEnd) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setReachedEnd(true);
    });
    observer.observe(endMarker);
    return () => observer.disconnect();
  }, [endMarker, readToEnd]);

  useEffect(() => {
    if (signed) signedRef.current?.focus();
  }, [signed]);

  const canSign = readToEnd && name.trim().length >= 2 && agreed && !submitting;

  async function sign() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await signResignAction(props.token, {
        signatoryName: name,
        signatoryTitle: title,
        displayedHash: await sha256(preview.text),
        templateVersion: document.templateVersion,
      });
      if (result.ok) setSigned(result);
      else setError(result.message);
    } catch {
      setError("Network error. Your agreement was not recorded, please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (signed) {
    return (
      <div ref={signedRef} tabIndex={-1} role="status" className="outline-none">
        <section className="border-line rounded-md border bg-white">
          <div className="border-line flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
            <span className="text-sm font-bold">
              <span aria-hidden className="text-red-deep">
                ✓{" "}
              </span>
              {copy.title} signed
            </span>
            <span className="text-muted text-xs font-semibold">Version {signed.version}</span>
          </div>
          <div className="px-5 py-4">
            <p className="font-semibold">
              {props.replaces.kind === "dpa"
                ? "It\u2019s in force from today, in place of your data protection agreement."
                : `It\u2019s in force from today, in place of version ${props.replaces.version}.`}
            </p>
            <p className="text-muted mt-2 text-sm">
              {signed.copy.sent
                ? `A copy is on its way to ${document.signatoryEmail}, and it's in Billing, under Your agreement.`
                : signed.copy.reason}
            </p>
            {props.holdsPause ? (
              <p className="text-muted mt-2 text-sm">
                AYA is no longer paused for it. The switch at the top of every page in healdesk says
                whether she&rsquo;s answering.
              </p>
            ) : null}
          </div>
          <div
            className="border-line px-5 py-4 sm:max-h-80 sm:overflow-y-auto"
            tabIndex={0}
            role="region"
            aria-label={`${copy.title} you signed`}
          >
            <pre className="text-muted font-sans text-[15px] leading-relaxed whitespace-pre-wrap">
              {signed.text}
            </pre>
          </div>
        </section>
      </div>
    );
  }

  return (
    <>
      {/* Why */}
      <section className="border-line bg-paper-2/50 rounded-md border p-5 sm:p-6">
        <h2 className="text-xl font-semibold">{explainer.heading}</h2>
        <p className="text-muted mt-3 text-sm leading-relaxed">{explainer.lead}</p>
        <p className="text-muted mt-3 text-sm leading-relaxed">{explainer.objection}</p>
        <ul className="mt-4 grid gap-2.5">
          {explainer.terms.map((term) => (
            <li key={term.citation} className="flex gap-2.5 text-sm">
              <span aria-hidden className="text-red-deep mt-px shrink-0 font-bold">
                ·
              </span>
              <span>
                <span className="font-medium">{term.plain}</span>{" "}
                <span className="text-muted text-xs whitespace-nowrap">{term.citation}</span>
              </span>
            </li>
          ))}
        </ul>
        {preview.notes.length > 0 ? (
          <ul className="mt-4 grid gap-2.5">
            {preview.notes.map((note) => (
              <li key={note.id} className="flex gap-2.5 text-sm">
                <span aria-hidden className="text-red-deep mt-px shrink-0 font-bold">
                  ·
                </span>
                <span>
                  <span className="font-medium">{note.heading}: </span>
                  <span className="font-medium">{note.plain}</span>{" "}
                  <span className="text-muted text-xs whitespace-nowrap">{note.citation}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-muted mt-4 text-xs leading-relaxed">{explainer.disclaimer}</p>
      </section>

      {/* The document: inline below 640px, in a scroll box above. */}
      <section className="mt-8">
        <div className="border-line rounded-md border bg-white">
          <div className="border-line flex items-center justify-between gap-3 border-b px-5 py-3">
            <span className="text-sm font-bold">{copy.title}</span>
            <span className="text-muted text-xs font-semibold">
              Version {document.templateVersion}
            </span>
          </div>
          <div
            tabIndex={0}
            role="region"
            aria-label={`${copy.title} text`}
            className="px-5 py-4 sm:max-h-80 sm:overflow-y-auto"
          >
            <pre className="text-muted font-sans text-[15px] leading-relaxed whitespace-pre-wrap">
              {preview.text}
            </pre>
            <div ref={setEndMarker} aria-hidden className="h-px" data-agreement-end />
          </div>
          <div className="border-line border-t px-5 py-3">
            <p
              role="status"
              aria-live="polite"
              className={["text-xs font-semibold", readToEnd ? "text-muted" : "text-red-deep"].join(
                " ",
              )}
            >
              {readToEnd
                ? "✓ You've read to the end."
                : "Read to the end of the agreement to sign it."}
            </p>
          </div>
        </div>
      </section>

      {/* The signature: inert until the end has been read. */}
      <section
        className={["mt-8 transition-opacity", readToEnd ? "opacity-100" : "opacity-40"].join(" ")}
        inert={!readToEnd}
      >
        <h2 className="text-lg font-semibold">Sign</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-semibold">
            Your full name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              maxLength={120}
              disabled={submitting}
              className="border-line-strong min-h-11 rounded-md border bg-white px-3 font-serif text-xl font-normal italic"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-semibold">
            Your title at the practice
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoComplete="organization-title"
              maxLength={120}
              disabled={submitting}
              className="border-line-strong min-h-11 rounded-md border bg-white px-3 font-normal"
            />
          </label>
        </div>
        <p className="text-muted mt-4 text-sm">
          Signing for {props.clinicName} as {document.signatoryEmail}, the address healdesk sends
          notices under this agreement to · {signingDate()} · A copy is emailed to you.
        </p>

        <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            // Never restored from autofill or a back-navigation cache: an
            // assent box that arrives ticked is not assent.
            autoComplete="off"
            className="accent-red mt-1 size-5 shrink-0"
          />
          <span className="text-sm font-medium">
            {copy.assentSentence(document.clinicLegalName)}
          </span>
        </label>

        {error ? (
          <p className="text-red-deep mt-4 text-sm font-semibold" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-6">
          <button
            type="button"
            onClick={() => void sign()}
            disabled={!canSign}
            className="bg-ink min-h-11 rounded-full px-6 text-sm font-bold text-white disabled:opacity-40"
          >
            {submitting ? "Recording…" : copy.actionLabel}
          </button>
        </div>
      </section>
    </>
  );
}
