"use client";

import { ActionButton, Failure, Section } from "@/components/admin/ui";
import type { ClinicSwitches as ClinicSwitchesRead, ClinicSwitchView, OpsResult, SetClinicSwitchOutcome } from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { CHOICE_OPTIONS, groupSwitches, valueWords } from "./switch-groups";

/**
 * The Setup tab's "Clinic switches" section: every switch the clinic has in
 * its portal Settings, in the portal's cards, with the value it has now. A
 * switch the server says is unavailable shows the server's own reason, word
 * for word, and its buttons are off; this page never works out availability
 * itself. A change is one press and one plain confirm: it is reversible, the
 * portal's own save audits it and emails ops, so no passcode is asked. What
 * the server answers (its toast, and a notice for every other switch the
 * change turned back) is shown beneath. A switch the clinic alone may change
 * (`operatorMayChange` false) is shown and not offered.
 */

export type SetClinicSwitch = (key: string, value: boolean | string) => Promise<OpsResult<SetClinicSwitchOutcome>>;

/** The one sentence after a change: the server's toast, then each notice it sent for a switch turned back. */
export function doneWords(outcome: Extract<SetClinicSwitchOutcome, { status: "set" }>): string {
  return [outcome.toast, ...outcome.resets.map((r) => r.notice)].join(" ");
}

type Choice = { label: string; value: boolean | string };

/** What the operator may set it to: the other side of a switch, or the other options of a known choice. */
export function offeredChanges(row: ClinicSwitchView): Choice[] {
  if (!row.operatorMayChange) return [];
  if (row.kind === "switch") return [{ label: row.value === true ? "Switch off" : "Switch on", value: row.value !== true }];
  return (CHOICE_OPTIONS[row.key] ?? []).filter((o) => o.value !== row.value).map((o) => ({ label: `Set to ${o.label}`, value: o.value }));
}

function SwitchRow({ row, onSet }: { row: ClinicSwitchView; onSet: SetClinicSwitch }) {
  const changes = offeredChanges(row);
  return (
    <li className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-start sm:gap-4">
      <div className="grid gap-0.5">
        <span className="text-sm font-semibold">{row.label}</span>
        <span className="text-sm">
          Now: <strong>{valueWords(row)}</strong>
        </span>
        {!row.enabled && row.reason ? <span className="text-muted text-sm">{row.reason}</span> : null}
        {!row.enabled && !row.reason ? <span className="text-muted text-sm">Not available right now.</span> : null}
        {!row.operatorMayChange ? <span className="text-muted text-sm">Only the clinic changes this, in its Settings.</span> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {changes.map((change) => (
          <ActionButton
            key={String(change.value)}
            label={change.label}
            disabled={!row.enabled}
            confirm={`Change "${row.label}" for this clinic? It is saved and logged as ours, and ops is emailed.`}
            run={() => onSet(row.key, change.value)}
            done={(data) => (data.status === "set" ? doneWords(data) : null)}
          />
        ))}
      </div>
    </li>
  );
}

export function ClinicSwitches({ read, onSet }: { read: OpsResult<ClinicSwitchesRead>; onSet: SetClinicSwitch }) {
  if (!read.ok) {
    return (
      <Section id="clinic-switches" title="Clinic switches">
        {isHostUnreachable(read) ? (
          <p role="status" className="text-sm">
            The AWS host is in standby, so the clinic&apos;s switches cannot be read or changed until it is on again.
          </p>
        ) : (
          <Failure failure={read} what="the clinic's switches" />
        )}
      </Section>
    );
  }
  const groups = groupSwitches(read.data.switches);
  return (
    <Section id="clinic-switches" title="Clinic switches">
      <p className="text-muted text-sm">The same switches the clinic has in its Settings. A change here is logged as ours.</p>
      {groups.length === 0 ? <p className="mt-3 text-sm">No switches were sent.</p> : null}
      {groups.map((group) => (
        <div key={group.title} className="mt-4">
          <h3 className="text-sm font-bold">{group.title}</h3>
          <ul className="divide-line divide-y">
            {group.rows.map((row) => (
              <SwitchRow key={row.key} row={row} onSet={onSet} />
            ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}
