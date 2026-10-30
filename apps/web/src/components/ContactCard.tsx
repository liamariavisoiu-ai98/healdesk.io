"use client";

import { useCallback, useId, useState } from "react";

import { site } from "@/lib/site";

/**
 * The contact form, used by the homepage's "want to know more" section and
 * by /contact.
 *
 * The mailbox address sits ABOVE the form deliberately. /api/contact refuses
 * to accept a message it cannot deliver rather than promising a reply nobody
 * will send, so the direct address has to be visible in the same breath.
 * it is the route that works whatever the transport is doing.
 *
 * Every field has a visible label (30 October 2026). Until then the
 * placeholder was the only label, so a field's name vanished the moment
 * someone started typing in it, and the browser's autofill left four boxes
 * of text with nothing saying which was which.
 */
type Status = "idle" | "sending" | "sent";

export function ContactCard() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  const submit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    setStatus("sending");
    setError(null);
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          clinic: data.get("clinic"),
          email: data.get("email"),
          message: data.get("message"),
          website: data.get("website"),
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(payload?.error ?? "Something went wrong. Try again.");
        setStatus("idle");
        return;
      }
      form.reset();
      setStatus("sent");
    } catch {
      setError(`Network error. Email ${site.email} instead.`);
      setStatus("idle");
    }
  }, []);

  return (
    <div className="border-line rounded-md border bg-white p-7 sm:p-8">
      {/* The mailbox sits above the form on purpose. It is the route that
          always works, including when the transport is misconfigured and the
          form refuses, see the note in api/contact/route.ts. It had a "Talk to
          a person" label over it until 9 October 2026 (owner). */}
      <a
        href={`mailto:${site.email}`}
        className="font-display text-brand-gradient block text-[clamp(26.4px,3.12vw,33.6px)] leading-tight font-semibold tracking-[-0.02em]"
      >
        {site.email}
      </a>

      {status === "sent" ? (
        <div className="mt-7">
          <p className="font-display text-[22.8px] leading-snug font-medium">
            Got it. We&apos;ll come back to you.
          </p>
          <p className="text-muted mt-2 text-sm font-medium">
            Usually within a business day, from a real person.
          </p>
          <button
            type="button"
            onClick={() => setStatus("idle")}
            className="text-muted hover:text-ink mt-4 inline-flex min-h-11 items-center text-[15.6px] font-bold transition-colors"
          >
            Send another
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-7 space-y-3" aria-describedby={error ? errorId : undefined}>
          <Input name="name" label="Your name" autoComplete="name" required />
          <Input name="clinic" label="Clinic (optional)" autoComplete="organization" />
          <Input
            name="email"
            label="Email"
            type="email"
            placeholder="you@yourclinic.com"
            autoComplete="email"
            required
          />
          <Field name="message" label="Message">
            {(id) => (
              <textarea
                id={id}
                name="message"
                required
                rows={4}
                placeholder="What would you like to know?"
                className={CONTROL}
              />
            )}
          </Field>
          {/* Permanent, not a tooltip. The message reaches us as ordinary
              email through a vendor that signs no BAA, and this marketing
              site may never carry patient information, so the form says so
              where the typing happens. Existing customers are the likeliest
              to use it for support. */}
          <p className="text-muted text-xs font-medium">
            This reaches us by ordinary email. Please don&apos;t include patient
            names, numbers or treatment details.
          </p>

          {/* Honeypot. Off-screen rather than display:none, some bots skip
              hidden fields, and hidden from assistive tech and the tab order. */}
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden
            className="absolute left-[-9999px] size-px opacity-0"
          />

          {error ? (
            <p id={errorId} className="text-red-deep text-[15.6px] font-semibold" role="alert">
              {error}
            </p>
          ) : null}

          {/* The deep gradient: the label is white body text, and white on the
              brand gradient's orange end is 2.67:1 (globals.css explains). */}
          <button
            type="submit"
            disabled={status === "sending"}
            className="bg-brand-gradient-deep shadow-sm w-full rounded-full px-6 py-3.5 text-[18px] font-bold text-white transition-transform duration-fast hover:-translate-y-px disabled:translate-y-0 disabled:opacity-50"
          >
            {status === "sending" ? "Sending…" : "Send it over"}
          </button>
        </form>
      )}
    </div>
  );
}

const CONTROL =
  "border-line focus:border-orange text-ink placeholder:text-muted w-full resize-y rounded-sm border px-4 py-3 text-[17.4px] outline-none transition-colors";

/** A visible label over one control, which the render prop draws with the label's id. */
function Field({
  name,
  label,
  children,
}: {
  name: string;
  label: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = `${useId()}-${name}`;
  return (
    <div>
      <label htmlFor={id} className="text-ink mb-1.5 block text-[15px] font-semibold">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

function Input({
  name,
  label,
  placeholder,
  type = "text",
  autoComplete,
  required,
}: {
  name: string;
  label: string;
  /** An example of the value, never the field's name: the label says that. */
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
}) {
  return (
    <Field name={name} label={label}>
      {(id) => (
        <input
          id={id}
          name={name}
          type={type}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
          className={CONTROL}
        />
      )}
    </Field>
  );
}
