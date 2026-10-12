"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { FormEvent } from "react";

import { EnrollForm } from "@/components/admin/EnrollForm";

/**
 * The sign-in form, and the three things that can happen after it.
 *
 * This is the only interactive piece of the sign-in page, which is why it is the
 * only part that ships as client JavaScript. The page around it stays on the
 * server so that "is an admin account configured" and "is there already a
 * session" never reach the browser.
 *
 * ## All three fields go in one request
 *
 * Email, password and the six-digit code are submitted together, rather than the
 * usual two-screen dance where the password is checked, a "pending" state is
 * stored somewhere, and the code is asked for afterwards. The two-screen version
 * needs a server-side half-authenticated state, and a half-authenticated state
 * is a thing that can be resumed, replayed, or accidentally treated as a
 * session. One request needs none of that: either everything checked out or
 * nothing did, and there is nothing in between to leak.
 *
 * The cost is that the code field is on screen before anyone knows whether it is
 * needed, which is why it says so. On first run it is left empty and the server
 * answers `{ next: "enroll" }`; forever after it is required, and the server
 * says which of the two the browser is looking at rather than this file
 * guessing.
 *
 * ## Why the errors are as blunt as they are
 *
 * The server answers a bad email or password with one sentence covering both,
 * and this renders exactly what it was given. There is no "did you mean", no
 * attempts-remaining counter, and no distinction between an address that is
 * wrong and one that is right. Anything friendlier is a side channel: a counter
 * tells a guesser how much budget is left, and a distinct "no such account"
 * tells them whether to keep going at all.
 *
 * Two exceptions, both deliberate. 429 says how long to wait, which is a fact
 * the caller can measure with a stopwatch anyway, and withholding it only
 * punishes the owner who mistyped twice. And a replayed code is named as
 * replayed, because the alternative is the owner retyping the same six digits
 * for two minutes wondering why their phone is lying to them.
 *
 * ## Why it navigates rather than re-renders in place
 *
 * A successful POST sets an HttpOnly cookie, which this component cannot see.
 * /admin is rendered on the server and decides what to show from that cookie, so
 * the only correct move is to navigate and let the server look again. `replace`
 * rather than `push` so the back button does not walk into a sign-in form that
 * is now pointless, and `refresh` so the destination is fetched with the new
 * cookie rather than served out of the router cache.
 */

type Failure = { message: string; focus?: "code" };

/**
 * Turn a failed response into one sentence, plus where to put the cursor.
 *
 * The 429 case is built here rather than appended to the server's wording,
 * because "Too many attempts. Try again shortly." followed by "Try again in 3
 * min." reads like a bug. When `Retry-After` is missing or unparseable the
 * message says "later": inventing a number the header did not give us would be
 * showing a guess as a fact.
 */
async function describeFailure(response: Response): Promise<Failure> {
  if (response.status === 429) {
    const seconds = Number(response.headers.get("Retry-After"));
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return { message: "Too many attempts. Try again later." };
    }
    const minutes = Math.ceil(seconds / 60);
    return { message: `Too many attempts. Try again in ${minutes} min.` };
  }

  const data = (await response.json().catch(() => null)) as {
    error?: unknown;
    next?: unknown;
  } | null;

  return {
    message:
      typeof data?.error === "string" && data.error.length > 0
        ? data.error
        : "Sign-in failed. Try again.",
    focus: data?.next === "code" ? "code" : undefined,
  };
}

