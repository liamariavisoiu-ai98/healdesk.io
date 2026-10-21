"use client";

import { browserSupportsWebAuthn, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import { useEffect, useId, useState } from "react";

import {
  DEVICE_LABEL_MAX,
  deviceKindFrom,
  suggestedDeviceLabel,
  unlockWord,
  type DeviceKind,
} from "@/lib/factors/device";

import { beginAddDevice, finishAddDevice } from "./actions";
import { HUMAN_ROUTE, type ProtectMode } from "./copy";

/**
 * The device's half of adding a passkey: name it, unlock it, done. The
 * wording follows the device (Face ID, Touch ID, or the screen lock), refined
 * on the device itself because an iPad's browser says it is a Mac. The
 * browser offers "Use a phone or tablet" (a QR code) beside this device's own
 * unlock, because the options leave the authenticator's attachment open.
 *
 * Its three modes are copy.ts's. Only `needs_proof`, where the sign-in has a
 * device, links to the step-up page; `no_device` offers the code and the
 * human route instead, so the two pages never send a browser round in a loop.
 */
export function ProtectDevice(props: {
  slug: string;
  next: string;
  mode: ProtectMode;
  firstDevice: boolean;
  /** Open on the human route's link: one device, once. */
  recovery?: boolean;
  codeRoute: boolean;
  initialDevice: DeviceKind;
  stepUpHref: string;
  /** Who the practice serves: a vet's details are its clients'. */
  audience: "patients" | "clients";
}) {
  const [device, setDevice] = useState<DeviceKind>(props.initialDevice);
  const [label, setLabel] = useState(suggestedDeviceLabel(props.initialDevice));
  const [code, setCode] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const labelId = useId();
  const codeId = useId();
  const hintId = useId();

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
    const kind = deviceKindFrom({
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
    });
    setDevice(kind);
    // The suggestion follows the device until the person has typed their own.
    setLabel((current) =>
      current === suggestedDeviceLabel(props.initialDevice) ? suggestedDeviceLabel(kind) : current,
    );
  }, [props.initialDevice]);

  const word = unlockWord(device);
  const canAdd = props.mode === "open" || props.codeRoute;

  async function add(): Promise<void> {
    setWorking(true);
    setMessage(null);
    try {
      const begun = await beginAddDevice(props.slug, {
        code: props.mode === "open" ? undefined : code,
      });
      if (!begun.ok) {
        setMessage(begun.message);
        return;
      }
      let response: Awaited<ReturnType<typeof startRegistration>>;
      try {
        response = await startRegistration({ optionsJSON: begun.options });
      } catch (error) {
        setMessage(browserMessage(error));
        return;
      }
      const finished = await finishAddDevice(props.slug, { label, response, next: props.next });
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

  const one = props.audience === "clients" ? "client" : "patient";

  return (
    <div>
      <h1 className="text-2xl font-semibold">
        {props.firstDevice ? `Protect ${one} details: ` : "Add this device: "}use {word}
      </h1>
      <p className="text-muted mt-3">
        {props.mode === "open"
          ? props.recovery
            ? `The link from healdesk lets one device be added, once. Conversations and Bookings then open with ${word} on it.`
            : `Conversations and Bookings open only after ${word} on a device you've added. It takes one tap.`
          : props.mode === "needs_proof"
            ? `This sign-in already has a device that opens ${one} details. Confirm with it, and this one can be added.`
            : props.codeRoute
              ? `This sign-in has no device that opens ${one} details, and ${one} details may already exist, so adding one takes a code from your authenticator app or a backup code.`
              : `This sign-in has no device that opens ${one} details and no authenticator app to confirm with, and ${one} details may already exist, so a device is added with our help.`}
      </p>

      {!supported ? (
        <p className="mt-6 rounded-xl border border-line bg-white px-4 py-3 text-sm">
          This browser can't use passkeys. Open this page in Safari or Chrome, or use your phone
          instead.
        </p>
      ) : null}

      {props.mode === "needs_proof" ? (
        <a
          href={props.stepUpHref}
          className="bg-ink mt-6 inline-flex min-h-11 items-center rounded-full px-6 py-3 text-sm font-bold text-white"
        >
          Confirm with a device that has it
        </a>
      ) : null}
      {props.mode !== "open" ? <p className="text-muted mt-3 text-sm">{HUMAN_ROUTE}</p> : null}

      {canAdd ? (
        <form
          className="mt-8 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <div className="grid gap-1">
            <label htmlFor={labelId} className="text-sm font-semibold">
              Name this device
            </label>
            <input
              id={labelId}
              value={label}
              maxLength={DEVICE_LABEL_MAX}
              required
              autoComplete="off"
              onChange={(event) => setLabel(event.target.value)}
              aria-describedby={hintId}
              className="border-line min-h-11 rounded-xl border bg-white px-4 py-2"
            />
            <p id={hintId} className="text-muted text-xs">
              Staff see this name when this device opens {one} details, like &ldquo;Front desk
              Mac&rdquo; or &ldquo;Maria&rsquo;s iPhone&rdquo;.
            </p>
          </div>

          {props.mode !== "open" ? (
            <div className="grid gap-1">
              <label htmlFor={codeId} className="text-sm font-semibold">
                Or enter a code from your authenticator app, or a backup code
              </label>
              <input
                id={codeId}
                value={code}
                inputMode="text"
                autoComplete="one-time-code"
                onChange={(event) => setCode(event.target.value)}
                className="border-line min-h-11 rounded-xl border bg-white px-4 py-2 tracking-widest"
              />
            </div>
          ) : null}

          <button
            type="submit"
            disabled={working || !supported || (props.mode !== "open" && !code.trim())}
            className="bg-ink min-h-11 w-fit rounded-full px-6 py-3 text-sm font-bold text-white disabled:opacity-50"
          >
            {working ? "Waiting for your device…" : `Use ${word}`}
          </button>
          <p className="text-muted text-sm">
            <strong className="text-ink">Use your phone instead:</strong> when your browser asks,
            choose &ldquo;Use a phone or tablet&rdquo; and scan the code with your phone. Name it
            after the phone.
          </p>
        </form>
      ) : null}

      <div role="status" aria-live="polite" className="mt-4 min-h-6 text-sm">
        {message}
      </div>

      <p className="text-muted mt-8 text-sm">
        <a href={props.next} className="text-ink font-semibold underline">
          Skip for now
        </a>
        . You won&rsquo;t be able to open Conversations or Bookings until you add this.
      </p>
    </div>
  );
}

/** What went wrong in the browser's half, in words for the person at the device. */
function browserMessage(error: unknown): string {
  if (error instanceof WebAuthnError) {
    if (error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
      return "This device is already added. Confirm with it instead.";
    }
    if (error.code === "ERROR_CEREMONY_ABORTED") return "Cancelled. Press the button to try again.";
  }
  if (error instanceof Error && error.name === "NotAllowedError") {
    return "Cancelled or timed out. Press the button to try again.";
  }
  return "This browser couldn't add the passkey. Try again, or use your phone instead.";
}
