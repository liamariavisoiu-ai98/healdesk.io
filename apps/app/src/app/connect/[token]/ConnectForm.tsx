"use client";

import type { CredentialField } from "@healdesk/catalog";
import { useActionState, useState } from "react";

import { submitCredential, type ConnectFormState } from "./actions";

/**
 * The credential form, and the end of the clinic's involvement.
 *
 * Three things this file is careful about.
 *
 * **It draws failure only.** Success is a redirect to `/connect/done` and never
 * arrives back here as state, so there is no confirmation branch in this file.
 * That is not a styling preference: this form is progressively enhanced, and on
 * the no-JS transport the browser POSTs to `/connect/<token>` and Next re-renders
 * that page afterwards — over a token the same request has just spent. See the
 * header note in actions.ts. What the confirmation says is unchanged, including
 * "you can close this page", which stays the honest instruction because there is
 * genuinely no dashboard to send anyone to.
 *
 * Nothing here has to announce the success to a screen reader any more, either.
 * The old inline confirmation had to take focus, because the submit button was
 * unmounted in the same commit that rendered it and focus fell to `<body>`. A
 * route change is announced by the App Router's own route announcer, from the
 * title `/connect/done` sets.
 *
 * **The fields come from the catalogue, not from here.** Most guides are one
 * secret; Acuity is a user id plus a key, PatientNow is three values, Mindbody
 * is a single non-secret site id. Hard-coding "one password field" would make
 * three of the five platforms in connection-steps.ts unusable, and masking
 * Mindbody's site id would tell the clinic something false about what they are
 * handing over. `secret` decides the input type; nothing else does.
 *
 * **Nothing is retained.** React 19 resets an uncontrolled form after its
 * action settles, so a failed submit clears the fields. That is mildly annoying
 * and deliberately not worked around: the alternative is a live credential
 * sitting in the DOM of a shared front-desk browser until the tab is closed.
 */
// No `platformName`: the only thing that used it was the inline confirmation,
// and the page around this form already names the platform twice above it.
export function ConnectForm({
  token,
  fields,
}: {
  token: string;
  fields: readonly CredentialField[];
}) {
  const [state, action, pending] = useActionState<ConnectFormState, FormData>(
    submitCredential,
    { status: "idle" },
  );

  return (
    <form
      action={action}
      autoComplete="off"
      className="mt-8 rounded-2xl border border-[color:var(--color-line)] bg-white p-5 sm:p-6"
    >
      {/*
        The only thing the browser tells us about identity, and it is re-resolved
        server-side before anything is written. Nothing here names the clinic.
      */}
      <input type="hidden" name="token" value={token} />

      <h2 className="text-[13px] font-bold tracking-[0.04em] uppercase">
        Paste it here
      </h2>
      <p className="mt-1.5 text-sm text-[color:var(--color-muted)]">
        Encrypted before it touches our database, and never shown again, not to
        you, and not to us.
      </p>

      <div className="mt-5 grid gap-5">
        {fields.map((field) => (
          <label key={field.name} className="block">
            <span className="text-[15px] font-semibold">{field.label}</span>
            <input
              name={field.name}
              type={field.secret ? "password" : "text"}
              placeholder={field.placeholder}
              required
              // The help text is the difference between "Site ID" and knowing
              // where in Mindbody to find it, so it has to reach a screen
              // reader on the field itself, not float unattached beneath it.
              aria-describedby={field.help ? `${field.name}-help` : undefined}
              // Off everywhere: a browser or password manager should not be
              // filling, remembering or correcting a clinic's API key, and a
              // front desk is a shared machine.
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={pending}
              aria-invalid={
                state.status === "failed" && state.field === field.name
                  ? true
                  : undefined
              }
              className={[
                // 16px minimum, or iOS zooms the whole page on focus.
                "mt-2 w-full rounded-xl border bg-white px-4 py-3 text-[16px] outline-none disabled:opacity-60",
                state.status === "failed" && state.field === field.name
                  ? "border-[color:var(--color-red)]"
                  : "border-[color:var(--color-line)] focus:border-[color:var(--color-orange)]",
              ].join(" ")}
            />
            {field.help ? (
              <span
                id={`${field.name}-help`}
                className="mt-1.5 block text-xs text-[color:var(--color-muted)]"
              >
                {field.help}
              </span>
            ) : null}
          </label>
        ))}
      </div>

      {state.status === "failed" ? (
        <p
          role="alert"
          className="mt-4 text-sm font-semibold text-[color:var(--color-red)]"
        >
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="mt-6 w-full rounded-full bg-[color:var(--color-ink)] px-6 py-3.5 text-base font-bold text-white transition-opacity disabled:opacity-50 sm:w-auto"
      >
        {pending ? "Sending…" : "Send it securely"}
      </button>

      <p aria-live="polite" className="sr-only">
        {pending ? "Sending your credential." : ""}
      </p>
    </form>
  );
}

/**
 * Copy-to-clipboard for the values a clinic has to paste into their own admin.
 *
 * Lives in this file because this slice owns five of them and a shared client
 * module is not one — not because it belongs to the form. It is here rather
 * than a plain <code> block because the thing being copied is an email address
 * that a person is retyping into another tab on a phone, and a typo there
 * produces an invitation that silently never arrives.
 */
export function CopyRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-3 flex items-center gap-2 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper-2)] px-3 py-2">
      <code className="min-w-0 flex-1 truncate text-[13px] sm:text-sm">
        {value}
      </code>
      <button
        type="button"
        onClick={() => {
          // Only claim "Copied" if it actually copied. The clipboard API is
          // absent on insecure origins and can be refused outright, and a
          // button that lies leaves someone pasting the last thing they had.
          // The value stays selectable either way.
          navigator.clipboard
            ?.writeText(value)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1_500);
            })
            .catch(() => undefined);
        }}
        className="shrink-0 rounded-full bg-white px-3 py-1.5 text-xs font-bold"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
