import { Failure, Section } from "@/components/admin/ui";
import { hoursWaited, waited, writeProblemWords } from "@/components/admin/queue-words";
import { clinicTabPath } from "@/lib/admin/issue-link";
import type {
  MachineQueue,
  MachineQueues,
  OpsResult,
  StuckCalendarWrites,
  StuckCalendarWriteView,
  UndeliveredTranscriptClinicView,
} from "@/lib/admin/ops-client";

/**
 * The System page's read-only view of the machine queues (ops automation
 * Phase 5, lane P5b; the owner's decision of 24 October 2026): what is past
 * its patience under "Requires your attention", and the queues that are fine
 * as counts under "Being watched". Home's queue rows and the undelivered
 * transcripts row link here (`#attention`, `#transcripts`), and the alerts'
 * wording quotes the three headings and the two sub-headings, so the words
 * are fixed.
 *
 * Nothing here acts: a queue with a page of its own is a link to it, drawn
 * from the `href` apps/app composed (a queue that spans clinics opens this
 * section, one clinic's opens its tab), never rebuilt here. The stuck
 * calendar writes link to the clinic's Setup tab at its "Calendar writes"
 * section; the undelivered transcripts to its Deliveries tab.
 *
 * An empty section is one line, never a table of zeros. A part apps/app could
 * not read is named ("Stripe events could not be read") and is never drawn as
 * a zero; a whole read that failed says so once, in the section that needed
 * it. The counts under "Being watched" are those read in full.
 */

/** The address of this section itself: a queue whose href is this is drawn as words, not a link to where the reader already is. */
const SELF = "/admin/system#attention";

function partialLine(part: string): string {
  // apps/app names each part in lower case ("Stripe events", "paid orders", "3 clinic(s)").
  return `${part} could not be read.`;
}

function QueueRow({ queue }: { queue: MachineQueue }) {
  const link = queue.href !== SELF;
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5">
      {link ? (
        <a href={queue.href} className="font-semibold underline underline-offset-2">
          {queue.words}
        </a>
      ) : (
        <span className="font-semibold">{queue.words}</span>
      )}
      <span>{queue.count}</span>
      {queue.oldestAgeMinutes !== null ? <span className="text-muted">oldest waiting {waited(queue.oldestAgeMinutes)}</span> : null}
    </li>
  );
}

type ClinicWrites = { clinicId: string; clinicName: string; count: number; oldest: StuckCalendarWriteView };

/** The writes by clinic, keeping apps/app's order (newest problem first), so the last of a clinic's rows is its oldest. */
export function writesByClinic(writes: readonly StuckCalendarWriteView[]): ClinicWrites[] {
  const byClinic = new Map<string, ClinicWrites>();
  for (const write of writes) {
    const seen = byClinic.get(write.clinicId);
    if (seen) {
      seen.count += 1;
      seen.oldest = write;
    } else {
      byClinic.set(write.clinicId, { clinicId: write.clinicId, clinicName: write.clinicName, count: 1, oldest: write });
    }
  }
  return [...byClinic.values()];
}

