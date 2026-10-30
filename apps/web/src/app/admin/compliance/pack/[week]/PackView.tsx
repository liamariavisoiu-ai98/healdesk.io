import { onDay, whenWords } from "@/components/admin/approval-words";
import {
  ACCESS_EVENT_WORDS,
  AGREEMENT_WORDS,
  APPROVAL_INBOX_WORDS,
  AT_RISK_HEADING,
  AT_RISK_WORDS,
  couldNotReadWords,
  FAILURE_EVENT_WORDS,
  FRESH_CODE_WORDS,
  generatedByWords,
  HEADLINE_WORDS,
  INCIDENT_WORDS,
  lateWords,
  LAUNCH_PROMISES_WORDS,
  LIFECYCLE_JOB_WORDS,
  MEDIAN_WORDS,
  minutesWords,
  PACK_CLASS_WORDS,
  partialWords,
  RIGHTS_WORDS,
  runStatusWords,
  SECTION_WORDS,
  SIGN_INS_WORDS,
  SUBJECT_WORDS,
  TARGET_MISSED_HEADING,
  TARGET_MISSED_WORDS,
  TRANSCRIPT_WORDS,
  VENDOR_RECORDED_WORDS,
  VENDOR_STATE_WORDS,
  weekWords,
  WHEN_WORDS,
  type NumberWords,
  type PackSectionName,
  type When,
} from "@/components/admin/pack-words";
import { RIGHTS_KIND_WORDS } from "@/components/admin/rights-words";
import { Section } from "@/components/admin/ui";
import { clinicTabPath } from "@/lib/admin/issue-link";
import type { CompliancePackRecordView, CompliancePackView } from "@/lib/admin/ops-client";

import { LaunchPromises } from "../../LaunchPromises";
import { PrintButton } from "../PrintButton";

/**
 * One stored compliance pack, printable (ops automation lane P6j; the pack
 * is lane P6h's, apps/app lib/compliance-pack/build.ts): the week, how and
 * when it was stored and its fingerprint; the five headline numbers; then
 * every section in plain words, each number with its label, what it
 * measures and when it was measured (this week, at week end, now: the three
 * explained once at the top). A section the pack could not read says so and
 * shows no numbers, never a zero; a pack stored incomplete or made late says
 * so in a banner. The launch promises are read from this app when the page
 * is drawn, never stored in the pack, and the page says so.
 *
 * Printing hides the console's header (the one `<header>` the admin layout
 * renders, app/admin/layout.tsx; this page renders none of its own) and the
 * controls, and starts each group of sections on a new page: the week and
 * the agreements; incidents and patient rights; data, access and the inbox;
 * the launch promises.
 */

export const PRINT_HIDE_RULE = "header, .no-print { display: none !important; }";

const PRINT_CSS = `@media print {
  ${PRINT_HIDE_RULE}
  .pack-group { break-before: page; page-break-before: always; }
  .pack-group:first-of-type { break-before: auto; page-break-before: auto; }
  main { padding: 0 !important; max-width: none !important; }
  section { break-inside: avoid; page-break-inside: avoid; border: none !important; box-shadow: none !important; }
}`;

const WHEN_TAG: Record<When, string> = { "this week": "this week", "at week end": "at week end", now: "now" };

function Number_({ value, words }: { value: number | string; words: NumberWords }) {
  return (
    <div className="border-line flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b py-1.5 last:border-b-0">
      <span className="w-14 text-right text-lg font-bold tabular-nums">{value}</span>
      <span className="font-semibold">{words.label}</span>
      <span className="text-muted text-xs tracking-[0.04em] uppercase">{WHEN_TAG[words.when]}</span>
      <span className="text-muted basis-full text-sm sm:basis-auto">{words.measures}</span>
    </div>
  );
}

function Numbers<T extends Record<string, NumberWords>>({ values, words }: { values: { [K in keyof T]: number }; words: T }) {
  return (
    <div className="text-sm">
      {(Object.keys(words) as (keyof T & string)[]).map((field) => (
        <Number_ key={field} value={values[field]} words={words[field]!} />
      ))}
    </div>
  );
}

function CouldNotRead({ unreadClinics }: { unreadClinics?: number }) {
  return (
    <p role="status" className="text-red-deep text-sm font-semibold">
      {couldNotReadWords(unreadClinics)}
    </p>
  );
}

