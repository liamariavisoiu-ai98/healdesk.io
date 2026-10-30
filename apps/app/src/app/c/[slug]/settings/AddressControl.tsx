"use client";

import { useId, useState } from "react";

import { useAnnounce } from "../feedback";
import {
  requestAddressChangeAction,
  stopAddressChangeAction,
  type AddressActionResult,
} from "./address-actions";

/**
 * The address control in Settings → Sign-in (plan Part D5): ask for a change
 * of the clinic's one address, or see the one under way and stop it.
 *
 * The words for a change under way are composed on the server, with the
 * clinic's own time zone, and passed in. Asking needs a passkey step-up,
 * which the server checks; stopping needs none.
 */

export type OpenAddressChange = {
  newEmail: string;
  /** One sentence: what it waits for, and when. */
  state: string;
};

export function AddressControl(props: { slug: string; open: OpenAddressChange | null }) {
  const announce = useAnnounce();
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [value, setValue] = useState("");

  async function run(action: () => Promise<AddressActionResult>): Promise<boolean> {
    setWorking(true);
    try {
      const result = await action();
      if (result.ok) {
        announce({ text: result.toast, tone: "ok" });
        // As the other Settings controls do: the card is composed on the
        // server, so the page is read again to show the change as it stands.
        window.location.reload();
        return true;
      }
      announce({ text: result.message, tone: "problem", stepUpHref: result.stepUpHref });
      return false;
    } catch {
      announce({
        text: "Something went wrong on our side. Try again in a moment.",
        tone: "problem",
      });
      return false;
    } finally {
      setWorking(false);
    }
  }

  if (props.open) {
    return (
      <div className="border-line mt-2 rounded-md border px-4 py-3 text-sm">
        <p>
          Changing to <span className="font-semibold">{props.open.newEmail}</span>.{" "}
          {props.open.state}
        </p>
        <button
          type="button"
          disabled={working}
          onClick={() => void run(() => stopAddressChangeAction(props.slug))}
          className="border-line mt-2 min-h-11 rounded-full border px-4 font-semibold disabled:opacity-50"
        >
          {working ? "Stopping…" : "Stop this change"}
        </button>
      </div>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="border-line mt-2 min-h-11 rounded-full border px-4 text-sm font-semibold"
      >
        Change address
      </button>
    );
  }

  return (
    <form
      className="mt-2 grid gap-2 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => requestAddressChangeAction(props.slug, value)).then((ok) => {
          if (ok) {
            setEditing(false);
            setValue("");
          }
        });
      }}
    >
      <label htmlFor={inputId} className="font-semibold">
        The new address
      </label>
      <input
        id={inputId}
        type="email"
        autoComplete="email"
        required
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="border-line w-full rounded-md border px-4 py-3 text-base"
      />
      <p className="text-muted">
        We email it a link to confirm. The change takes effect 72 hours after it&rsquo;s used, and
        until then this address can stop it. It needs Face ID or your screen lock.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={working}
          className="bg-ink min-h-11 rounded-full px-4 font-bold text-white disabled:opacity-50"
        >
          {working ? "Sending…" : "Email the link"}
        </button>
        <button
          type="button"
          disabled={working}
          onClick={() => setEditing(false)}
          className="border-line min-h-11 rounded-full border px-4 font-semibold"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
