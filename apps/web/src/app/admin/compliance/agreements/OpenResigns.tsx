import { CHASE_BLOCK_WORDS, onDay, RESIGN_REASON_WORDS, whenWords } from "@/components/admin/approval-words";
import { Failure, Section, Tag } from "@/components/admin/ui";
import { clinicTabPath } from "@/lib/admin/issue-link";
import type { OpenResignRow, OpsResult } from "@/lib/admin/ops-client";

/**
 * Compliance › Agreements › "Open BAA re-signs" (ops automation lane P6j; the
 * operation is lane P6f's, apps/app lib/ops/resign-ops.ts listOpenResigns):
 * every open re-sign across clinics, below the floor first, then the
 * longest open: the clinic, why it signs again, from which version to which,
 * how long it has been open, the last signing email and when the latest
 * link stops working, the last chase, whether it holds AYA paused, and
 * whether the approvals job may propose a chase now or why not.
 *
 * There is no button here, on purpose: apps/app has no operation that
 * proposes a chase by hand. The approvals job proposes one itself
 * (lib/approvals/contact-proposers.ts) for an updated-version re-sign that
 * is open to the practice, from day 8 once the re-sign's own reminders
 * (days 0, 3 and 7) have gone, and at most once every 7 days; each waits
 * for the owner's yes under Queues › Approvals. Nothing on this page sends
 * anything. Ids, versions, dates and closed words; never a person.
 */

export const CHASE_RULE =
  "Chases are the approvals job's: for a BAA version re-sign, from day 8 once the re-sign's own reminders (days 0, 3 and 7) have gone, and at most once every 7 days, it proposes a chase email for your yes under Queues › Approvals. Nothing is sent from this page.";

export const EMPTY_RESIGNS = "No re-sign is open.";

/** How many re-signs could not be read: the list may be missing some. */
export function unreadWords(n: number): string {
  return `${n} ${n === 1 ? "re-sign" : "re-signs"} could not be read, so this list may be missing some.`;
}

/**
 * Whether a chase may be proposed now, or why not, in one phrase. The
 * re-sign's facts can say nothing blocks one; whether the job proposes it
 * is the job's switch and the inbox's own rule (store.ts propose(): nothing
 * while this round's chase waits or was rejected).
 */
export function chaseWords(row: Pick<OpenResignRow, "chaseBlocked">): string {
  return row.chaseBlocked === null
    ? "nothing in the re-sign blocks one; the approvals job proposes it at its next run while it is on, unless this round's chase is already waiting or was rejected"
    : `not now: ${CHASE_BLOCK_WORDS[row.chaseBlocked]}`;
}

export function OpenResigns({ resigns, now }: { resigns: OpsResult<{ resigns: OpenResignRow[]; unread: number }>; now: string }) {
  return (
    <Section id="open-resigns" title="Open BAA re-signs">
      <p className="text-muted max-w-[72ch] text-sm">{CHASE_RULE}</p>
      {!resigns.ok ? <Failure failure={resigns} what="the open re-signs" /> : null}
      {resigns.ok && resigns.data.unread > 0 ? (
        <p role="status" className="text-red-deep mt-3 text-sm font-semibold">
          {unreadWords(resigns.data.unread)}
        </p>
      ) : null}
      {resigns.ok && resigns.data.resigns.length === 0 ? <p className="mt-3 text-sm">{EMPTY_RESIGNS}</p> : null}
      {resigns.ok && resigns.data.resigns.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">
                <th className="py-1 pr-3">Clinic</th>
                <th className="py-1 pr-3">Why</th>
                <th className="py-1 pr-3">From, to</th>
                <th className="py-1 pr-3">Open</th>
                <th className="py-1 pr-3">Last signing email</th>
                <th className="py-1 pr-3">Latest link works until</th>
                <th className="py-1 pr-3">Last chase</th>
                <th className="py-1">A chase</th>
              </tr>
            </thead>
            <tbody className="divide-line divide-y">
              {resigns.data.resigns.map((row) => (
                <tr key={row.resignId}>
                  <td className="py-1.5 pr-3">
                    <a href={clinicTabPath(row.clinic.id, "care")} className="font-semibold underline underline-offset-2">
                      {row.clinic.name ?? "A clinic with no printable name"}
                    </a>
                    {row.belowFloor ? (
                      <>
                        {" "}
                        <Tag tone="bad">Below the floor: phone the practice</Tag>
                      </>
                    ) : null}
                    {row.holdsPause ? (
                      <>
                        {" "}
                        <Tag tone="warn">Holds AYA paused</Tag>
                      </>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-3">{RESIGN_REASON_WORDS[row.reason]}</td>
                  <td className="py-1.5 pr-3">
                    {row.fromVersion ?? "the version in force"} → {row.toVersion}
                  </td>
                  <td className="py-1.5 pr-3">
                    {row.daysOpen} {row.daysOpen === 1 ? "day" : "days"}, since {onDay(row.startedAt)}
                  </td>
                  <td className="py-1.5 pr-3">{row.lastL22SentAt ? onDay(row.lastL22SentAt) : "none recorded"}</td>
                  <td className="py-1.5 pr-3">{row.linkExpiresAt ? `${whenWords(row.linkExpiresAt)}${Date.parse(row.linkExpiresAt) < Date.parse(now) ? " (expired)" : ""}` : "no link sent yet"}</td>
                  <td className="py-1.5 pr-3">{row.lastChaseAt ? onDay(row.lastChaseAt) : "none yet"}</td>
                  <td className="py-1.5">{chaseWords(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Section>
  );
}