function Counted({ rows, words, none }: { rows: { key: string; count: number }[]; words: Readonly<Record<string, string>>; none: string }) {
  if (rows.length === 0) return <p className="text-muted text-sm">{none}</p>;
  return (
    <ul className="grid gap-0.5 text-sm">
      {rows.map((row) => (
        <li key={row.key}>
          <span className="font-semibold tabular-nums">{row.count}</span> {words[row.key] ?? row.key.replace(/_/g, " ")}
        </li>
      ))}
    </ul>
  );
}

function Group({ children, first = false }: { children: React.ReactNode; first?: boolean }) {
  return <div className={`pack-group${first ? "" : " print:break-before-page"}`}>{children}</div>;
}

function Agreements({ section }: { section: CompliancePackView["agreements"] }) {
  if (section.status === "could_not_read") return <CouldNotRead unreadClinics={section.unreadClinics} />;
  return (
    <div className="grid gap-4">
      <div>
        <h3 className="text-sm font-semibold">Agreements bound to a paying account this week</h3>
        <p className="text-muted text-sm">Counted by when provisioning bound them, not when they were signed, so a signature taken at checkout counts the week it reached the host.</p>
        <Counted
          rows={section.boundThisWeek.map((r) => ({ key: `${r.kind}:${r.version}`, count: r.count }))}
          words={Object.fromEntries(section.boundThisWeek.map((r) => [`${r.kind}:${r.version}`, `${r.kind === "baa" ? "BAA" : "DPA"} version ${r.version}`]))}
          none="None this week."
        />
      </div>
      <div>
        <h3 className="text-sm font-semibold">Re-signs</h3>
        <Numbers values={section.resigns} words={AGREEMENT_WORDS.resigns} />
      </div>
      <div>
        <h3 className="text-sm font-semibold">Agreement checks</h3>
        <Numbers values={section.reviews} words={AGREEMENT_WORDS.reviews} />
      </div>
    </div>
  );
}

