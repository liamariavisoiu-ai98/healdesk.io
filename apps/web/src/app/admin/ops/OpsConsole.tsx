"use client";

import { useState, useTransition } from "react";

import { FirstWeeks } from "./FirstWeeks";

import type {
  CareOutcome,
  ClinicCards,
  ClinicCardView,
  ClinicHealth,
  ConnectionState,
  ConnectLinkDelivery,
  IssueLinkOutcome,
  OpsClinic,
  OpsClinics,
  OpsFailure,
  OpsJob,
  OpsResult,
  ToggleJobOutcome,
} from "@/lib/admin/ops-client";

/**
 * The ops console, relocated to healdesk.io/admin.
 *
 * This is the screen that used to live in apps/app at `(console)/`. Everything
 * it showed about clinics and scheduled jobs, it still shows, and everything it
 * explained in words on screen it still explains: the words were the point.
 * What changed underneath is that apps/web cannot reach a database, so each
 * section is handed a result that may have failed on its own, and each renders
 * that failure in place instead of taking the page down with it. A clinic list
 * that could not be read must not hide the job kill switch, which is the
 * control someone reaches for when things are going wrong.
 *
 * The one thing deliberately not carried across is team management. Staff
 * invitations were removed with the clinic console: there is one administrator
 * and no user store to add anybody to, so an invite form here would be a
 * control that creates accounts for a product with no other account holders.
 *
 * ## Why a client component, when most of this is text
 *
 * Both controls return something the operator has to read and that a plain
 * `<form action={...}>` throws away: the one-time connection URL, a mailer's
 * reason for not sending, and whether the audit row was written. That was true
 * in apps/app and it is more true here, because a call can now also time out
 * halfway, and "it may have gone through" is a sentence somebody has to see.
 *
 * ## What is lost by that, stated rather than glossed
 *
 * The old console toggled a job with a real `<form action={toggleJob}>`, which
 * worked with JavaScript disabled. These buttons do not. The trade is
 * deliberate: a form post cannot show why the toggle failed, and the toggle now
 * crosses a network that can refuse, time out, or answer ambiguously. An
 * operator who presses "Turn off" on a job that mails customers is owed an
 * answer, and a silent success page is not one.
 */

export type OpsConsoleActions = {
  toggleJob: (
    name: string,
    enabled: boolean,
  ) => Promise<OpsResult<ToggleJobOutcome>>;
  issueConnectLink: (
    clinicId: string,
    recipientEmail: string | null,
  ) => Promise<OpsResult<IssueLinkOutcome>>;
  recordTouch: (
    clinicId: string,
    input: { kind: "call" | "email" | "note"; summary: string; outcome?: string },
  ) => Promise<OpsResult<CareOutcome>>;
};

export function OpsConsole({
  clinics,
  jobs,
  health,
  cards,
  actions,
}: {
  clinics: OpsResult<OpsClinics>;
  jobs: OpsResult<OpsJob[]>;
  health: OpsResult<ClinicHealth[]>;
  /**
   * Each card's channel states, build tracker and agreement label
   * (listClinicCards), read on its own: a card it could not read shows the
   * rest of the card without them.
   */
  cards?: OpsResult<ClinicCards>;
  actions: OpsConsoleActions;
}) {
  /**
   * Only counted when the list was actually read.
   *
   * A failed read is not "zero blocked clinics". The banner is absent in that
   * case and the section below says why, which is the same reason the changes
   * dashboard draws dashes rather than zeros when it could not measure.
   */
  const blocked = clinics.ok
    ? clinics.data.clinics.filter((clinic) =>
        clinic.blockers.some((blocker) => blocker.level === "blocked"),
      )
    : [];

  return (
    <main className="mx-auto w-full max-w-[1000px] px-5 py-12 sm:px-8 lg:px-14">
      <h1 className="font-display text-[clamp(31.2px,4.32vw,40.8px)] leading-tight font-medium tracking-[-0.024em]">
        Ops.
      </h1>
      <p className="text-muted mt-3 max-w-[62ch] text-[18px]">
        Clinic configuration, the scheduled-job switches and connection links.
        Signed agreements have their own register under Agreements.
      </p>

      {blocked.length > 0 ? (
        <p className="border-red/30 bg-red/[0.06] mt-6 rounded-sm border px-4 py-3 text-sm font-semibold">
          {blocked.length} {blocked.length === 1 ? "clinic is" : "clinics are"}{" "}
          blocked from handling patient data. See below.
        </p>
      ) : null}

      <FirstWeeks health={health} onTouch={actions.recordTouch} />
      <JobsSection jobs={jobs} onToggle={actions.toggleJob} />
      <ClinicsSection clinics={clinics} cards={cards} onIssue={actions.issueConnectLink} />
    </main>
  );
}

