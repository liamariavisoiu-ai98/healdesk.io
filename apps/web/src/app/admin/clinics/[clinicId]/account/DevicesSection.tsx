"use client";

import { useState, useTransition } from "react";

import type {
  ClinicDevicesView,
  DeviceRecoveryRow,
  EndDeviceRecoveryOutcome,
  IssueDeviceRecoveryOutcome,
  OpsResult,
  RemoveClinicDevicesOutcome,
} from "@/lib/admin/ops-client";

/**
 * The clinic's devices on its account page (wave 2, R4; plan Part D3 and
 * Annex X5's O3): the sign-in's devices by the names staff gave them, its
 * backup, the browsers signed in, and the two acts that need a person:
 *
 *   - the human route, for a clinic that has lost every device: a one-time
 *     link to the clinic's address on file, which lets one device be added
 *     within 24 hours;
 *   - O3's promise, after the clinic replies to a device email: the devices
 *     ticked removed, every browser signed out and the backup reset.
 *
 * Each needs the call back to the practice's published number, ticked, and
 * a fresh code from the operator's authenticator, checked on this app before
 * anything crosses (lib/admin/device-recovery.ts). Ending a link only takes
 * access away, so it needs neither.
 */

export type DevicesActions = {
  issueRecovery: (input: {
    code: string;
    calledBack: boolean;
  }) => Promise<OpsResult<IssueDeviceRecoveryOutcome>>;
  endRecovery: () => Promise<OpsResult<EndDeviceRecoveryOutcome>>;
  removeDevices: (input: {
    code: string;
    calledBack: boolean;
    factorIds: string[];
  }) => Promise<OpsResult<RemoveClinicDevicesOutcome>>;
};

