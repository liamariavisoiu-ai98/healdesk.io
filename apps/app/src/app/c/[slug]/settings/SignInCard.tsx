"use client";

import { useId, useState, type ReactNode } from "react";

import { useAnnounce } from "../feedback";
import {
  newBackupCodesAction,
  removeDeviceAction,
  someoneLeftAction,
  type SignInActionResult,
} from "./sign-in-actions";

/**
 * Settings → Sign-in (plan Part F2 and D3): the clinic's one address, the
 * devices that can open patient details, the backup, and "Someone left".
 *
 * Removing a device and "Someone left" need a passkey step-up, asked for
 * when the button is pressed (the server decides; this only shows the way).
 * Each asks once before acting, because both end sessions: a device's own,
 * or every one. When this browser is signed out by it, it goes to sign-in.
 */

export type DeviceView = {
  id: string;
  label: string;
  /** "Added Tuesday 6 October", already worded on the server. */
  added: string;
  lastUsed: string | null;
  isThisSession: boolean;
};

export function SignInCard(props: {
  slug: string;
  address: string | null;
  devices: DeviceView[];
  hasBackup: boolean;
  backupCodesLeft: number;
  addDeviceHref: string;
  addBackupHref: string;
  /**
   * The address change from Settings (plan Part D5, O5; AddressControl.tsx):
   * a confirmation to the new address and "Stop this change" to the old one,
   * in effect 72 hours later, moving the sign-in, the Stripe customer and the
   * agreement's notice address together (lib/sign-in/address-change.ts).
   * Without it the card says how the change is made by hand, through hello@.
   */
  addressControl?: ReactNode;
}) {
  return (
    <section
      id="sign-in"
      aria-labelledby="sign-in-heading"
      className="border-line scroll-mt-6 rounded-2xl border bg-white px-4 py-4 sm:px-5"
    >
      <h2 id="sign-in-heading" className="text-lg font-semibold">
        Sign-in
      </h2>
      <div className="divide-line mt-2 divide-y">
        <div className="py-3">
          <p className="font-semibold">Your practice&rsquo;s address</p>
          <p className="text-muted mt-1 text-sm">
            {props.address ?? "No address on file."} It is how everyone at the practice signs in,
            with a link we email to it, and where every healdesk email goes: billing, and notices
            under your agreement, too.
          </p>
          {props.addressControl ?? (
            <p className="text-muted mt-1 text-sm">
              To change it, email{" "}
              <a href="mailto:hello@healdesk.io" className="text-ink font-semibold underline">
                hello@healdesk.io
              </a>{" "}
              from this address with the new one, and we&rsquo;ll move the sign-in, billing and
              notices to it with you.
            </p>
          )}
        </div>
        <Devices {...props} />
        <Backup {...props} />
        <SomeoneLeft slug={props.slug} devices={props.devices} />
      </div>
    </section>
  );
}

function useSignInAction(): (
  run: () => Promise<SignInActionResult>,
) => Promise<SignInActionResult | null> {
  const announce = useAnnounce();
  return async (run) => {
    let result: SignInActionResult;
    try {
      result = await run();
    } catch {
      announce({
        text: "Something went wrong on our side. Try again in a moment.",
        tone: "problem",
      });
      return null;
    }
    if (result.ok) {
      announce({ text: result.toast, tone: "ok" });
      if (result.signedOut) window.location.assign("/sign-in");
    } else {
      announce({ text: result.message, tone: "problem", stepUpHref: result.stepUpHref });
    }
    return result;
  };
}

// -----------------------------------------------------------------------------
// Devices
// -----------------------------------------------------------------------------