// -----------------------------------------------------------------------------
// Scheduled jobs
// -----------------------------------------------------------------------------

function JobsSection({
  jobs,
  onToggle,
}: {
  jobs: OpsResult<OpsJob[]>;
  onToggle: OpsConsoleActions["toggleJob"];
}) {
  return (
    <section className="mt-12">
      <SectionHeading>Scheduled jobs</SectionHeading>
      <p className="text-muted mt-2 max-w-[62ch] text-sm">
        Everything here is off until someone turns it on. Leave them off until
        there are real tenants: a report job running against an empty or
        half-configured estate either does nothing or does something
        embarrassing. Jobs marked phase two (the monthly revenue report and
        the nightly booking-system sync) are attribution, which v1 does not
        offer; they cannot be switched on here.
      </p>

      {!jobs.ok ? (
        <Failure failure={jobs} what="the scheduled jobs" />
      ) : jobs.data.length === 0 ? (
        <Empty>
          No scheduled jobs are registered. That is a deployment fact rather
          than a setting, so there is nothing to switch here.
        </Empty>
      ) : (
        <div className="mt-5 grid gap-3">
          {jobs.data.map((job) => (
            <JobCard key={job.name} job={job} onToggle={onToggle} />
          ))}
        </div>
      )}
    </section>
  );
}