/** "2026-10-09 14:32 UTC": the console's clock, as everywhere else in it. */
function utc(iso: string | null): string {
  if (!iso) return "";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const STATE_WORDS: Record<DeviceRecoveryRow["state"], string> = {
  open: "sent, not used yet",
  claimed: "opened, no device added yet",
  used: "a device was added with it",
  expired: "expired unused",
  ended: "ended unused",
};

const REASON_WORDS: Record<NonNullable<DeviceRecoveryRow["revokedReason"]>, string> = {
  replaced: "a newer link replaced it",
  someone_left: "the clinic used Someone left",
  operator_signed_out: "ops signed everyone out",
  operator_ended: "ops ended it",
  address_changed: "the clinic's sign-in address began to change, or moved",
};

type Note = { tone: "ok" | "bad"; text: string } | null;

function NoteLine({ note }: { note: Note }) {
  return note ? (
    <p
      role="status"
      className={note.tone === "bad" ? "text-red-deep font-semibold" : "font-semibold"}
    >
      {note.text}
    </p>
  ) : null;
}

function CodeField() {
  return (
    <label className="grid gap-1">
      <span className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">
        Code from your authenticator
      </span>
      <input
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        className="border-line w-40 rounded-sm border bg-white px-3 py-2.5 font-mono"
      />
    </label>
  );
}

export function DevicesSection({
  view,
  actions,
}: {
  view: OpsResult<ClinicDevicesView>;
  actions: DevicesActions;
}) {
  return (
    <section className="border-line mt-8 rounded-md border bg-white p-5">
      <h2 className="text-lg font-semibold">Devices</h2>
      <div className="mt-2">
        {!view.ok ? (
          <p className="text-red-deep text-sm font-semibold">{view.message}</p>
        ) : !view.data.hasSignIn ? (
          <p className="text-muted text-sm">No sign-in on file, so no devices.</p>
        ) : (
          <Devices v={view.data} actions={actions} />
        )}
      </div>
    </section>
  );
}

function Devices({ v, actions }: { v: ClinicDevicesView; actions: DevicesActions }) {
  const open = v.recoveries.find((r) => r.state === "open" || r.state === "claimed");
  return (
    <div className="grid gap-4 text-sm">
      <div>
        {v.devices.length === 0 ? (
          <p className="font-semibold">No device can open patient details.</p>
        ) : (
          <ul className="grid gap-1">
            {v.devices.map((d) => (
              <li key={d.id}>
                <span className="font-semibold">{d.label}</span>
                <span className="text-muted">
                  {" "}
                  · added {utc(d.addedAt)}
                  {d.lastUsedAt ? ` · last used ${utc(d.lastUsedAt)}` : " · not used yet"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted mt-1">
          {v.hasBackup
            ? `Authenticator backup set, ${v.backupCodesLeft} backup codes left.`
            : `No authenticator backup${v.backupCodesLeft > 0 ? `, ${v.backupCodesLeft} backup codes left` : ""}.`}{" "}
          Browsers signed in now: {v.sessions}.
        </p>
        <p className="text-muted mt-1">
          {v.patientDataMayExist
            ? "Patient details may exist, so a sign-in link alone adds no device: another device, a code from the backup, or the link below."
            : "Not live yet: the clinic can add its first device from any signed-in browser, so no link is needed."}
        </p>
      </div>

      {open ? (
        <OpenLink row={open} onEnd={actions.endRecovery} />
      ) : v.addressChangeOpen ? (
        <p className="border-line rounded-sm border px-4 py-3">
          <span className="font-semibold">No link can be sent now.</span> A change of the
          clinic&rsquo;s sign-in address is under way (see above), so the address on file is the one
          being retired, and a link sent now would go there. Send one once the change has taken
          effect, or after it is stopped.
        </p>
      ) : (
        <SendLink onSend={actions.issueRecovery} />
      )}
      {v.devices.length > 0 || v.sessions > 0 || v.hasBackup ? (
        <RemoveForm devices={v.devices} onRemove={actions.removeDevices} />
      ) : null}

      {v.recoveries.length > 0 ? (
        <ul className="grid gap-2">
          {v.recoveries.map((r) => (
            <li key={r.id} className="border-line rounded-sm border bg-white px-3 py-2">
              Link {STATE_WORDS[r.state]}
              {r.revokedReason ? `: ${REASON_WORDS[r.revokedReason]}` : ""}
              <span className="text-muted block">
                Sent by {r.issuedBy}, {utc(r.createdAt)}; works until {utc(r.expiresAt)}
                {r.usedAt ? ` · device added ${utc(r.usedAt)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function OpenLink({
  row,
  onEnd,
}: {
  row: DeviceRecoveryRow;
  onEnd: DevicesActions["endRecovery"];
}) {
  const [note, setNote] = useState<Note>(null);
  const [pending, start] = useTransition();
  return (
    <div className="border-line rounded-sm border px-4 py-3">
      <p>
        A link to add a device is out: {STATE_WORDS[row.state]}, working until {utc(row.expiresAt)}.
      </p>
      <p className="text-muted mt-1">
        If the clinic says nobody there asked for it, end it. Sending another also ends it.
        {row.state === "claimed"
          ? " A browser has opened it: ending it signs that browser out too."
          : ""}
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await onEnd();
            setNote(
              !result.ok
                ? { tone: "bad", text: result.message }
                : result.data.status === "ended"
                  ? {
                      tone: "ok",
                      text:
                        result.data.browsersSignedOut > 0
                          ? `Ended, and the browser that had opened it was signed out.`
                          : "Ended. No browser had opened it.",
                    }
                  : { tone: "ok", text: "Nothing was open." },
            );
          })
        }
        className="border-line-strong hover:border-ink mt-3 rounded-full border px-5 py-2 text-sm font-bold disabled:opacity-50"
      >
        {pending ? "Ending…" : "End this link"}
      </button>
      <NoteLine note={note} />
    </div>
  );
}

function SendLink({ onSend }: { onSend: DevicesActions["issueRecovery"] }) {
  const [note, setNote] = useState<Note>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="border-line grid gap-3 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        start(async () => {
          const result = await onSend({
            code: String(form.get("code") ?? ""),
            calledBack: form.get("calledBack") === "on",
          });
          if (!result.ok) return setNote({ tone: "bad", text: result.message });
          if (result.data.status !== "issued")
            return setNote({ tone: "bad", text: result.data.message });
          setNote({
            tone: "ok",
            text: `Sent to the clinic's address. It works until ${utc(result.data.expiresAt)}${
              result.data.emailed ? "." : ", but the email did not go: check Resend."
            }`,
          });
        });
      }}
    >
      <p className="font-semibold">Send a link to add a device (the clinic lost every device)</p>
      <p className="text-muted">
        Only after calling the practice back on its published number. The link goes to the
        clinic&rsquo;s address on file and nowhere else; it signs in and lets one device be added,
        once, within 24 hours. The clinic is emailed when the device is added.
      </p>
      <label className="flex items-center gap-2">
        <input name="calledBack" type="checkbox" />I called the practice back on its published
        number, and it asked for this.
      </label>
      <CodeField />
      <button
        type="submit"
        disabled={pending}
        className="bg-ink w-fit rounded-full px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
      >
        {pending ? "Sending…" : "Send the link"}
      </button>
      <NoteLine note={note} />
    </form>
  );
}

function RemoveForm({
  devices,
  onRemove,
}: {
  devices: ClinicDevicesView["devices"];
  onRemove: DevicesActions["removeDevices"];
}) {
  const [note, setNote] = useState<Note>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="border-line grid gap-3 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        start(async () => {
          const result = await onRemove({
            code: String(form.get("code") ?? ""),
            calledBack: form.get("calledBack") === "on",
            factorIds: form.getAll("factorId").map(String),
          });
          if (!result.ok) return setNote({ tone: "bad", text: result.message });
          if (result.data.status !== "done")
            return setNote({ tone: "bad", text: result.data.message });
          setNote({
            tone: "ok",
            text: `Done: ${result.data.removedDevices} removed, ${result.data.sessionsEnded} browsers signed out${
              result.data.backupReset ? ", the backup reset" : ""
            }. The clinic has been emailed.`,
          });
        });
      }}
    >
      <p className="font-semibold">
        Remove devices and sign everyone out (the clinic replied to a device email)
      </p>
      <p className="text-muted">
        Every browser is signed out, the devices ticked are removed, and the authenticator backup
        and backup codes are reset, as Someone left does. Never on the reply alone: call the
        practice back first.
      </p>
      {devices.length > 0 ? (
        <fieldset className="grid gap-1">
          <legend className="font-semibold">Remove these devices</legend>
          {devices.map((d) => (
            <label key={d.id} className="flex items-center gap-2">
              <input name="factorId" value={d.id} type="checkbox" />
              {d.label}
            </label>
          ))}
        </fieldset>
      ) : null}
      <label className="flex items-center gap-2">
        <input name="calledBack" type="checkbox" />
        The clinic replied, and I called it back on its published number to confirm.
      </label>
      <CodeField />
      <button
        type="submit"
        disabled={pending}
        className="bg-ink w-fit rounded-full px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
      >
        {pending ? "Signing everyone out…" : "Remove and sign everyone out"}
      </button>
      <NoteLine note={note} />
    </form>
  );
}
