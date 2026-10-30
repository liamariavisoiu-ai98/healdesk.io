"use client";

import { useId, useState } from "react";

import { beginBackup, finishBackup, skipScreen } from "../actions";

/**
 * The end of setup: the backup factor, offered once when the sign-in has
 * none (plan Part D3). An authenticator app on a phone, which can add a new
 * device's passkey if the one with Face ID is lost, and ten backup codes
 * shown once. Skippable, with its cost said; then the build tracker.
 */
export function BackupScreen(props: { slug: string; doneHref: string }) {
  const [stage, setStage] = useState<"offer" | "scan" | "codes">("offer");
  const [proposal, setProposal] = useState<{
    proposal: string;
    secret: string;
    qrDataUrl: string;
    otpauthUri: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [message, setMessage] = useState<{ text: string; href?: string } | null>(null);
  const [working, setWorking] = useState(false);
  const codeId = useId();

  async function start() {
    setWorking(true);
    setMessage(null);
    try {
      const begun = await beginBackup(props.slug);
      if (!begun.ok) {
        setMessage({ text: begun.message, href: begun.stepUpHref });
        return;
      }
      setProposal(begun);
      setStage("scan");
    } catch {
      setMessage({ text: "Something went wrong on our side. Try again in a moment." });
    } finally {
      setWorking(false);
    }
  }

  async function finish() {
    if (!proposal) return;
    setWorking(true);
    setMessage(null);
    try {
      const done = await finishBackup(props.slug, { proposal: proposal.proposal, code });
      if (!done.ok) {
        setMessage({ text: done.message });
        return;
      }
      setCodes(done.backupCodes);
      setStage("codes");
    } catch {
      setMessage({ text: "Something went wrong on our side. Try again in a moment." });
    } finally {
      setWorking(false);
    }
  }

  async function skip() {
    setWorking(true);
    try {
      const skipped = await skipScreen(props.slug, "backup");
      window.location.assign(skipped.ok ? skipped.next : props.doneHref);
    } catch {
      setWorking(false);
      setMessage({ text: "Something went wrong on our side. Try again in a moment." });
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold">A backup way in</h1>
      {stage === "offer" ? (
        <>
          <p className="text-muted mt-3">
            If the phone or computer with your Face ID is lost, an authenticator app (Google
            Authenticator, Microsoft Authenticator, 1Password) lets you add a new device yourself.
            It takes a minute.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={working}
              onClick={() => void start()}
              className="bg-ink min-h-11 rounded-full px-6 py-3 text-sm font-bold text-white disabled:opacity-50"
            >
              Add an authenticator app
            </button>
            <button
              type="button"
              disabled={working}
              onClick={() => void skip()}
              className="border-line min-h-11 rounded-full border px-5 py-3 text-sm font-semibold disabled:opacity-50"
            >
              Skip for now
            </button>
          </div>
          <p className="text-muted mt-3 text-sm">
            If you skip: losing the device with your Face ID means a call with us to get back in.
          </p>
        </>
      ) : null}

      {stage === "scan" && proposal ? (
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void finish();
          }}
        >
          <p className="text-muted">
            Scan this with the app on your phone. On the phone itself,{" "}
            <a href={proposal.otpauthUri} className="font-semibold underline">
              open it in the app
            </a>{" "}
            instead.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={proposal.qrDataUrl}
            width={220}
            height={220}
            alt="A QR code for your authenticator app"
            className="rounded-sm border border-line bg-white p-2"
          />
          <p className="text-muted text-sm">
            Can&rsquo;t scan? Type this key into the app:{" "}
            <code className="break-all font-mono text-ink">
              {proposal.secret.replace(/(.{4})/g, "$1 ").trim()}
            </code>
          </p>
          <div className="grid gap-1">
            <label htmlFor={codeId} className="text-sm font-semibold">
              The 6-digit code the app shows
            </label>
            <input
              id={codeId}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              className="border-line min-h-11 w-40 rounded-md border bg-white px-4 py-2 tracking-widest"
            />
          </div>
          <button
            type="submit"
            disabled={working || code.replace(/\D/g, "").length < 6}
            className="bg-ink min-h-11 w-fit rounded-full px-6 py-3 text-sm font-bold text-white disabled:opacity-50"
          >
            {working ? "Checking…" : "Add it"}
          </button>
        </form>
      ) : null}

      {stage === "codes" ? (
        <div className="mt-4 grid gap-4">
          <p className="text-muted">
            Done. Keep these ten backup codes somewhere safe, away from this device: each one works
            once, if you ever lose the phone with the app too. We won&rsquo;t show them again.
          </p>
          <ul className="grid grid-cols-2 gap-2 rounded-md border border-line bg-white p-4 font-mono">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <a
            href={props.doneHref}
            className="bg-ink inline-flex min-h-11 w-fit items-center rounded-full px-6 py-3 text-sm font-bold text-white"
          >
            I&rsquo;ve saved them
          </a>
        </div>
      ) : null}

      <div role="status" aria-live="polite" className="mt-4 min-h-6 text-sm">
        {message ? (
          <>
            {message.text}
            {message.href ? (
              <>
                {" "}
                <a href={message.href} className="font-semibold underline">
                  Confirm it&rsquo;s you
                </a>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