function JobCard({
  job,
  onToggle,
}: {
  job: OpsJob;
  onToggle: OpsConsoleActions["toggleJob"];
}) {
  const [note, setNote] = useState<{ tone: "bad" | "warn"; text: string } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  return (
    <div className="border-line rounded-md border bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <span
              aria-hidden
              className={[
                "size-2 shrink-0 rounded-full",
                job.enabled ? "bg-red" : "bg-line-strong",
              ].join(" ")}
            />
            <span className="font-semibold">{job.name}</span>
            <Tag tone={job.enabled ? "warn" : "muted"}>
              {job.enabled ? "On" : "Off"}
            </Tag>
            {job.runningSince ? <Tag tone="warn">running</Tag> : null}
            {job.phaseTwo ? <Tag tone="muted">phase two</Tag> : null}
          </div>
          <p className="text-muted mt-1.5 text-sm">{job.cadence}</p>
        </div>

        <button
          type="button"
          // A phase-two job can be switched off, never on: the ops API
          // refuses, and the button does not offer what will be refused.
          disabled={pending || (job.phaseTwo && !job.enabled)}
          onClick={() => {
            setNote(null);
            startTransition(async () => {
              const result = await onToggle(job.name, !job.enabled);
              if (!result.ok) {
                setNote({ tone: "bad", text: result.message });
                return;
              }
              if (result.data.status === "refused") {
                setNote({ tone: "bad", text: result.data.message });
                return;
              }
              if (!result.data.auditRecorded) {
                // The switch moved and the security log does not know. An
                // unrecorded act that looks recorded is the failure an audit
                // trail exists to prevent, so it is said out loud here.
                setNote({
                  tone: "warn",
                  text: "Done, but the audit entry could not be written. Tell whoever keeps the security log.",
                });
              }
            });
          }}
          className={[
            "shrink-0 rounded-full px-5 py-2.5 text-sm font-bold transition-colors disabled:opacity-50",
            job.enabled
              ? "border-line-strong hover:border-ink border"
              : "bg-ink text-white",
          ].join(" ")}
        >
          {pending ? "Working…" : job.enabled ? "Turn off" : job.phaseTwo ? "Phase two" : "Turn on"}
        </button>
      </div>

      <dl className="border-line mt-4 grid gap-1.5 border-t pt-4 text-sm">
        <Row label="Last run">{job.lastRunAt ?? "Never"}</Row>
        {job.lastRunStatus ? (
          <Row label="Result">
            {job.lastRunStatus}
            {job.lastRunNote ? `: ${job.lastRunNote}` : ""}
          </Row>
        ) : null}
        {job.runningSince ? (
          /* Turning a job off does not stop the run that is already in flight.
             Saying when it started is the only thing this screen can honestly
             offer about that. */
          <Row label="Running since">{job.runningSince}</Row>
        ) : null}
      </dl>

      {note ? (
        <p
          role="status"
          className={[
            "mt-3 text-sm font-semibold",
            note.tone === "bad" ? "text-red-deep" : "text-ink",
          ].join(" ")}
        >
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Clinics
// -----------------------------------------------------------------------------

function ClinicsSection({
  clinics,
  cards,
  onIssue,
}: {
  clinics: OpsResult<OpsClinics>;
  cards?: OpsResult<ClinicCards>;
  onIssue: OpsConsoleActions["issueConnectLink"];
}) {
  const rows = clinics.ok ? clinics.data.clinics : [];
  const cardById = new Map((cards?.ok ? cards.data.cards : []).map((card) => [card.id, card]));
  const needsLink = rows.filter((clinic) => clinic.connection === "none");
  const unchecked = rows.filter((clinic) => clinic.connection === "unknown");

  return (
    <section className="mt-14">
      <SectionHeading>
        Clinics{clinics.ok ? ` (${rows.length})` : ""}
      </SectionHeading>

      {!clinics.ok ? (
        <Failure failure={clinics} what="the clinic list" />
      ) : (
        <>
          {needsLink.length > 0 ? (
            /* Phase two: the read-back credential only matters once
               attribution is switched on, and v1 does not offer it. */
            <p className="text-muted mt-3 max-w-[62ch] text-sm">
              Phase two: {needsLink.length}{" "}
              {needsLink.length === 1 ? "clinic has" : "clinics have"} neither a
              stored read-back credential nor an outstanding connect link. That
              matters only once attribution read-back is switched on; v1 reports
              no revenue and reads nothing back from a booking system.
            </p>
          ) : null}

          {unchecked.length > 0 ? (
            /* The cap is upstream and costs one transaction per clinic. What
               matters on this screen is that "not checked" is not "not
               connected": issuing a second credential for a clinic that already
               has one is the mistake a guess here would cause. */
            <p className="text-muted mt-2 max-w-[62ch] text-sm">
              Connection state was read for the {clinics.data.connectionStateLimit}{" "}
              most recent clinics. The other {unchecked.length} are marked not
              checked, which is not the same as having no connection.
            </p>
          ) : null}

          {rows.length === 0 ? (
            <Empty>
              No clinics yet. They appear here once someone completes checkout.
            </Empty>
          ) : (
            <ul className="mt-4 grid gap-3">
              {rows.map((clinic) => (
                <li key={clinic.id}>
                  <ClinicCard clinic={clinic} card={cardById.get(clinic.id)} onIssue={onIssue} />
                </li>
              ))}
            </ul>
          )}

          <p className="text-muted mt-3 max-w-[62ch] text-xs">
            Configuration only. This is our operator console, and nothing here
            renders one clinic&rsquo;s patient-level data on a page. Clinics
            see their own conversations and bookings in the clinic portal on
            the PHI side, behind a second factor (v1, not built yet). The
            connect link is phase two: one page, once, for a clinic to hand
            over a read-only credential, and it shows them nothing
            patient-level either.
          </p>
        </>
      )}
    </section>
  );
}

function ClinicCard({
  clinic,
  card,
  onIssue,
}: {
  clinic: OpsClinic;
  card?: ClinicCardView;
  onIssue: OpsConsoleActions["issueConnectLink"];
}) {
  const worst = clinic.blockers.find((blocker) => blocker.level === "blocked");
  const first = clinic.blockers[0];

  return (
    /* A div, not a link. There is no per-clinic patient-level page to open
       here: this console renders configuration only. */
    <div className="border-line rounded-md border bg-white p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{clinic.name}</span>
        <Tag>{clinic.specialty}</Tag>
        <Tag tone={clinic.dataClassification === "production" ? "ok" : "muted"}>
          {clinic.dataClassification}
        </Tag>
        <Tag
          tone={
            clinic.isCoveredEntity === null
              ? "warn"
              : clinic.isCoveredEntity
                ? "ok"
                : "muted"
          }
        >
          {clinic.isCoveredEntity === null
            ? "CE unknown"
            : clinic.isCoveredEntity
              ? "covered entity"
              : "not a CE"}
        </Tag>
        <Tag tone={clinic.baaSignedOn ? "ok" : "muted"}>
          {clinic.baaSignedOn ? `BAA ${clinic.baaSignedOn}` : "no BAA"}
        </Tag>
        {/* Phase two: v1 reports no revenue, estimated or verified. */}
        <Tag tone="muted">{`attribution ${clinic.attributionMode} (phase two)`}</Tag>
        <ConnectionTag state={clinic.connection} />
        <span className="text-muted ml-auto text-sm">{clinic.timezone}</span>
      </div>

      {worst ? (
        <p className="text-red-deep mt-3 text-sm font-semibold">{worst.message}</p>
      ) : first ? (
        <p className="text-muted mt-3 text-sm">{first.message}</p>
      ) : null}

      {card ? <CardState card={card} /> : null}

      <a
        href={`/admin/ops/${clinic.id}/onboarding`}
        className="mt-3 inline-block text-sm font-semibold underline underline-offset-2"
      >
        Onboarding checklist, phone, script, go-live →
      </a>
      <a
        href={`/admin/ops/${clinic.id}/care`}
        className="mt-1 ml-4 inline-block text-sm font-semibold underline underline-offset-2"
      >
        Report recipients, deliveries, incidents, offboarding →
      </a>
      <a
        href={`/admin/ops/${clinic.id}/transcripts`}
        className="mt-1 ml-4 inline-block text-sm font-semibold underline underline-offset-2"
      >
        Transcript deliveries →
      </a>
      <a
        href={`/admin/ops/${clinic.id}/account`}
        className="mt-1 ml-4 inline-block text-sm font-semibold underline underline-offset-2"
      >
        Address, covered entity →
      </a>

      <ConnectLinkControl clinic={clinic} onIssue={onIssue} />
    </div>
  );
}

/** The channel names the portal uses (the catalog's CHANNEL_NAMES), kept here for a client bundle. */
const CHANNEL_LABELS: Record<ClinicCardView["channels"][number]["channel"], string> = {
  web: "Website chat",
  meta: "Instagram, Messenger & WhatsApp",
  voice: "Phone",
};

const CHANNEL_STATUS_WORDS: Record<ClinicCardView["channels"][number]["status"], string> = {
  off: "off",
  paused: "paused",
  live: "live",
  waiting: "waiting on the clinic",
  setting_up: "setting up",
};

/**
 * What listClinicCards adds to a card: the agreement it is under, where each
 * bought channel stands, and the build tracker the clinic sees on Home, by
 * stage and state only.
 */
function CardState({ card }: { card: ClinicCardView }) {
  return (
    <div className="border-line mt-3 grid gap-1.5 border-t pt-3 text-sm">
      <p>
        <Tag tone={card.agreementKind ? "ok" : "warn"}>{card.agreementLabel}</Tag>
      </p>
      <p className="text-muted">
        {card.channels.length === 0
          ? "No channels bought."
          : card.channels
              .map((c) => `${CHANNEL_LABELS[c.channel]}: ${CHANNEL_STATUS_WORDS[c.status]}`)
              .join(" · ")}
      </p>
      <p className="text-muted">
        Build:{" "}
        {card.tracker
          .map((s) => `${s.state === "done" ? "✓" : s.state === "info" ? "–" : "·"} ${s.label}`)
          .join("  ")}
      </p>
      {card.trackerLeft.length > 0 ? (
        <p className="text-muted">Still to do: {card.trackerLeft.join(", ")}.</p>
      ) : null}
    </div>
  );
}

function ConnectionTag({ state }: { state: ConnectionState }) {
  switch (state) {
    case "connected":
      return <Tag tone="ok">connected</Tag>;
    case "outstanding":
      return <Tag>link outstanding</Tag>;
    case "none":
      return <Tag tone="warn">no connection</Tag>;
    case "unknown":
      return <Tag>not checked</Tag>;
  }
}

/**
 * The one-time connection link, issued from the clinic card.
 *
 * ## Why the token is never round-tripped
 *
 * The obvious implementations all persist it somewhere: a redirect with the
 * token in the query string (browser history, `Referer`, every access log in
 * the path), a flash cookie (a live credential at rest in the operator's cookie
 * jar, re-sent on every subsequent request to this origin), or a "show me that
 * link again" lookup, which requires having stored the token, which is the one
 * thing the issuing library exists not to do.
 *
 * So it lives in this component's state and nowhere else. Closing the panel
 * drops it, and it is then unrecoverable by anyone including us, which is why
 * the panel says so before the operator can close it.
 *
 * ## Why it never says "sent"
 *
 * The panel reports exactly what the mailer came back with. An operator who is
 * told the mail went out, and finds later that it did not, has already closed
 * the only copy of the link.
 */
function ConnectLinkControl({
  clinic,
  onIssue,
}: {
  clinic: OpsClinic;
  onIssue: OpsConsoleActions["issueConnectLink"];
}) {
  const [issued, setIssued] = useState<
    Extract<IssueLinkOutcome, { status: "issued" }> | null
  >(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (issued) {
    return <IssuedPanel issued={issued} onDismiss={() => setIssued(null)} />;
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;

        const to = String(
          new FormData(event.currentTarget).get("to") ?? "",
        ).trim();
        setProblem(null);

        startTransition(async () => {
          const result = await onIssue(clinic.id, to === "" ? null : to);

          if (!result.ok) {
            setProblem(result.message);
            return;
          }
          if (result.data.status === "refused") {
            setProblem(result.data.message);
            return;
          }
          setIssued(result.data);
        });
      }}
      className="border-line mt-4 flex flex-wrap items-end gap-3 border-t pt-4"
    >
      <label className="min-w-[220px] flex-1">
        <span className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">
          Email it to (optional)
        </span>
        <input
          name="to"
          type="email"
          autoComplete="off"
          placeholder="frontdesk@clinic.com"
          className="border-line focus:border-orange mt-1.5 w-full rounded-sm border bg-white px-3 py-2.5 text-sm"
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="bg-ink rounded-full px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
      >
        {pending
          ? "Issuing…"
          : clinic.connection === "none" || clinic.connection === "unknown"
            ? "Issue connect link"
            : "Issue another link"}
      </button>

      {clinic.connection === "outstanding" ? (
        /* The issuing library leaves existing unused links alone on purpose:
           superseding one would kill a link a clinic may have open mid-wizard.
           Which means issuing again really does leave two live credentials, and
           saying so is the only thing this control can honestly do about it. */
        <p className="text-muted w-full text-xs">
          This clinic already has an unused link. Issuing another leaves both
          live until they are used or expire.
        </p>
      ) : null}

      <div className="w-full">
        <Problem message={problem} />
      </div>
    </form>
  );
}

function IssuedPanel({
  issued,
  onDismiss,
}: {
  issued: Extract<IssueLinkOutcome, { status: "issued" }>;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="border-orange/40 bg-orange/[0.06] mt-4 rounded-sm border p-4">
      <p className="text-sm font-bold">
        Copy this now, it cannot be shown again.
      </p>
      <p className="text-muted mt-1 text-sm">
        We store a hash of this link, not the link. Nobody, us included, can
        retrieve it once this panel is closed. If it is lost, issue another.
      </p>

      <div className="border-line mt-3 flex items-start gap-2 rounded-sm border bg-white px-3 py-2">
        {/* Selectable and wrapped rather than truncated: the clipboard API is
            absent on insecure origins, and this is the last chance to read it. */}
        <code className="min-w-0 flex-1 text-xs break-all select-all">
          {issued.url}
        </code>
        <button
          type="button"
          onClick={() => {
            // Only claim "Copied" if it actually copied. A button that lies
            // here leaves an operator pasting whatever they had before.
            navigator.clipboard
              ?.writeText(issued.url)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1_500);
              })
              .catch(() => undefined);
          }}
          className="bg-ink shrink-0 rounded-full px-3 py-1.5 text-xs font-bold text-white"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <p className="mt-3 text-sm">
        Works once. Expires{" "}
        <span className="font-semibold">{issued.expiresAt}</span>.
      </p>

      <p className="text-muted mt-1 text-sm">
        <DeliveryNote delivery={issued.delivery} />
      </p>

      {!issued.auditRecorded ? (
        <p className="text-red-deep mt-1 text-sm font-semibold">
          This issuance could not be written to the security log. The link is
          live regardless. Tell whoever keeps that log.
        </p>
      ) : null}

      <button
        type="button"
        onClick={onDismiss}
        className="border-line-strong hover:border-ink mt-3 rounded-full border px-4 py-2 text-sm font-bold transition-colors"
      >
        I&rsquo;ve copied it. Discard.
      </button>
    </div>
  );
}