function Devices(props: { slug: string; devices: DeviceView[]; addDeviceHref: string }) {
  const act = useSignInAction();
  const [devices, setDevices] = useState(props.devices);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function remove(id: string) {
    setWorking(true);
    const result = await act(() => removeDeviceAction(props.slug, id));
    if (result?.ok && !result.signedOut) setDevices((list) => list.filter((d) => d.id !== id));
    setWorking(false);
    setConfirming(null);
  }

  return (
    <div className="py-3">
      <p className="font-semibold">Devices with Face ID</p>
      <p className="text-muted mt-1 text-sm">
        Each phone or computer that can open patient details, with its own Face ID, fingerprint or
        screen lock.
      </p>
      {devices.length === 0 ? (
        <p className="mt-2 text-sm">None yet.</p>
      ) : (
        <ul className="mt-2 grid gap-2">
          {devices.map((d) => (
            <li key={d.id} className="border-line rounded-xl border px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p>
                  <span className="font-semibold">{d.label}</span>
                  {d.isThisSession ? <span className="text-muted"> · this browser</span> : null}
                  <span className="text-muted block">
                    {d.added}
                    {d.lastUsed ? ` · ${d.lastUsed}` : ""}
                  </span>
                </p>
                {confirming === d.id ? null : (
                  <button
                    type="button"
                    onClick={() => setConfirming(d.id)}
                    className="border-line min-h-11 rounded-full border px-4 font-semibold"
                  >
                    Remove
                  </button>
                )}
              </div>
              {confirming === d.id ? (
                <div className="mt-2">
                  <p>
                    {d.label} will no longer open patient details, and any browser that stepped up
                    with it is signed out.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => void remove(d.id)}
                      className="bg-ink min-h-11 rounded-full px-4 font-bold text-white disabled:opacity-50"
                    >
                      {working ? "Removing…" : `Remove ${d.label}`}
                    </button>
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => setConfirming(null)}
                      className="border-line min-h-11 rounded-full border px-4 font-semibold"
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <a
        href={props.addDeviceHref}
        className="border-line mt-3 inline-flex min-h-11 items-center rounded-full border px-5 text-sm font-semibold"
      >
        Add this device
      </a>
    </div>
  );
}

// -----------------------------------------------------------------------------
// The backup
// -----------------------------------------------------------------------------

function Backup(props: {
  slug: string;
  hasBackup: boolean;
  backupCodesLeft: number;
  addBackupHref: string;
}) {
  const act = useSignInAction();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [working, setWorking] = useState(false);
  const listId = useId();

  async function regenerate() {
    setWorking(true);
    const result = await act(() => newBackupCodesAction(props.slug));
    if (result?.ok && result.backupCodes) setCodes(result.backupCodes);
    setWorking(false);
  }

  return (
    <div className="py-3">
      <p className="font-semibold">Backup</p>
      {props.hasBackup ? (
        <>
          <p className="text-muted mt-1 text-sm">
            An authenticator app is set up, with{" "}
            {props.backupCodesLeft === 1
              ? "one backup code"
              : `${props.backupCodesLeft} backup codes`}{" "}
            left. Either can add a device if the ones with Face ID are lost.
          </p>
          {codes ? (
            <div className="mt-2">
              <p className="text-sm font-semibold" id={listId}>
                Your new backup codes. Write them down now: they won&rsquo;t be shown again.
              </p>
              <ul
                aria-labelledby={listId}
                className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm"
              >
                {codes.map((code) => (
                  <li key={code}>{code}</li>
                ))}
              </ul>
            </div>
          ) : (
            <button
              type="button"
              disabled={working}
              onClick={() => void regenerate()}
              className="border-line mt-3 min-h-11 rounded-full border px-5 text-sm font-semibold disabled:opacity-50"
            >
              {working ? "Making new codes…" : "Get new backup codes"}
            </button>
          )}
        </>
      ) : (
        <>
          <p className="text-muted mt-1 text-sm">
            No backup yet. An authenticator app can add a device if the ones with Face ID are lost.
          </p>
          <a
            href={props.addBackupHref}
            className="border-line mt-3 inline-flex min-h-11 items-center rounded-full border px-5 text-sm font-semibold"
          >
            Add an authenticator app
          </a>
        </>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Someone left
// -----------------------------------------------------------------------------

function SomeoneLeft(props: { slug: string; devices: DeviceView[] }) {
  const act = useSignInAction();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const name = useId();
  const everyDevice = props.devices.length > 0 && picked.length === props.devices.length;

  async function go() {
    setWorking(true);
    await act(() => someoneLeftAction(props.slug, picked));
    setWorking(false);
  }

  return (
    <div className="py-3">
      <p className="font-semibold">Someone left</p>
      <p className="text-muted mt-1 text-sm">
        Signs everyone out, everywhere, removes the devices you pick and resets the backup, so a
        person who has left can&rsquo;t get back in. Everyone else signs in again with a link.
      </p>
      {open ? (
        <div className="border-line mt-3 rounded-xl border px-4 py-3 text-sm">
          {props.devices.length > 0 ? (
            <fieldset className="grid gap-2">
              <legend className="font-semibold">Remove these devices too</legend>
              {props.devices.map((d) => {
                const id = `${name}-${d.id}`;
                return (
                  <label key={d.id} htmlFor={id} className="flex min-h-11 items-center gap-2">
                    <input
                      id={id}
                      type="checkbox"
                      checked={picked.includes(d.id)}
                      onChange={() =>
                        setPicked((list) =>
                          list.includes(d.id) ? list.filter((x) => x !== d.id) : [...list, d.id],
                        )
                      }
                      className="h-5 w-5"
                    />
                    {d.label}
                    {d.isThisSession ? <span className="text-muted">(this browser)</span> : null}
                  </label>
                );
              })}
            </fieldset>
          ) : null}
          {everyDevice ? (
            <p className="mt-2 font-semibold text-red-800">
              With every device removed and the backup reset, adding a device again may need a call
              to us.
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={working}
              onClick={() => void go()}
              className="bg-ink min-h-11 rounded-full px-4 font-bold text-white disabled:opacity-50"
            >
              {working ? "Signing everyone out…" : "Sign everyone out"}
            </button>
            <button
              type="button"
              disabled={working}
              onClick={() => setOpen(false)}
              className="border-line min-h-11 rounded-full border px-4 font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="border-line mt-3 min-h-11 rounded-full border px-5 text-sm font-semibold"
        >
          Someone left
        </button>
      )}
    </div>
  );
}