function Vendors({ section }: { section: CompliancePackView["vendors"] }) {
  if (section.status === "could_not_read") return <CouldNotRead unreadClinics={section.unreadClinics} />;
  return (
    <div className="grid gap-3 text-sm">
      <p className="text-muted">Each subject as its latest attestation stood when the week ended; an attestation lapses the day after its expiry.</p>
      <table className="w-full text-left">
        <thead>
          <tr className="text-muted text-xs font-bold tracking-[0.06em] uppercase">
            <th className="py-1 pr-3">Subject</th>
            <th className="py-1 pr-3">Kind</th>
            <th className="py-1 pr-3">State at week end</th>
            <th className="py-1 pr-3">Effective</th>
            <th className="py-1 pr-3">Expires</th>
          </tr>
        </thead>
        <tbody className="divide-line divide-y">
          {section.subjects.map((s) => (
            <tr key={s.subject}>
              <td className="py-1.5 pr-3">{SUBJECT_WORDS[s.subject]}</td>
              <td className="py-1.5 pr-3">{s.kind === "vendor" ? "vendor agreement" : "readiness"}</td>
              <td className={`py-1.5 pr-3 ${s.state === "in_force" ? "" : "text-red-deep font-semibold"}`}>
                {VENDOR_STATE_WORDS[s.state]}
                {s.expiresWithin30Days ? ", ends within 30 days" : ""}
              </td>
              <td className="py-1.5 pr-3">{s.effectiveOn ? onDay(s.effectiveOn) : "—"}</td>
              <td className="py-1.5 pr-3">{s.expiresOn ? onDay(s.expiresOn) : "none set"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Number_ value={section.recordedThisWeek} words={VENDOR_RECORDED_WORDS} />
    </div>
  );
}

function Incidents({ section }: { section: CompliancePackView["incidents"] }) {
  if (section.status === "could_not_read") return <CouldNotRead unreadClinics={section.unreadClinics} />;
  const { openedByClass, targetMissed, agreementDeadlineAtRisk, ...numbers } = section;
  return (
    <div className="grid gap-4 text-sm">
      <Numbers values={numbers} words={INCIDENT_WORDS} />
      <div>
        <h3 className="font-semibold">Opened this week, by class</h3>
        <Counted rows={openedByClass.map((r) => ({ key: r.class, count: r.count }))} words={PACK_CLASS_WORDS} none="None opened this week." />
      </div>
      <div>
        <h3 className="font-semibold">{TARGET_MISSED_HEADING}</h3>
        <p className="text-muted">{TARGET_MISSED_WORDS}</p>
        {targetMissed.length === 0 ? (
          <p className="text-muted">None.</p>
        ) : (
          <ul className="grid gap-0.5">
            {targetMissed.map((row) => (
              <li key={row.incidentId}>
                <a href={clinicTabPath(row.clinicId, "care")} className="underline underline-offset-2">
                  Clinic {row.clinicId}
                </a>
                , incident <code className="font-mono">{row.incidentId}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="font-semibold">{AT_RISK_HEADING}</h3>
        <p className="text-muted">{AT_RISK_WORDS}</p>
        {agreementDeadlineAtRisk.length === 0 ? (
          <p className="text-muted">None.</p>
        ) : (
          <ul className="grid gap-0.5">
            {agreementDeadlineAtRisk.map((row) => (
              <li key={row.incidentId}>
                <a href={clinicTabPath(row.clinicId, "care")} className="underline underline-offset-2">
                  Clinic {row.clinicId}
                </a>
                , incident <code className="font-mono">{row.incidentId}</code>: agreement deadline {onDay(row.agreementNotifyBy)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Rights({ section }: { section: CompliancePackView["rights"] }) {
  if (section.status === "could_not_read") return <CouldNotRead unreadClinics={section.unreadClinics} />;
  const { receivedByKind, ...numbers } = section;
  return (
    <div className="grid gap-4 text-sm">
      <p className="text-muted">Days are UTC calendar days, the tracker&rsquo;s own clock; demo clinics are left out.</p>
      <Numbers values={numbers} words={RIGHTS_WORDS} />
      <div>
        <h3 className="font-semibold">Received this week, by kind</h3>
        <Counted rows={receivedByKind.map((r) => ({ key: r.kind, count: r.count }))} words={RIGHTS_KIND_WORDS} none="None received this week." />
      </div>
    </div>
  );
}

function DataLifecycle({ section }: { section: CompliancePackView["dataLifecycle"] }) {
  if (section.status === "could_not_read") return <CouldNotRead unreadClinics={section.unreadClinics} />;
  return (
    <div className="grid gap-4 text-sm">
      <div>
        <h3 className="font-semibold">Transcript copies</h3>
        <Numbers values={section.transcripts} words={TRANSCRIPT_WORDS} />
      </div>
      <div>
        <h3 className="font-semibold">The purge jobs, as they stood when the pack was made</h3>
        <p className="text-muted">Their rows keep no history, so this is as of the build, not the week.</p>
        <table className="w-full text-left">
          <thead>
            <tr className="text-muted text-xs font-bold tracking-[0.06em] uppercase">
              <th className="py-1 pr-3">Job</th>
              <th className="py-1 pr-3">Switch</th>
              <th className="py-1 pr-3">Last run</th>
              <th className="py-1 pr-3">Its outcome</th>
            </tr>
          </thead>
          <tbody className="divide-line divide-y">
            {section.jobsNow.map((job) => (
              <tr key={job.job}>
                <td className="py-1.5 pr-3">{LIFECYCLE_JOB_WORDS[job.job]}</td>
                <td className={`py-1.5 pr-3 ${job.enabled ? "" : "text-red-deep font-semibold"}`}>{job.enabled ? "on" : "off"}</td>
                <td className="py-1.5 pr-3">{job.lastRunAt ? whenWords(job.lastRunAt) : "never"}</td>
                <td className="py-1.5 pr-3">{runStatusWords(job.lastRunStatus)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h3 className="font-semibold">Failure alerts raised this week</h3>
        <Counted rows={section.failureAlertsThisWeek.map((r) => ({ key: r.event, count: r.count }))} words={FAILURE_EVENT_WORDS} none="None." />
      </div>
    </div>
  );
}

function Access({ section }: { section: CompliancePackView["access"] }) {
  if (section.status === "could_not_read") return <CouldNotRead unreadClinics={section.unreadClinics} />;
  return (
    <div className="grid gap-4 text-sm">
      <div>
        <h3 className="font-semibold">Security events this week, by kind</h3>
        <p className="text-muted">Every kind is counted, zero or not.</p>
        <Counted rows={section.events.map((r) => ({ key: r.event, count: r.count }))} words={ACCESS_EVENT_WORDS} none="None." />
      </div>
      <div>
        <h3 className="font-semibold">Steps taken with a fresh authenticator code</h3>
        {/* The attestations are counted once, under Vendors and readiness. */}
        <Numbers values={{ approvalDecisions: section.freshCodeSteps.approvalDecisions, deviceRecoveriesIssued: section.freshCodeSteps.deviceRecoveriesIssued }} words={FRESH_CODE_WORDS} />
      </div>
      <p className="text-muted">{SIGN_INS_WORDS}</p>
    </div>
  );
}

function Approvals({ section }: { section: CompliancePackView["approvals"] }) {
  if (section.status === "could_not_read") return <CouldNotRead unreadClinics={section.unreadClinics} />;
  const { medianMinutesToDecide, ...numbers } = section;
  return (
    <div className="text-sm">
      <Numbers values={numbers} words={APPROVAL_INBOX_WORDS} />
      <Number_ value={medianMinutesToDecide === null ? "none" : minutesWords(medianMinutesToDecide)} words={MEDIAN_WORDS} />
      {medianMinutesToDecide === null ? <p className="text-muted mt-1">No decision was made this week, so there is no median.</p> : null}
    </div>
  );
}

const SECTIONS: { name: PackSectionName; render: (pack: CompliancePackView) => React.ReactNode }[] = [
  { name: "agreements", render: (p) => <Agreements section={p.agreements} /> },
  { name: "vendors", render: (p) => <Vendors section={p.vendors} /> },
  { name: "incidents", render: (p) => <Incidents section={p.incidents} /> },
  { name: "rights", render: (p) => <Rights section={p.rights} /> },
  { name: "dataLifecycle", render: (p) => <DataLifecycle section={p.dataLifecycle} /> },
  { name: "access", render: (p) => <Access section={p.access} /> },
  { name: "approvals", render: (p) => <Approvals section={p.approvals} /> },
];

function PackSection({ name, pack }: { name: PackSectionName; pack: CompliancePackView }) {
  const entry = SECTIONS.find((s) => s.name === name)!;
  return (
    <Section id={`pack-${name}`} title={SECTION_WORDS[name]}>
      {entry.render(pack)}
    </Section>
  );
}

export function PackView({ record }: { record: CompliancePackRecordView }) {
  const pack = record.payload;
  return (
    <main className="mx-auto w-full max-w-[1000px] px-4 py-10 sm:px-8">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      <Group first>
        <div className="no-print flex flex-wrap items-center justify-between gap-3 print:hidden">
          <a href="/admin/compliance/pack" className="text-muted text-sm underline underline-offset-2">
            ← Compliance packs
          </a>
          <PrintButton />
        </div>
        <h1 className="font-display mt-2 text-2xl leading-tight font-semibold tracking-[-0.02em]">Compliance pack</h1>
        <p className="mt-1 text-sm font-semibold">Week of {weekWords(pack.week)}</p>
        <p className="text-muted mt-1 text-sm">
          Stored {whenWords(record.generatedAt)} by {generatedByWords(record.generatedBy)}. A stored pack never changes. Fingerprint{" "}
          <code className="font-mono text-xs break-all">{record.payloadHash}</code>
        </p>
        {pack.build.partial ? (
          <p role="status" className="text-red-deep mt-3 text-sm font-semibold">
            {partialWords(pack.build.unreadSections)}
          </p>
        ) : null}
        {pack.build.builtLate ? (
          <p role="status" className="mt-2 text-sm font-semibold">
            {lateWords(pack.build.lateDays)}
          </p>
        ) : null}

        <Section id="pack-how-to-read" title="How to read the numbers">
          <dl className="grid gap-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
            {(Object.keys(WHEN_WORDS) as When[]).map((when) => (
              <div key={when} className="contents">
                <dt className="font-semibold">{when}</dt>
                <dd>{WHEN_WORDS[when]}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section id="pack-headline" title="The five headline numbers">
          <div className="text-sm">
            {(Object.keys(HEADLINE_WORDS) as (keyof typeof HEADLINE_WORDS)[]).map((key) => {
              const value = pack.headline[key];
              return <Number_ key={key} value={value === null ? "could not be read" : value} words={HEADLINE_WORDS[key]} />;
            })}
          </div>
        </Section>

        <PackSection name="agreements" pack={pack} />
        <PackSection name="vendors" pack={pack} />
      </Group>

      <Group>
        <PackSection name="incidents" pack={pack} />
        <PackSection name="rights" pack={pack} />
      </Group>

      <Group>
        <PackSection name="dataLifecycle" pack={pack} />
        <PackSection name="access" pack={pack} />
        <PackSection name="approvals" pack={pack} />
      </Group>

      <Group>
        <p className="text-muted mt-8 text-sm">{LAUNCH_PROMISES_WORDS}</p>
        <LaunchPromises />
      </Group>
    </main>
  );
}