function DeliveryNote({ delivery }: { delivery: ConnectLinkDelivery }) {
  if (!delivery.attempted) {
    return <>No email address given, so nothing was sent. Send it yourself.</>;
  }
  if (delivery.status === "sent") {
    return <>Emailed to the address you gave.</>;
  }
  return (
    <>
      Not emailed ({delivery.status}): {delivery.reason} Send it yourself.
    </>
  );
}

// -----------------------------------------------------------------------------
// Shared pieces
// -----------------------------------------------------------------------------

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
      {children}
    </h2>
  );
}

/**
 * A section that could not be read.
 *
 * Says which section, and says the sentence `ops-client` wrote, which is never
 * an upstream error body. `unauthenticated` gets a link rather than a retry,
 * because the operator's next move is a door.
 */
function Failure({ failure, what }: { failure: OpsFailure; what: string }) {
  return (
    <div
      role="status"
      className="border-red/30 bg-red/[0.06] mt-4 rounded-md border p-5"
    >
      <p className="text-sm font-bold">Could not load {what}.</p>
      <p className="mt-1 max-w-[62ch] text-sm">{failure.message}</p>
      {failure.code === "unauthenticated" ? (
        <a
          href="/admin/sign-in"
          className="border-line-strong hover:border-ink mt-3 inline-block rounded-full border px-4 py-2 text-sm font-bold transition-colors"
        >
          Sign in
        </a>
      ) : null}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-line text-muted mt-4 rounded-md border bg-white p-5 text-sm">
      {children}
    </p>
  );
}

function Problem({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="status" className="text-red-deep mt-3 text-sm font-semibold">
      {message}
    </p>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

function Tag({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "ok" | "warn";
}) {
  const tones = {
    muted: "bg-paper-2 text-muted",
    ok: "bg-ink/[0.06] text-ink",
    warn: "bg-red/10 text-red-deep",
  };

  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[13.2px] font-bold tracking-[0.06em] uppercase ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
