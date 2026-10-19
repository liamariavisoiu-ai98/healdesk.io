"use client";

import {
  GUARANTEE_FAILURES,
  GUARANTEE_OUTCOMES,
  PHI_SUBCONTRACTORS,
  PRODUCT_UPDATES,
  SUSPENSION_CAUSES,
  TERMS_CHANGE_TOPICS,
  TERMS_NOTICE_DAYS,
  type GuaranteeFailure,
  type GuaranteeOutcome,
  type PhiSubcontractor,
  type ProductUpdateCode,
  type SuspensionCause,
  type TermsChangeTopic,
} from "@healdesk/catalog";
import { useState, useTransition } from "react";

import type {
  BaaVersionResignOutcome,
  BroadcastOutcome,
  GuaranteeClaimOutcome,
  NoticeState,
  OperatorNoticesView,
  OpsResult,
  SentOutcome,
} from "@/lib/admin/ops-client";

type Actions = {
  sendTermsNotice: (input: {
    version: string;
    effectiveOn: string;
    topics: TermsChangeTopic[];
    isPublished: boolean;
  }) => Promise<OpsResult<BroadcastOutcome>>;
  sendSubprocessorNotice: (input: {
    provider: PhiSubcontractor;
    startsAt: string;
  }) => Promise<OpsResult<BroadcastOutcome>>;
  sendProductUpdate: (code: ProductUpdateCode) => Promise<OpsResult<BroadcastOutcome>>;
  startBaaVersionResigns: () => Promise<OpsResult<BaaVersionResignOutcome>>;
  recordGuaranteeClaim: (
    clinicId: string,
    claimReceivedOn: string,
  ) => Promise<OpsResult<GuaranteeClaimOutcome>>;
  sendGuaranteeFinding: (
    clinicId: string,
    input: {
      claimReceivedOn: string;
      outcome: GuaranteeOutcome;
      refundByOn?: string;
      failure?: GuaranteeFailure;
    },
  ) => Promise<OpsResult<SentOutcome>>;
  suspendForCause: (clinicId: string, cause: SuspensionCause) => Promise<OpsResult<SentOutcome>>;
};

type ClinicChoice = { id: string; name: string };

const KIND_WORDS: Record<string, string> = {
  terms_notice: "Terms notice (L28)",
  subprocessor_notice: "New subcontractor (L29)",
  product_update: "Product update (L33)",
  incident_report: "Incident report (L29)",
  guarantee_claim_received: "Guarantee claim received (L30)",
  guarantee_finding: "Guarantee finding (L30)",
  suspended_for_cause: "Suspended for a legal or security reason (L31)",
};

const STATE_WORDS: Record<NoticeState, string> = {
  sent: "sent",
  switched_off: "switched off",
  not_sent: "not sent",
  dead: "undelivered",
  pending: "queued",
};

const entries = <T extends object>(table: T) =>
  Object.entries(table) as [keyof T & string, T[keyof T]][];

/** A refusal's or a failure's sentence, or null when it went. */
function problemOf(result: OpsResult<{ status: string; message?: string }>): string | null {
  if (!result.ok) return result.message;
  if (result.data.status === "refused") return result.data.message ?? "Refused.";
  return null;
}

function broadcastSaid(result: OpsResult<BroadcastOutcome>): { ok: boolean; text: string } {
  const problem = problemOf(result);
  if (problem || !result.ok || result.data.status !== "queued")
    return { ok: false, text: problem ?? "Refused." };
  const d = result.data;
  return {
    ok: true,
    text:
      `Queued for ${d.queued} practice${d.queued === 1 ? "" : "s"}` +
      (d.alreadyQueued ? `; ${d.alreadyQueued} already had it` : "") +
      (d.noAddress ? `; ${d.noAddress} have no address to send to` : "") +
      (d.failed
        ? `; ${d.failed} FAILED (see the logs, then send again: it reaches only those that missed it)`
        : "") +
      "." +
      (d.auditRecorded ? "" : " It is NOT in the audit log: record it by hand."),
  };
}

