"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";

/**
 * First-run enrolment: the QR, the key as text, and the recovery codes.
 *
 * Reached only by `SignInForm` when the server answered `{ next: "enroll" }`,
 * which it does only when the password was right and no authenticator exists.
 * There is no URL for this screen, on purpose. See the header of
 * `app/admin/sign-in/page.tsx`.
 *
 * ## Nothing is generated until the owner says they are ready
 *
 * The obvious shape is to fetch the secret in an effect on mount, so the QR is
 * there the moment the screen appears. It is not what this does, for two
 * reasons.
 *
 * The first is correctness. `reactStrictMode` is on, so in development React
 * mounts, unmounts and remounts every component, and an unguarded fetch in an
 * effect fires twice. Two proposals means the QR on screen can belong to the
 * first one while the field holds the second: scan it and every code is wrong,
 * with no clue as to why. A ref guard papers over that; not starting until a
 * click removes it.
 *
 * The second is that a candidate secret is a credential with a lifetime.
 * Minting it when the screen renders means it exists while the owner is still
 * looking for their phone. Minting it when they say they are ready keeps the
 * window between "this exists" and "this is in an authenticator" as short as it
 * can be.
 *
 * ## The proposal is held here, in memory, and nowhere else
 *
 * apps/app stores nothing until a code proves the secret arrived, so the signed
 * proposal it hands back has to survive the round trip. It lives in this
 * component's state for the length of one enrolment: not in `localStorage`, not
 * in a cookie, and not in the URL. Reloading the page loses it, which is
 * correct, and the screen offers a way to start over rather than pretending
 * otherwise.
 *
 * ## The key is shown as text, not only as a picture
 *
 * A QR is unreadable to anyone using a screen reader, unscannable on the machine
 * that is displaying it, and useless when the camera will not focus. The base32
 * key in four-character groups is the thing that always works, so it is not
 * hidden behind a "can't scan?" link. The picture is the convenience; the text
 * is the interface.
 *
 * ## The recovery codes are shown once and the screen says so first
 *
 * They are printed after the warning rather than before it, and continuing needs
 * an explicit tick rather than a button that can be hit by someone already
 * reaching for the next thing. Losing these plus losing the phone means the
 * console cannot be opened by anybody: there is no operation that issues more,
 * by design, because minting recovery codes is minting credentials.
 */

type Proposed = {
  secretGroups: string[];
  otpauthUri: string;
  qrDataUrl: string;
  proposal: string;
};

type Stage =
  | { name: "ready" }
  | { name: "working" }
  | { name: "proposed"; data: Proposed }
  | { name: "codes"; codes: string[] }
  /**
   * A dead end this screen cannot argue with. `retry` says whether starting
   * over is a real offer: it is when the proposal was lost, and it is not when
   * a second factor already exists, because nothing here can replace one.
   */
  | { name: "blocked"; message: string; retry: boolean };

/**
 * One read of a failed response, returning both the sentence to show and the
 * `stage` the server named.
 *
 * Both come out of the same parse rather than two, because a `Response` body can
 * only be consumed once and `clone()` throws if it is called after that has
 * happened.
 *
 * The 429 sentence is built here rather than taken from the server, because the
 * server does not know the number and the header does.
 */
async function readProblem(
  response: Response,
): Promise<{ message: string; stage: unknown }> {
  if (response.status === 429) {
    const seconds = Number(response.headers.get("Retry-After"));
    const message =
      !Number.isFinite(seconds) || seconds <= 0
        ? "Too many attempts. Try again later."
        : `Too many attempts. Try again in ${Math.ceil(seconds / 60)} min.`;
    return { message, stage: undefined };
  }

  const data = (await response.json().catch(() => null)) as {
    error?: unknown;
    stage?: unknown;
  } | null;

  return {
    message:
      typeof data?.error === "string" && data.error.length > 0
        ? data.error
        : "That did not work. Try again.",
    stage: data?.stage,
  };
}