export function SignInForm() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * "credentials" is the form. "enroll" is first run, reached only by the server
   * saying so. "recovered" is the one-screen notice after a recovery code was
   * spent, which exists so that burning one of eight is not a silent event.
   */
  const [stage, setStage] = useState<"credentials" | "enroll" | "recovered">(
    "credentials",
  );
  const [codesLeft, setCodesLeft] = useState<number | null>(null);

  const codeRef = useRef<HTMLInputElement>(null);

  function toAdmin() {
    router.replace("/admin");
    router.refresh();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (email.trim().length === 0 || password.length === 0) return;

    setSubmitting(true);
    setError(null);

    const secondFactor = code.trim();
    const payload: Record<string, string> = {
      email: email.trim(),
      password,
    };
    if (secondFactor.length > 0) {
      payload[useRecovery ? "recoveryCode" : "code"] = secondFactor;
    }

    let response: Response;
    try {
      response = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      setError("Network error. Try again.");
      setSubmitting(false);
      return;
    }

    if (!response.ok) {
      const failure = await describeFailure(response);
      setError(failure.message);
      // The password is cleared on any failure so a walk-away does not leave it
      // in a field. The code is cleared too: whatever it was, it is stale now.
      setPassword("");
      setCode("");
      setSubmitting(false);
      if (failure.focus === "code") codeRef.current?.focus();
      return;
    }

    const data = (await response.json().catch(() => null)) as {
      next?: unknown;
      recoveryCodesRemaining?: unknown;
    } | null;

    setPassword("");
    setCode("");

    if (data?.next === "enroll") {
      // Deliberately leave `submitting` false here: the next screen has its own
      // buttons and this form is about to be unmounted.
      setSubmitting(false);
      setStage("enroll");
      return;
    }

    if (typeof data?.recoveryCodesRemaining === "number") {
      setSubmitting(false);
      setCodesLeft(data.recoveryCodesRemaining);
      setStage("recovered");
      return;
    }

    // Deliberately leave `submitting` true: the navigation is the next thing
    // that happens, and re-enabling the button first only invites a second
    // submit against a session that already exists.
    toAdmin();
  }

  if (stage === "enroll") {
    return (
      <EnrollForm
        onDone={toAdmin}
        onCancel={() => {
          setStage("credentials");
          setError(null);
          setUseRecovery(false);
        }}
      />
    );
  }

  if (stage === "recovered") {
    return (
      <div className="border-line mt-8 rounded-md border bg-white p-5">
        <p className="text-[18px] font-semibold">
          You signed in with a recovery code.
        </p>
        <p className="text-muted mt-2 text-sm">
          {codesLeft === 1
            ? "That code is now used up and one recovery code is left. When it is gone, only your authenticator app can sign you in."
            : `That code is now used up. ${codesLeft ?? 0} recovery codes are left.`}
        </p>
        <button
          type="button"
          autoFocus
          onClick={toAdmin}
          className="bg-brand-gradient shadow-sm mt-4 w-full rounded-full px-8 py-3.5 text-[18px] font-bold text-white transition-all duration-fast hover:-translate-y-0.5"
        >
          Continue
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-8">
      <label className="block">
        <span className="text-[15.6px] font-bold tracking-[0.04em] uppercase">
          Email
        </span>
        <input
          type="email"
          name="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="username"
          autoFocus
          required
          spellCheck={false}
          aria-invalid={error !== null || undefined}
          aria-describedby={error !== null ? "admin-sign-in-error" : undefined}
          className={field(error !== null)}
        />
      </label>

      <label className="mt-4 block">
        <span className="text-[15.6px] font-bold tracking-[0.04em] uppercase">
          Password
        </span>
        <input
          type="password"
          name="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
          aria-invalid={error !== null || undefined}
          aria-describedby={error !== null ? "admin-sign-in-error" : undefined}
          className={field(error !== null)}
        />
      </label>

      <label className="mt-4 block">
        <span className="text-[15.6px] font-bold tracking-[0.04em] uppercase">
          {useRecovery ? "Recovery code" : "Authenticator code"}
        </span>
        <input
          ref={codeRef}
          type="text"
          name={useRecovery ? "recoveryCode" : "code"}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete={useRecovery ? "off" : "one-time-code"}
          inputMode={useRecovery ? "text" : "numeric"}
          spellCheck={false}
          maxLength={useRecovery ? 64 : 7}
          aria-describedby={
            error !== null
              ? "admin-code-hint admin-sign-in-error"
              : "admin-code-hint"
          }
          aria-invalid={error !== null || undefined}
          className={field(error !== null)}
        />
      </label>
      <p id="admin-code-hint" className="text-muted mt-2 text-[15.6px]">
        {useRecovery
          ? "One of the codes you saved when you set up your authenticator. Each one works once."
          : "Six digits from your authenticator app. Leave this empty the first time you sign in and you will be asked to set one up."}
      </p>

      <button
        type="button"
        onClick={() => {
          setUseRecovery((current) => !current);
          setCode("");
          setError(null);
        }}
        className="text-muted hover:text-ink mt-2 rounded-sm text-[15.6px] font-semibold underline underline-offset-2 transition-colors"
      >
        {useRecovery
          ? "Use my authenticator app instead"
          : "Use a recovery code instead"}
      </button>

      <button
        type="submit"
        disabled={submitting || email.trim().length === 0 || password.length === 0}
        className="bg-brand-gradient shadow-sm mt-5 w-full rounded-full px-8 py-3.5 text-[18px] font-bold text-white transition-all duration-fast hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-40"
      >
        {submitting ? "Checking…" : "Enter"}
      </button>

      {/* Always in the tree so the message is announced when it appears, and so
          its arrival does not shove the button up the page. */}
      <p
        id="admin-sign-in-error"
        role="status"
        aria-live="polite"
        className="text-red-deep mt-3 min-h-5 text-[15.6px] font-semibold"
      >
        {error}
      </p>
    </form>
  );
}

/**
 * One place for the field styling, so three inputs cannot drift apart.
 *
 * No `outline-none` here, deliberately. `globals.css` installs a 3px orange
 * `:focus-visible` ring in `@layer base`, and Tailwind's utilities sit in a
 * LATER cascade layer, so `outline-none` on a field beats that rule outright
 * however low its specificity looks. What was left behind was a 1px border
 * changing from a 12%-opacity ink to orange: under 3:1 against white, and the
 * only thing telling a keyboard user which of these two boxes they are typing
 * a password into. The ring and `focus:border-orange` now both apply.
 */
function field(invalid: boolean): string {
  return [
    "text-ink placeholder:text-muted mt-2 w-full rounded-sm border bg-white px-4 py-3 text-[19.2px] transition-colors",
    invalid ? "border-red" : "border-line focus:border-orange",
  ].join(" ");
}