/** What the re-sign broadcast did, as a sentence. */
export function resignsSaid(result: OpsResult<BaaVersionResignOutcome>): {
  ok: boolean;
  text: string;
} {
  const problem = problemOf(result);
  if (problem || !result.ok || result.data.status !== "started")
    return { ok: false, text: problem ?? "Refused." };
  const d = result.data;
  const practices = (n: number) => `${n} practice${n === 1 ? "" : "s"}`;
  return {
    ok: true,
    text:
      (d.opened === 0
        ? `No practice on an older version was left to start on v${d.version}`
        : `Started ${practices(d.opened)} on v${d.version}`) +
      (d.opened && d.emailed < d.opened
        ? `; ${d.opened - d.emailed} not emailed yet (the hourly job sends it)`
        : "") +
      (d.alreadyOpen ? `; ${d.alreadyOpen} already had a re-sign open` : "") +
      (d.failed
        ? `; ${d.failed} FAILED (see the logs, then start it again: it reaches only those that missed it)`
        : "") +
      "." +
      (d.auditRecorded ? "" : " It is NOT in the audit log: record it by hand."),
  };
}

export function NoticesBoard({
  record,
  clinics,
  today,
  actions,
}: {
  record: OpsResult<OperatorNoticesView>;
  clinics: ClinicChoice[];
  today: string;
  actions: Actions;
}) {
  return (
    <main className="mx-auto max-w-[1000px] px-5 py-10 sm:px-8">
      <h1 className="font-display text-[28px] font-semibold tracking-[-0.02em]">Notices</h1>
      <p className="text-muted mt-3 max-w-[72ch] text-[15.6px]">
        The emails we send a practice by hand. Each form sends a choice from a fixed list, and the
        email is written from it: nothing typed here reaches a practice. A broadcast goes once per
        practice, so sending it again reaches only the practices that didn&rsquo;t have it. Incident
        reports are sent from{" "}
        <a href="/admin/incidents" className="underline">
          Incidents
        </a>
        .
      </p>

      <Section title="Change to the terms or prices (L28)">
        <TermsForm today={today} send={actions.sendTermsNotice} />
      </Section>
      <Section title="New subcontractor (L29)">
        <SubprocessorForm send={actions.sendSubprocessorNotice} />
      </Section>
      <Section title="Product update (L33)">
        <ProductUpdateForm send={actions.sendProductUpdate} />
      </Section>
      <Section title="Updated agreement to sign (L22)">
        <BaaResignForm start={actions.startBaaVersionResigns} />
      </Section>
      <Section title="First-month guarantee (L30)">
        <GuaranteeForms
          clinics={clinics}
          today={today}
          openClaims={record.ok ? record.data.openClaims : []}
          recordClaim={actions.recordGuaranteeClaim}
          sendFinding={actions.sendGuaranteeFinding}
        />
      </Section>
      <Section title="Suspend for a legal or security reason (L31)">
        <SuspendForm clinics={clinics} suspend={actions.suspendForCause} />
      </Section>

      <Section title="What was sent, the last 180 days">
        {!record.ok ? (
          <p className="text-red-deep text-sm font-semibold">{record.message}</p>
        ) : (
          <Record view={record.data} />
        )}
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-line mt-8 rounded-md border bg-white p-5">
      <h2 className="text-[13.2px] font-bold tracking-[0.06em] uppercase">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Outcome({ said }: { said: { ok: boolean; text: string } | null }) {
  if (!said) return null;
  return <p className={`mt-3 text-xs ${said.ok ? "text-done" : "text-red-deep"}`}>{said.text}</p>;
}

function TermsForm({ today, send }: { today: string; send: Actions["sendTermsNotice"] }) {
  const [pending, start] = useTransition();
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const f = new FormData(event.currentTarget);
        const input = {
          version: String(f.get("version") ?? "").trim(),
          effectiveOn: String(f.get("effectiveOn") ?? ""),
          topics: entries(TERMS_CHANGE_TOPICS)
            .map(([code]) => code)
            .filter((code) => f.get(`topic:${code}`) === "on"),
          isPublished: f.get("isPublished") === "on",
        };
        if (
          !window.confirm("Email this terms notice to every practice with an agreement in effect?")
        )
          return;
        start(async () => setSaid(broadcastSaid(await send(input))));
      }}
      className="grid gap-3 text-sm"
    >
      <p className="text-muted">
        To every practice with an agreement in effect, at least {TERMS_NOTICE_DAYS} days before the
        change applies (Terms §4 and §16). It applies to each practice from its first renewal on or
        after that day, and says how to turn Auto-renew off. It can&rsquo;t be unsubscribed from.
        Publish the new version at healdesk.io/terms first.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="text-muted block text-xs font-bold uppercase">New Terms version</span>
          <input
            name="version"
            required
            placeholder="2026-11-20.1"
            className="border-line mt-1 w-full rounded-sm border px-3 py-2"
          />
        </label>
        <label>
          <span className="text-muted block text-xs font-bold uppercase">Applies from</span>
          <input
            name="effectiveOn"
            type="date"
            required
            min={today}
            className="border-line mt-1 w-full rounded-sm border px-3 py-2"
          />
        </label>
      </div>
      <fieldset>
        <legend className="text-muted text-xs font-bold uppercase">It changes</legend>
        <div className="mt-1 grid gap-1 sm:grid-cols-2">
          {entries(TERMS_CHANGE_TOPICS).map(([code, words]) => (
            <label key={code} className="flex items-start gap-2">
              <input name={`topic:${code}`} type="checkbox" className="mt-1" />
              <span>{words}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-start gap-2">
        <input name="isPublished" type="checkbox" className="mt-1" />
        <span>The new version is published at healdesk.io/terms.</span>
      </label>
      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-black px-4 py-2 text-xs font-bold text-white"
        >
          Send the terms notice
        </button>
      </div>
      <Outcome said={said} />
    </form>
  );
}

function SubprocessorForm({ send }: { send: Actions["sendSubprocessorNotice"] }) {
  const [pending, start] = useTransition();
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const f = new FormData(event.currentTarget);
        const local = String(f.get("startsAt") ?? "");
        const startsAt = local ? new Date(local).toISOString() : "";
        const provider = String(f.get("provider")) as PhiSubcontractor;
        if (
          !window.confirm(
            `Email notice of ${PHI_SUBCONTRACTORS[provider]?.name ?? provider} to every practice with an agreement in effect?`,
          )
        )
          return;
        start(async () => setSaid(broadcastSaid(await send({ provider, startsAt }))));
      }}
      className="grid gap-3 text-sm"
    >
      <p className="text-muted">
        To every practice with an agreement in effect, before the subcontractor starts handling the
        information the agreement protects: at least 24 hours ahead under BAA 1.3.0 on and the DPA,
        fifteen days under the earlier versions. The start is checked against each practice&rsquo;s
        own agreement. The email names the subcontractor, what it will receive and why, keeps the
        right to object, and offers our list on written request. It links to no vendor list. Add a
        subcontractor to the catalog first; this offers only those there.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="text-muted block text-xs font-bold uppercase">Subcontractor</span>
          <select name="provider" className="border-line mt-1 w-full rounded-sm border px-3 py-2">
            {entries(PHI_SUBCONTRACTORS).map(([code, sub]) => (
              <option key={code} value={code}>
                {sub.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-muted block text-xs font-bold uppercase">Starts (your time)</span>
          <input
            name="startsAt"
            type="datetime-local"
            required
            className="border-line mt-1 w-full rounded-sm border px-3 py-2"
          />
        </label>
      </div>
      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-black px-4 py-2 text-xs font-bold text-white"
        >
          Send the notice
        </button>
      </div>
      <Outcome said={said} />
    </form>
  );
}

function ProductUpdateForm({ send }: { send: Actions["sendProductUpdate"] }) {
  const [pending, start] = useTransition();
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const code = String(new FormData(event.currentTarget).get("code")) as ProductUpdateCode;
        if (
          !window.confirm(
            "Email this update to every practice still with us that hasn't switched updates off?",
          )
        )
          return;
        start(async () => setSaid(broadcastSaid(await send(code))));
      }}
      className="grid gap-3 text-sm"
    >
      <p className="text-muted">
        A change to a feature practices already have: never an offer. Each practice can stop these
        with one click, and the switch is honoured when the email goes. The words are the
        catalog&rsquo;s, written with the change.
      </p>
      <label>
        <span className="text-muted block text-xs font-bold uppercase">Update</span>
        <select name="code" className="border-line mt-1 w-full rounded-sm border px-3 py-2">
          {entries(PRODUCT_UPDATES).map(([code, update]) => (
            <option key={code} value={code}>
              {update.label}
            </option>
          ))}
        </select>
      </label>
      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-black px-4 py-2 text-xs font-bold text-white"
        >
          Send the update
        </button>
      </div>
      <Outcome said={said} />
    </form>
  );
}