function post(body: Record<string, unknown>): Promise<Response> {
  return fetch("/api/admin/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function EnrollForm({
  onDone,
  onCancel,
}: {
  /** Enrolled and signed in: go to the console. */
  onDone: () => void;
  /**
   * Nothing was enrolled: go back to the password form, which is where an
   * unauthenticated browser belongs. Not a navigation, because there is no URL
   * for this screen to navigate away from.
   */
  onCancel: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ name: "ready" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  const codeRef = useRef<HTMLInputElement>(null);
  const stageName = stage.name;

  // Move the cursor to the code field as soon as there is one, so somebody who
  // has just scanned the QR can type without reaching for the mouse.
  useEffect(() => {
    if (stageName === "proposed") codeRef.current?.focus();
  }, [stageName]);

  async function begin() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setCode("");
    setStage({ name: "working" });

    let response: Response;
    try {
      response = await post({ step: "begin" });
    } catch {
      setBusy(false);
      setStage({ name: "ready" });
      setError("Network error. Try again.");
      return;
    }

    if (!response.ok) {
      const { message } = await readProblem(response);
      setBusy(false);
      // The only 409 this step can produce is "an authenticator already
      // exists", which nothing on this screen can undo.
      if (response.status === 409) {
        setStage({ name: "blocked", message, retry: false });
      } else {
        setStage({ name: "ready" });
        setError(message);
      }
      return;
    }

    const data = (await response.json().catch(() => null)) as {
      secretGroups?: unknown;
      otpauthUri?: unknown;
      qrDataUrl?: unknown;
      proposal?: unknown;
    } | null;

    if (
      data === null ||
      !Array.isArray(data.secretGroups) ||
      typeof data.otpauthUri !== "string" ||
      typeof data.proposal !== "string"
    ) {
      setBusy(false);
      setStage({ name: "ready" });
      setError("The server sent something this page could not read. Try again.");
      return;
    }

    setBusy(false);
    setStage({
      name: "proposed",
      data: {
        secretGroups: data.secretGroups.map(String),
        otpauthUri: data.otpauthUri,
        qrDataUrl: typeof data.qrDataUrl === "string" ? data.qrDataUrl : "",
        proposal: data.proposal,
      },
    });
  }

  async function activate(event: FormEvent<HTMLFormElement>, proposal: string) {
    event.preventDefault();
    if (busy || code.trim().length === 0) return;

    setBusy(true);
    setError(null);

    let response: Response;
    try {
      response = await post({ step: "activate", code: code.trim(), proposal });
    } catch {
      setBusy(false);
      setError("Network error. Try again.");
      return;
    }

    if (!response.ok) {
      const { message, stage: named } = await readProblem(response);
      setBusy(false);
      setCode("");
      if (named === "already_enrolled" || named === "restart") {
        setStage({ name: "blocked", message, retry: named === "restart" });
        return;
      }
      // A wrong code, an expired proposal, or apps/app being briefly
      // unreachable. All three are survivable from this screen: the next code
      // is one tap away and "start again" is on the same panel.
      setError(message);
      codeRef.current?.focus();
      return;
    }

    const data = (await response.json().catch(() => null)) as {
      recoveryCodes?: unknown;
    } | null;

    setBusy(false);
    setCode("");

    // No codes in the answer is not a reason to pretend enrolment failed: the
    // authenticator is on and the session cookie is already set. It is a reason
    // to say plainly that there are none to write down.
    setStage({
      name: "codes",
      codes: Array.isArray(data?.recoveryCodes)
        ? data.recoveryCodes.map(String)
        : [],
    });
  }

  async function copyCodes(codes: string[]) {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopyNote("Copied.");
    } catch {
      setCopyNote("Could not copy. Select the codes and copy them by hand.");
    }
  }

  if (stage.name === "blocked") {
    return (
      <Panel title="Nothing was changed." announce>
        <p className="text-muted mt-2 text-sm">{stage.message}</p>
        {stage.retry ? (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setStage({ name: "ready" });
            }}
            className="bg-brand-gradient shadow-sm mt-4 w-full rounded-full px-8 py-3.5 text-[18px] font-bold text-white transition-all duration-fast hover:-translate-y-0.5"
          >
            Start again
          </button>
        ) : null}
        <button
          type="button"
          onClick={onCancel}
          className="border-line hover:border-ink mt-3 w-full rounded-full border px-8 py-3 text-[18px] font-bold transition-colors"
        >
          Back to sign in
        </button>
      </Panel>
    );
  }

  if (stage.name === "codes") {
    return (
      <Panel title="Save your recovery codes now." announce>
        <p className="text-muted mt-2 text-sm">
          Your authenticator is on. These codes are the only way back in if you
          lose the phone. Each one works once, this is the only time they will be
          shown, and there is no way to issue more. Put them in your password
          manager before you continue.
        </p>

        {stage.codes.length > 0 ? (
          <>
            <ul className="border-line mt-4 grid grid-cols-2 gap-x-4 gap-y-2 rounded-sm border bg-white p-4 font-mono text-[16.8px]">
              {stage.codes.map((entry) => (
                <li key={entry} className="tracking-[0.06em]">
                  {entry}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => void copyCodes(stage.codes)}
              className="text-muted hover:text-ink mt-2 rounded-sm text-[15.6px] font-semibold underline underline-offset-2 transition-colors"
            >
              Copy all
            </button>
            <p
              role="status"
              aria-live="polite"
              className="text-muted mt-1 min-h-5 text-[15.6px]"
            >
              {copyNote}
            </p>
          </>
        ) : (
          <p className="text-red-deep mt-4 text-sm font-semibold">
            No recovery codes came back, so there are none to save. Your
            authenticator app is the only way in. Note this and raise it.
          </p>
        )}

        <label className="mt-4 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
            className="accent-orange mt-0.5 size-4 shrink-0"
          />
          <span>I have saved these somewhere I can get to without my phone.</span>
        </label>

        <button
          type="button"
          disabled={!saved}
          onClick={onDone}
          className="bg-brand-gradient shadow-sm mt-4 w-full rounded-full px-8 py-3.5 text-[18px] font-bold text-white transition-all duration-fast hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-40"
        >
          Continue to admin
        </button>
      </Panel>
    );
  }

  if (stage.name === "proposed") {
    const { secretGroups, otpauthUri, qrDataUrl, proposal } = stage.data;
    return (
      <Panel title="Scan this with your authenticator app.">
        <p className="text-muted mt-2 text-sm">
          Google Authenticator, 1Password, or anything else that shows six-digit
          codes. Nothing is turned on until you enter a code it generates.
        </p>

        <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          {qrDataUrl.length > 0 ? (
            <img
              src={qrDataUrl}
              alt="QR code holding the same setup key that is printed beside it"
              width={132}
              height={132}
              className="border-line shrink-0 rounded-sm border bg-white p-2"
            />
          ) : (
            <p className="text-muted text-[15.6px]">
              The QR image could not be drawn. Type the key in by hand instead.
            </p>
          )}

          <div className="min-w-0">
            <p className="text-[15.6px] font-bold tracking-[0.04em] uppercase">
              Or type this key
            </p>
            <p className="mt-1 font-mono text-[18px] leading-relaxed tracking-[0.12em] break-all">
              {secretGroups.join(" ")}
            </p>
            <p className="text-muted mt-2 text-[15.6px]">
              Time based, six digits, thirty seconds.{" "}
              <a
                href={otpauthUri}
                className="hover:text-ink underline underline-offset-2"
              >
                Open in an app on this device
              </a>
              .
            </p>
          </div>
        </div>

        <form onSubmit={(event) => void activate(event, proposal)} className="mt-5">
          <label className="block">
            <span className="text-[15.6px] font-bold tracking-[0.04em] uppercase">
              Then enter the code it shows
            </span>
            <input
              ref={codeRef}
              type="text"
              name="code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={7}
              spellCheck={false}
              required
              aria-invalid={error !== null || undefined}
              aria-describedby={error !== null ? "admin-enroll-error" : undefined}
              className={[
                "text-ink mt-2 w-full rounded-sm border bg-white px-4 py-3 font-mono text-[21.6px] tracking-[0.3em] transition-colors",
                error !== null ? "border-red" : "border-line focus:border-orange",
              ].join(" ")}
            />
          </label>

          <button
            type="submit"
            disabled={busy || code.trim().length === 0}
            className="bg-brand-gradient shadow-sm mt-4 w-full rounded-full px-8 py-3.5 text-[18px] font-bold text-white transition-all duration-fast hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-40"
          >
            {busy ? "Checking…" : "Turn it on"}
          </button>

          <p
            id="admin-enroll-error"
            role="status"
            aria-live="polite"
            className="text-red-deep mt-3 min-h-5 text-[15.6px] font-semibold"
          >
            {error}
          </p>
        </form>

        {/* A wrong code and an expired setup look identical from here, so the
            way out of both is on the same panel rather than behind a support
            article nobody has written. */}
        <button
          type="button"
          disabled={busy}
          onClick={() => void begin()}
          className="text-muted hover:text-ink mt-1 rounded-sm text-[15.6px] font-semibold underline underline-offset-2 transition-colors disabled:opacity-40"
        >
          Start again with a new key
        </button>
      </Panel>
    );
  }

  return (
    <Panel title="Set up your authenticator.">
      <p className="text-muted mt-2 text-sm">
        Your password is right. This account has no second factor yet, so nothing
        is signed in until one exists. Have your phone in your hand before you
        start: the setup key is generated when you press the button.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void begin()}
        className="bg-brand-gradient shadow-sm mt-4 w-full rounded-full px-8 py-3.5 text-[18px] font-bold text-white transition-all duration-fast hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-40"
      >
        {busy ? "Preparing…" : "I am ready"}
      </button>
      <p
        role="status"
        aria-live="polite"
        className="text-red-deep mt-3 min-h-5 text-[15.6px] font-semibold"
      >
        {error}
      </p>
    </Panel>
  );
}

/**
 * A panel, plus the one accessibility detail this flow cannot do without.
 *
 * These screens replace each other in place rather than navigating, so nothing
 * tells a screen reader that the page has become a different page. `announce`
 * moves focus to the heading when a panel arrives, which reads the new heading
 * out and puts the reading position at the top of what changed. It is set on the
 * two panels that arrive without the reader having pressed anything on them: the
 * recovery codes and the dead end.
 *
 * `tabIndex={-1}` makes the heading focusable programmatically without adding it
 * to the tab order, and the focus ring is suppressed on it alone, because a
 * heading focused only in order to be announced should not look like a control.
 */
function Panel({
  title,
  announce = false,
  children,
}: {
  title: string;
  announce?: boolean;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (announce) heading.current?.focus();
  }, [announce]);

  return (
    <section className="border-line mt-8 rounded-md border bg-white p-5">
      <h2
        ref={heading}
        tabIndex={announce ? -1 : undefined}
        className="text-[18px] font-semibold outline-none"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}
