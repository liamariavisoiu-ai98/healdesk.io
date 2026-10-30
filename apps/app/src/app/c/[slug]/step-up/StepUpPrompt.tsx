"use client";

import {
  browserSupportsWebAuthn,
  startAuthentication,
  WebAuthnError,
} from "@simplewebauthn/browser";
import { useEffect, useState } from "react";

import { deviceKindFrom, unlockWord, type DeviceKind } from "@/lib/factors/device";

import { beginStepUp, finishStepUp } from "./actions";

/**
 * One tap: the browser asks for this device's unlock, or, through "Use a
 * phone or tablet", for a phone's, by QR code. Patient pages ask again after
 * 15 minutes idle.
 */
export function StepUpPrompt(props: {
  slug: string;
  next: string;
  hasPasskey: boolean;
  protectHref: string;
  initialDevice: DeviceKind;
  /** Who the practice serves: a vet's details are its clients'. */
  audience: "patients" | "clients";
}) {
  const [device, setDevice] = useState<DeviceKind>(props.initialDevice);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
    setDevice(
      deviceKindFrom({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }),
    );
  }, []);

  const word = unlockWord(device);
  const details = props.audience === "clients" ? "Client details" : "Patient details";

  async function confirm(): Promise<void> {
    setWorking(true);
    setMessage(null);
    try {
      const begun = await beginStepUp(props.slug);
      if (!begun.ok) {
        setMessage(begun.message);
        return;
      }
      let response: Awaited<ReturnType<typeof startAuthentication>>;
      try {
        response = await startAuthentication({ optionsJSON: begun.options });
      } catch (error) {
        setMessage(
          error instanceof WebAuthnError ||
            (error instanceof Error && error.name === "NotAllowedError")
            ? "Cancelled or timed out. Press the button to try again."
            : "This browser couldn't use the passkey. Try again, or use your phone instead.",
        );
        return;
      }
      const finished = await finishStepUp(props.slug, { response, next: props.next });
      if (!finished.ok) {
        setMessage(finished.message);
        return;
      }
      window.location.assign(finished.next);
    } catch {
      setMessage("Something went wrong on our side. Try again in a moment.");
    } finally {
      setWorking(false);
    }
  }

  if (!props.hasPasskey) {
    return (
      <div>
        <h1 className="text-2xl font-semibold">Add {word} first</h1>
        <p className="text-muted mt-3">
          {details} open only after {word} on a device you&rsquo;ve added, and this sign-in has
          none yet.
        </p>
        <a
          href={props.protectHref}
          className="bg-ink mt-8 inline-flex min-h-11 items-center rounded-full px-6 py-3 text-sm font-bold text-white"
        >
          Add this device
        </a>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold">Confirm it&rsquo;s you</h1>
      <p className="text-muted mt-3">
        {details} need {word} on a device you&rsquo;ve added.
      </p>
      {!supported ? (
        <p className="border-line mt-6 rounded-md border bg-white px-4 py-3 text-sm">
          This browser can&rsquo;t use passkeys. Open this page in Safari or Chrome, or on your
          phone.
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void confirm()}
        disabled={working || !supported}
        className="bg-ink mt-8 min-h-11 w-fit rounded-full px-6 py-3 text-sm font-bold text-white disabled:opacity-50"
      >
        {working ? "Waiting for your device…" : `Use ${word}`}
      </button>
      <p className="text-muted mt-4 text-sm">
        <strong className="text-ink">Use your phone instead:</strong> when your browser asks, choose
        &ldquo;Use a phone or tablet&rdquo; and scan the code with the phone you added.
      </p>
      <div role="status" aria-live="polite" className="mt-4 min-h-6 text-sm">
        {message}
      </div>
      <p className="text-muted mt-8 text-sm">
        Using a device that isn&rsquo;t added yet?{" "}
        <a href={props.protectHref} className="text-ink font-semibold underline">
          Add this device
        </a>
        .
      </p>
    </div>
  );
}