function BaaResignForm({ start }: { start: Actions["startBaaVersionResigns"] }) {
  const [pending, begin] = useTransition();
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !window.confirm(
            "Open a re-sign for every practice on an older business associate agreement, and email each its link?",
          )
        )
          return;
        begin(async () => setSaid(resignsSaid(await start())));
      }}
      className="grid gap-3 text-sm"
    >
      <p className="text-muted">
        For a release that keeps the older version acceptable for a while: every practice whose
        business associate agreement is older than the current version gets its re-sign and the
        email with its link, then reminders at 3 and 7 days, and we&rsquo;re told at 7. AYA keeps
        answering while it signs, whatever its version: the agreement it signed governs until the
        newer one is. Once a release moves the floor past a version, the hourly job starts those
        practices by itself, and we&rsquo;re told at 7 days to phone each one still unsigned.
      </p>
      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-black px-4 py-2 text-xs font-bold text-white"
        >
          Start the re-signs
        </button>
      </div>
      <Outcome said={said} />
    </form>
  );
}

function ClinicSelect({ clinics }: { clinics: ClinicChoice[] }) {
  return (
    <label>
      <span className="text-muted block text-xs font-bold uppercase">Practice</span>
      <select
        name="clinicId"
        required
        className="border-line mt-1 w-full rounded-sm border px-3 py-2"
      >
        {clinics.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function GuaranteeForms({
  clinics,
  today,
  openClaims,
  recordClaim,
  sendFinding,
}: {
  clinics: ClinicChoice[];
  today: string;
  openClaims: OperatorNoticesView["openClaims"];
  recordClaim: Actions["recordGuaranteeClaim"];
  sendFinding: Actions["sendGuaranteeFinding"];
}) {
  const [pending, start] = useTransition();
  const [claimSaid, setClaimSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [findingSaid, setFindingSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [outcome, setOutcome] = useState<GuaranteeOutcome>("miss_found");
  return (
    <div className="grid gap-6 text-sm">
      <p className="text-muted">
        Terms §5: our finding within 10 business days of a claim, and for a miss the first
        month&rsquo;s subscription fee refunded within 14 days of the finding, saying what failed.
        Commit the refund itself in the practice&rsquo;s Billing (kind: guarantee).
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          const clinicId = String(f.get("clinicId") ?? "");
          const receivedOn = String(f.get("claimReceivedOn") ?? "");
          start(async () => {
            const result = await recordClaim(clinicId, receivedOn);
            const problem = problemOf(result);
            setClaimSaid(
              problem
                ? { ok: false, text: problem }
                : result.ok && result.data.status === "queued"
                  ? {
                      ok: true,
                      text: `Recorded and acknowledged. Our finding is due by ${result.data.findingByOn}.`,
                    }
                  : null,
            );
          });
        }}
        className="grid gap-3"
      >
        <p className="text-xs font-bold uppercase">Claim received</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <ClinicSelect clinics={clinics} />
          <label>
            <span className="text-muted block text-xs font-bold uppercase">
              The claim reached us on
            </span>
            <input
              name="claimReceivedOn"
              type="date"
              required
              max={today}
              defaultValue={today}
              className="border-line mt-1 w-full rounded-sm border px-3 py-2"
            />
          </label>
        </div>
        <div>
          <button
            type="submit"
            disabled={pending}
            className="rounded-full bg-black px-4 py-2 text-xs font-bold text-white"
          >
            Record the claim and acknowledge it
          </button>
        </div>
        <Outcome said={claimSaid} />
      </form>

      <div>
        <p className="text-xs font-bold uppercase">Claims waiting for a finding</p>
        {openClaims.length === 0 ? (
          <p className="text-muted mt-1">None.</p>
        ) : (
          <ul className="mt-2 grid gap-1">
            {openClaims.map((c) => (
              <li
                key={`${c.clinicId}:${c.claimReceivedOn}`}
                className={c.findingByOn < today ? "text-red-deep font-bold" : ""}
              >
                {c.clinicName}: claim of {c.claimReceivedOn}, finding due by {c.findingByOn}
                {c.findingByOn < today ? " — OVERDUE" : ""}
              </li>
            ))}
          </ul>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          const [clinicId, claimReceivedOn] = String(f.get("claim") ?? "|").split("|");
          const refundByOn = String(f.get("refundByOn") ?? "");
          const failure = String(f.get("failure") ?? "") as GuaranteeFailure | "";
          if (!window.confirm("Email this finding to the practice?")) return;
          start(async () => {
            const result = await sendFinding(clinicId ?? "", {
              claimReceivedOn: claimReceivedOn ?? "",
              outcome,
              ...(outcome === "miss_found" && refundByOn ? { refundByOn } : {}),
              ...(outcome === "miss_found" && failure ? { failure } : {}),
            });
            const problem = problemOf(result);
            setFindingSaid(
              problem
                ? { ok: false, text: problem }
                : { ok: true, text: "The finding is queued for the practice." },
            );
          });
        }}
        className="grid gap-3"
      >
        <p className="text-xs font-bold uppercase">Our finding</p>
        <label>
          <span className="text-muted block text-xs font-bold uppercase">Claim</span>
          <select
            name="claim"
            required
            className="border-line mt-1 w-full rounded-sm border px-3 py-2"
          >
            {openClaims.map((c) => (
              <option
                key={`${c.clinicId}:${c.claimReceivedOn}`}
                value={`${c.clinicId}|${c.claimReceivedOn}`}
              >
                {c.clinicName}: claim of {c.claimReceivedOn}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className="text-muted text-xs font-bold uppercase">Finding</legend>
          <div className="mt-1 flex flex-wrap gap-4">
            {entries(GUARANTEE_OUTCOMES).map(([code, words]) => (
              <label key={code} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="outcome"
                  checked={outcome === code}
                  onChange={() => setOutcome(code)}
                />
                <span>{words}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {outcome === "miss_found" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className="text-muted block text-xs font-bold uppercase">What failed</span>
              <select
                name="failure"
                className="border-line mt-1 w-full rounded-sm border px-3 py-2"
              >
                {entries(GUARANTEE_FAILURES).map(([code, words]) => (
                  <option key={code} value={code}>
                    {words}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="text-muted block text-xs font-bold uppercase">Refunded by</span>
              <input
                name="refundByOn"
                type="date"
                required
                min={today}
                className="border-line mt-1 w-full rounded-sm border px-3 py-2"
              />
            </label>
          </div>
        ) : null}
        <div>
          <button
            type="submit"
            disabled={pending || openClaims.length === 0}
            className="rounded-full bg-black px-4 py-2 text-xs font-bold text-white"
          >
            Send the finding
          </button>
        </div>
        <Outcome said={findingSaid} />
      </form>
    </div>
  );
}

function SuspendForm({
  clinics,
  suspend,
}: {
  clinics: ClinicChoice[];
  suspend: Actions["suspendForCause"];
}) {
  const [pending, start] = useTransition();
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const f = new FormData(event.currentTarget);
        const clinicId = String(f.get("clinicId") ?? "");
        const cause = String(f.get("cause")) as SuspensionCause;
        const name = clinics.find((c) => c.id === clinicId)?.name ?? "this practice";
        if (
          !window.confirm(
            `Suspend ${name} now? AYA stops answering on every channel, and the practice is emailed why.`,
          )
        )
          return;
        start(async () => {
          const result = await suspend(clinicId, cause);
          const problem = problemOf(result);
          setSaid(
            problem
              ? { ok: false, text: problem }
              : {
                  ok: true,
                  text: `Suspended, and the email is going. Lift it from the practice's Billing once it's dealt with.`,
                },
          );
        });
      }}
      className="grid gap-3 text-sm"
    >
      <p className="text-muted">
        Terms §15: we may suspend at once if a practice&rsquo;s use creates a legal or security
        risk, telling it why. AYA stops answering, calls pass through to the practice&rsquo;s direct
        line, chat becomes a contact form, and paying an invoice doesn&rsquo;t lift it: an operator
        does, from Billing.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <ClinicSelect clinics={clinics} />
        <label>
          <span className="text-muted block text-xs font-bold uppercase">Why</span>
          <select name="cause" className="border-line mt-1 w-full rounded-sm border px-3 py-2">
            {entries(SUSPENSION_CAUSES).map(([code, cause]) => (
              <option key={code} value={code}>
                {cause.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div>
        <button
          type="submit"
          disabled={pending}
          className="bg-red-deep rounded-full px-4 py-2 text-xs font-bold text-white"
        >
          Suspend and email why
        </button>
      </div>
      <Outcome said={said} />
    </form>
  );
}

function Record({ view }: { view: OperatorNoticesView }) {
  return (
    <div className="grid gap-6 text-sm">
      <div>
        <p className="text-xs font-bold uppercase">Broadcasts</p>
        {view.broadcasts.length === 0 ? (
          <p className="text-muted mt-1">None.</p>
        ) : (
          <ul className="mt-2 grid gap-1">
            {view.broadcasts.map((b) => (
              <li key={`${b.kind}:${b.subject}`}>
                <span className="font-semibold">{KIND_WORDS[b.kind] ?? b.kind}</span> · {b.subject}{" "}
                · first queued {b.firstQueuedAt} ·{" "}
                {(Object.entries(b.counts) as [NoticeState, number][])
                  .filter(([, n]) => n > 0)
                  .map(([state, n]) => `${n} ${STATE_WORDS[state]}`)
                  .join(", ")}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="text-xs font-bold uppercase">To one practice</p>
        {view.notices.length === 0 ? (
          <p className="text-muted mt-1">None.</p>
        ) : (
          <ul className="mt-2 grid gap-1">
            {view.notices.map((n) => (
              <li
                key={`${n.clinicId}:${n.kind}:${n.subject}`}
                className={n.state === "dead" ? "text-red-deep font-bold" : ""}
              >
                {n.queuedAt} · {n.clinicName} · {KIND_WORDS[n.kind] ?? n.kind} · {n.subject} ·{" "}
                {STATE_WORDS[n.state]}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