function StuckWrites({ writes }: { writes: StuckCalendarWrites }) {
  const clinics = writesByClinic(writes.writes);
  return (
    <>
      <ul className="divide-line divide-y text-sm">
        {clinics.map((c) => (
          <li key={c.clinicId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5">
            <a href={`${clinicTabPath(c.clinicId, "setup")}#calendar-writes`} className="font-semibold underline underline-offset-2">
              {c.clinicName}
            </a>
            <span>{c.count}</span>
            <span className="text-muted">oldest {writeProblemWords(c.oldest)}</span>
          </li>
        ))}
      </ul>
      {writes.truncated ? (
        <p className="text-muted mt-2 text-sm">
          Cut off at {writes.writes.length}: {writes.count} stuck writes were found in all.
        </p>
      ) : null}
    </>
  );
}

function countWords(counts: UndeliveredTranscriptClinicView["counts"]): string {
  const parts = [
    counts.overdue > 0 ? `${counts.overdue} overdue` : null,
    counts.bounced > 0 ? `${counts.bounced} bounced` : null,
    counts.expired > 0 ? `${counts.expired} expired` : null,
    counts.unconfirmed > 0 ? `${counts.unconfirmed} unconfirmed` : null,
  ].filter((p): p is string => p !== null);
  return parts.join(", ");
}

function Transcripts({ clinics }: { clinics: UndeliveredTranscriptClinicView[] }) {
  return (
    <ul className="divide-line divide-y text-sm">
      {clinics.map((c) => (
        <li key={c.clinicId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5">
          <a href={clinicTabPath(c.clinicId, "deliveries")} className="font-semibold underline underline-offset-2">
            {c.clinicName}
          </a>
          <span>{countWords(c.counts)}</span>
          {c.oldestAgeHours !== null ? <span className="text-muted">oldest waiting {hoursWaited(c.oldestAgeHours)}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function Subheading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="mt-5 scroll-mt-24 text-sm font-bold first:mt-0">
      {children}
    </h3>
  );
}

export function Attention({
  queues,
  writes,
  transcripts,
}: {
  queues: OpsResult<MachineQueues>;
  writes: OpsResult<StuckCalendarWrites>;
  transcripts: OpsResult<{ clinics: UndeliveredTranscriptClinicView[]; unreadClinics: number }>;
}) {
  const needing = queues.ok ? queues.data.queues.filter((q) => q.needsAttention) : [];
  const stuck = writes.ok ? writes.data.writes : [];
  const undelivered = transcripts.ok ? transcripts.data.clinics : [];
  const partial = [
    ...(queues.ok ? queues.data.partial.map(partialLine) : []),
    ...(writes.ok && writes.data.unreadClinics > 0 ? [`${writes.data.unreadClinics} clinic(s) could not be read for stuck calendar writes.`] : []),
    ...(transcripts.ok && transcripts.data.unreadClinics > 0 ? [`${transcripts.data.unreadClinics} clinic(s) could not be read for transcript copies.`] : []),
  ];
  const allRead = queues.ok && writes.ok && transcripts.ok && partial.length === 0;
  const nothing = needing.length === 0 && stuck.length === 0 && undelivered.length === 0;

  return (
    <Section id="attention" title="Requires your attention">
      {allRead && nothing ? <p className="text-sm">Nothing needs you here.</p> : null}
      {needing.length > 0 ? (
        <ul className="divide-line divide-y text-sm">
          {needing.map((q) => (
            <QueueRow key={q.key} queue={q} />
          ))}
        </ul>
      ) : null}
      {!queues.ok ? <Failure failure={queues} what="the machine queues" /> : null}

      {stuck.length > 0 || !writes.ok ? (
        <>
          <Subheading id="calendar-writes">Calendar writes stuck</Subheading>
          {writes.ok ? <StuckWrites writes={writes.data} /> : <Failure failure={writes} what="the stuck calendar writes" />}
        </>
      ) : null}

      {undelivered.length > 0 || !transcripts.ok ? (
        <>
          <Subheading id="transcripts">Transcript copies not delivered</Subheading>
          {transcripts.ok ? <Transcripts clinics={undelivered} /> : <Failure failure={transcripts} what="the undelivered transcript copies" />}
        </>
      ) : null}

      {partial.map((line) => (
        <p key={line} role="status" className="text-red-deep mt-3 text-sm font-semibold">
          {line}
        </p>
      ))}
    </Section>
  );
}

/** The queues that are fine, name and count, one compact list. Nothing when the queues could not be read: the section above said so. */
export function BeingWatched({ queues }: { queues: OpsResult<MachineQueues> }) {
  if (!queues.ok) return null;
  const fine = queues.data.queues.filter((q) => !q.needsAttention);
  return (
    <Section title="Being watched">
      {fine.length === 0 ? (
        <p className="text-muted text-sm">No queue was read in full.</p>
      ) : (
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {fine.map((q) => (
            <li key={q.key}>
              <span className="text-muted">{q.words}</span> {q.count}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
