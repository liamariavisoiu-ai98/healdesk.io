"use client";

import { useState, useTransition } from "react";

import {
  AGREEMENT_TERMINATION_REASON_COPY,
  AGREEMENT_TERMINATION_REASONS,
  isAgreementTerminationReason,
  type AgreementTerminationReason,
} from "@healdesk/catalog";

import type {
  AgreementQuery,
  AgreementRetention,
  OpsAgreement,
  OpsAgreements,
  OpsFailure,
  OpsResult,
  ResendOutcome,
  TerminateOutcome,
} from "@/lib/admin/ops-client";

/**
 * The register of signed business associate agreements.
 *
 * Two questions this answers that nothing else can:
 *
 *   1. **Does the other party have their copy?** A BAA binds two parties, and
 *      until the copy is sent only one of them can produce it. `copy_sent_at`
 *      is the answer, and "no" is the state that needs a button next to it, so
 *      it gets one.
 *   2. **How long must this record be kept?** 45 CFR 164.530(j)(2) requires six
 *      years "from the date of its creation or the date when it last was in
 *      effect, whichever is later". For an agreement, "last in effect" is
 *      termination. So the clock starts at termination, not at signature, and a
 *      clinic that stays three years is a record we hold for nine.
 *
 * ## The number this screen refuses to show
 *
 * A live agreement gets no purge date. `retention_eligible_at` is NOT NULL
 * upstream, so every row has one to print, signature plus six years while the
 * end date is unknown, and printing it is the single most common way this rule
 * is got wrong. The date looks real, it arrives years before the true one, and
 * once a screen shows it somebody eventually acts on it and destroys a contract
 * that is still in force. While an agreement is in effect its floor is not
 * merely unknown, it is unreachable: six years from whenever it ends is always
 * further away than today. So a live row says there is no date yet, which is
 * true, and signature plus six years, which is not, appears nowhere.
 *
 * ## Why nothing here deletes
 *
 * Six years is a floor, not a target, and the runtime role has no DELETE on
 * that table at all. Purging is a deliberate act by a human with the migrator
 * role. This register's job is to say when a row becomes eligible and then get
 * out of the way.
 *
 * ## Why the filter row is a plain GET form
 *
 * The search runs in apps/app, over the whole table, so the filters have to
 * reach the server. Putting them in the URL rather than in component state
 * means submitting is a navigation: no fetch to write, no loading flag to keep
 * in sync, a result that can be bookmarked or pasted into a ticket, and a form
 * that still works if the JavaScript on this page fails to load. The rest of
 * this component is client-side because the row actions genuinely need to be:
 * each returns something the operator has to read, and a form post throws that
 * away.
 *
 * ## Why the state lives per row
 *
 * Each row can have a resend in flight, a termination half-confirmed, a
 * fingerprint revealed and a download running, and none of that should be
 * disturbed by what another row is doing. One `useTransition` per row is what
 * keeps a spinner on the button that was pressed.
 */

export type MintDownloadResult = { ok: true } | { ok: false; message: string };

export type RegisterActions = {
  resendCopy: (agreementId: string) => Promise<OpsResult<ResendOutcome>>;
  markTerminated: (
    agreementId: string,
    terminationDate: string,
    terminationReason: AgreementTerminationReason,
  ) => Promise<OpsResult<TerminateOutcome>>;
  /**
   * Authorise this browser for one agreement's PDF, then let the browser fetch
   * it from the existing cookie-gated route. See the note on the action itself.
   */
  mintDownload: (agreementId: string) => Promise<MintDownloadResult>;
};

/** Where the filter form posts, and where every link back to this page points. */
const REGISTER_PATH = "/admin/agreements";

/**
 * This browser's own deadline for the PDF.
 *
 * `/api/agreement/pdf` gives up on apps/app after eight seconds precisely so a
 * slow renderer degrades instead of hanging, and that promise ends at our own
 * server. The hop from here to it has no such budget, and a fetch with nothing
 * to time it out leaves a button reading "Preparing…" for as long as the
 * operator is willing to look at it.
 */
const PDF_TIMEOUT_MS = 15_000;

/** Used when the route sends no usable filename. Names the document, nothing else. */
const FALLBACK_FILENAME = "healdesk-baa.pdf";

/** How much of the fingerprint is shown before it is asked for in full. */
const HASH_PREFIX = 16;

/**
 * Said whenever an act happened and the record of it did not.
 *
 * The ops API reports that rather than assuming it, and a screen that quietly
 * drops the report is the exact failure an audit trail exists to prevent: an
 * unrecorded act that looks recorded. So it goes in the same sentence as the
 * confirmation, not somewhere the operator would have to go looking.
 */
const UNAUDITED =
  "The audit entry could not be written. Tell whoever keeps the security log.";

export function AgreementsRegister({
  register,
  filters,
  actions,
}: {
  register: OpsAgreements;
  filters: AgreementQuery;
  actions: RegisterActions;
}) {
  const listed = register.rows.length;
  const filtered = Object.keys(filters).length > 0;

  /**
   * Both dates present and the later one first. String comparison is exact for
   * YYYY-MM-DD, and both have already been checked as real UTC days by the page
   * before they got here.
   */
  const invertedRange =
    filters.signedFrom !== undefined &&
    filters.signedTo !== undefined &&
    filters.signedFrom > filters.signedTo;

  /**
   * Counted over what is on this page, and worded to say so.
   *
   * The console this replaces counted over everything it had loaded and called
   * that a fact about the estate. It cannot be one here: the rows below are the
   * ones that matched, so any count taken from them describes the search. The
   * link beside it is what turns the observation into the real number, because
   * `copy=missing` asks apps/app rather than this array.
   */
  const withoutCopy = register.rows.filter(
    (row) => row.copySentOn === null,
  ).length;

  return (
    <section className="mt-8">
      <FilterRow filters={filters} today={register.today} rows={register.rows} />

      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-muted text-xs">
          {register.truncated
            ? `Showing the ${listed} most recent of ${register.total} matching. The rest are not on this page: narrow the filters to reach them.`
            : /* The verb agrees as well as the noun. "1 agreement match these
                 filters" is what a search for one clinic returns, which is the
                 single most common thing anyone does on this page. */
              `${register.total} ${register.total === 1 ? "agreement" : "agreements"} ${
                filtered
                  ? register.total === 1
                    ? "matches these filters"
                    : "match these filters"
                  : "in the register"
              }.`}
        </p>

        {filtered ? (
          <a
            href={REGISTER_PATH}
            className="text-ink text-xs font-semibold underline"
          >
            Clear the filters
          </a>
        ) : null}
      </div>

      {withoutCopy > 0 ? (
        <p className="text-red-deep mt-2 max-w-[68ch] text-sm font-semibold">
          {/* "1 of the 1 agreements below has" is what the old wording produced
              on a one-row search. Both halves are counted, so both are said
              once when they are the same number. */}
          {withoutCopy === listed
            ? listed === 1
              ? "The agreement below has"
              : `All ${listed} agreements below have`
            : `${withoutCopy} of the ${listed} agreements below ${withoutCopy === 1 ? "has" : "have"}`}{" "}
          no copy on file. Until a copy is sent, the signer cannot produce the
          agreement they signed. Resend it from the row.{" "}
          {filters.copySent === false ? null : (
            <a
              href={`${REGISTER_PATH}?copy=missing`}
              className="text-ink underline"
            >
              Show every one of them
            </a>
          )}
        </p>
      ) : null}

      {register.rows.length === 0 ? (
        filtered ? (
          <EmptyPanel>
            {/* An inverted range selects nothing, and "nothing" here reads as
                "this practice never signed", the exact wrong conclusion this
                register exists to prevent. The filters are two boxes side by
                side and they get filled in the wrong order; say so rather than
                let the operator take an empty table as an answer. */}
            {invertedRange ? (
              <>
                <span className="text-red-deep font-semibold">
                  The dates are the wrong way round.
                </span>{" "}
                Nothing was signed after {filters.signedFrom} and before{" "}
                {filters.signedTo}, so this empty table is about the filter and
                not about the register. Swap them.{" "}
              </>
            ) : (
              <>
                No agreement matches these filters. That is an answer about the
                whole register and not about one page of it, because the search
                runs against the table.{" "}
              </>
            )}
            <a
              href={REGISTER_PATH}
              className="text-ink font-semibold underline"
            >
              Clear the filters
            </a>{" "}
            to see all of them.
          </EmptyPanel>
        ) : (
          <EmptyPanel>
            No agreements yet. One appears here the moment someone signs, which
            is before they pay.
          </EmptyPanel>
        )
      ) : (
        /* The table scrolls inside this box. The page itself must never scroll
           sideways: an operator who has to pan the whole document to read a
           retention date will misread it. */
        <div className="border-line mt-4 overflow-x-auto rounded-md border bg-white">
          <table className="w-full min-w-[1040px] border-collapse text-sm">
            <caption className="sr-only">
              Signed business associate agreements
              {filtered ? ", filtered" : ""}
            </caption>
            <thead>
              <tr className="border-line text-muted border-b text-left text-[13.2px] font-bold tracking-[0.06em] uppercase">
                <Th>Clinic</Th>
                <Th>Signatory</Th>
                <Th>Signed</Th>
                <Th>Version</Th>
                <Th>Copy sent</Th>
                <Th>Retention</Th>
                <Th>Fingerprint</Th>
                <Th align="right">Document</Th>
              </tr>
            </thead>
            <tbody>
              {register.rows.map((row) => (
                <AgreementRow
                  key={row.id}
                  row={row}
                  today={register.today}
                  actions={actions}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Filters
// -----------------------------------------------------------------------------

/**
 * One row, above the table, as a GET form.
 *
 * It wraps on a narrow screen rather than scrolling, because a filter an
 * operator cannot see is a filter they forget is applied, and this row is the
 * only thing on the page that explains why the table below has four rows in it.
 *
 * Every field is uncontrolled and rendered from the filters the server actually
 * applied, which is what makes a hand-edited URL honest: a date the page
 * refused to pass on comes back as an empty box rather than as text sitting in
 * a field that is doing nothing.
 */
function FilterRow({
  filters,
  today,
  rows,
}: {
  filters: AgreementQuery;
  today: string;
  rows: OpsAgreement[];
}) {
  // Suggestions, not a closed list. With the search running upstream, a select
  // built from the rows on this page would offer only the versions that already
  // survived the current filter, which is a menu that narrows as you use it.
  const versions = Array.from(new Set(rows.map((row) => row.version))).sort(
    (a, b) => a.localeCompare(b),
  );

  return (
    <form
      method="get"
      action={REGISTER_PATH}
      className="border-line bg-paper-2/60 mt-5 flex flex-wrap items-end gap-3 rounded-md border p-4"
    >
      <Field label="Search" className="min-w-[220px] flex-1">
        <input
          type="search"
          name="q"
          defaultValue={filters.query ?? ""}
          maxLength={200}
          placeholder="Clinic, signatory, email or fingerprint"
          className="border-line focus:border-orange w-full rounded-sm border bg-white px-3 py-2 text-sm"
        />
      </Field>

      <Field label="Signed from">
        <input
          type="date"
          name="from"
          defaultValue={filters.signedFrom ?? ""}
          max={today}
          className="border-line focus:border-orange w-full rounded-sm border bg-white px-3 py-2 text-sm"
        />
      </Field>

      <Field label="Signed to">
        <input
          type="date"
          name="to"
          defaultValue={filters.signedTo ?? ""}
          max={today}
          className="border-line focus:border-orange w-full rounded-sm border bg-white px-3 py-2 text-sm"
        />
      </Field>

      <Field label="Version">
        <input
          type="text"
          name="version"
          list="agreement-versions"
          defaultValue={filters.version ?? ""}
          maxLength={64}
          placeholder="Any version"
          className="border-line focus:border-orange w-full rounded-sm border bg-white px-3 py-2 text-sm"
        />
        <datalist id="agreement-versions">
          {versions.map((version) => (
            <option key={version} value={version} />
          ))}
        </datalist>
      </Field>

      <Field label="Status">
        <select
          name="status"
          defaultValue={filters.status ?? ""}
          className="border-line focus:border-orange w-full rounded-sm border bg-white px-3 py-2 text-sm"
        >
          {/* The three partition the register: an agreement that has ended and
              is still inside the six-year floor is "terminated", and one past
              the floor is not. Labelling them as overlapping sets is how a row
              gets acted on under the wrong heading. */}
          <option value="">Any status</option>
          <option value="in_effect">In effect</option>
          <option value="terminated">Terminated, inside the floor</option>
          <option value="retention_review">Past the six-year floor</option>
        </select>
      </Field>

      <Field label="Copy sent">
        <select
          name="copy"
          defaultValue={
            filters.copySent === true
              ? "sent"
              : filters.copySent === false
                ? "missing"
                : ""
          }
          className="border-line focus:border-orange w-full rounded-sm border bg-white px-3 py-2 text-sm"
        >
          <option value="">Either</option>
          <option value="sent">Delivered</option>
          <option value="missing">Never delivered</option>
        </select>
      </Field>

      <button
        type="submit"
        className="bg-ink rounded-full px-5 py-2.5 text-sm font-bold text-white"
      >
        Search
      </button>
    </form>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={className ?? ""}>
      <span className="text-muted block text-[13.2px] font-bold tracking-[0.06em] uppercase">
        {label}
      </span>
      <span className="mt-1.5 block">{children}</span>
    </label>
  );
}

// -----------------------------------------------------------------------------
// Rows
// -----------------------------------------------------------------------------

function AgreementRow({
  row,
  today,
  actions,
}: {
  row: OpsAgreement;
  today: string;
  actions: RegisterActions;
}) {
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [download, setDownload] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  async function getPdf() {
    if (downloading) return;
    setDownloading(true);
    setDownload(null);

    const minted = await actions.mintDownload(row.id);
    if (!minted.ok) {
      setDownload(minted.message);
      setDownloading(false);
      return;
    }

    const controller = new AbortController();
    const deadline = window.setTimeout(
      () => controller.abort(),
      PDF_TIMEOUT_MS,
    );

    try {
      const response = await fetch(
        `/api/agreement/pdf?id=${encodeURIComponent(row.id)}`,
        {
          // The cookie just minted is the whole authorisation. Without it this
          // is a 401, and that is the point: the id is not a credential.
          credentials: "same-origin",
          headers: { Accept: "application/pdf" },
          cache: "no-store",
          signal: controller.signal,
        },
      );

      // The content type is checked as well as the status, because the failure
      // to guard against is not an error but a success: anything answering 200
      // with JSON would otherwise be saved under a .pdf name, and a file that
      // will not open is worse than a button that admitted it could not.
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!response.ok || !type.includes("application/pdf")) {
        setDownload(
          "The PDF could not be produced. The stored text is the record either way; the reason is in our logs.",
        );
        return;
      }

      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filenameFrom(
        response.headers.get("content-disposition"),
        FALLBACK_FILENAME,
      );
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Not revoked synchronously: some browsers have not started reading the
      // blob by the time click() returns, and revoking here saves nothing.
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch {
      // The abort lands here too. A download that timed out is a failed one.
      setDownload("The download did not finish. Try it again.");
    } finally {
      window.clearTimeout(deadline);
      setDownloading(false);
    }
  }

  return (
    <>
      <tr className="border-line border-b align-top last:border-b-0">
        <Td>
          {row.clinicName ? (
            <span className="font-semibold">{row.clinicName}</span>
          ) : (
            /* The legal name lives in the signed variables, not in a column.
               A document that carried none is a fact about that row, and not a
               reason to print a clinic's current name over a contract that did
               not use it. */
            <span className="text-muted">Not named in the document</span>
          )}
        </Td>
        <Td>{row.signatory}</Td>
        <Td>
          <span className="whitespace-nowrap">{row.signedOn}</span>
        </Td>
        <Td>v{row.version}</Td>
        <Td>
          {row.copySentOn ? (
            <span className="whitespace-nowrap">{row.copySentOn}</span>
          ) : (
            <span className="text-red-deep font-semibold">Never</span>
          )}
        </Td>
        <Td>
          <RetentionCell retention={row.retention} />
        </Td>
        <Td>
          <Fingerprint
            hash={row.documentHash}
            revealed={revealed}
            onToggle={() => setRevealed((value) => !value)}
          />
        </Td>
        <Td align="right">
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => void getPdf()}
              disabled={downloading}
              className="bg-ink rounded-full px-3.5 py-1.5 text-xs font-bold whitespace-nowrap text-white disabled:opacity-50"
            >
              {downloading ? "Preparing…" : "PDF"}
            </button>
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              className="border-line-strong hover:border-ink rounded-full border px-3.5 py-1.5 text-xs font-bold whitespace-nowrap transition-colors"
            >
              {open ? "Close" : "Manage"}
            </button>
          </div>
          {download ? (
            <p role="status" className="text-red-deep mt-2 text-xs font-semibold">
              {download}
            </p>
          ) : null}
        </Td>
      </tr>

      {open ? (
        <tr className="border-line bg-paper-2/40 border-b last:border-b-0">
          <td colSpan={8} className="px-4 py-5">
            <RowDetail row={row} today={today} actions={actions} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function RetentionCell({ retention }: { retention: AgreementRetention }) {
  if (retention.state === "live") {
    return <span className="text-muted">In effect, no date</span>;
  }
  if (retention.reached) {
    return (
      <span className="text-red-deep font-semibold whitespace-nowrap">
        Eligible since {retention.until}
      </span>
    );
  }
  return (
    <span className="whitespace-nowrap">Keep until {retention.until}</span>
  );
}

/**
 * A short prefix, and the whole string on demand.
 *
 * Sixty-four hex characters in a table column would either wrap into four lines
 * on every row or be truncated with no way to see the rest, and the rest is
 * exactly what somebody comparing this against a document needs. So the prefix
 * is what the table shows and the full value is one click away, selectable,
 * with no ellipsis in it to be copied by accident.
 */
function Fingerprint({
  hash,
  revealed,
  onToggle,
}: {
  hash: string;
  revealed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="min-w-[190px]">
      <code className="block text-xs break-all select-all">
        {revealed ? hash : `${hash.slice(0, HASH_PREFIX)}…`}
      </code>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={revealed}
        className="text-muted hover:text-ink mt-1 text-xs font-semibold underline"
      >
        {revealed ? "Show less" : "Show all 64"}
      </button>
    </div>
  );
}

/**
 * The detail panel, and the wall in front of the irreversible act.
 *
 * Resending is cheap and safe, so it is one button. Recording a termination
 * cannot be undone by this application, the runtime role has no statement that
 * clears the date, so it takes three deliberate steps and states the
 * consequence in full before the last one. A `window.confirm` was the obvious
 * alternative and cannot say any of this.
 */
function RowDetail({
  row,
  today,
  actions,
}: {
  row: OpsAgreement;
  today: string;
  actions: RegisterActions;
}) {
  const [resend, setResend] = useState<string | null>(null);
  const [terminate, setTerminate] = useState<string | null>(null);
  const [step, setStep] = useState<"idle" | "date" | "confirm">("idle");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState<AgreementTerminationReason | "">("");
  const [pending, startTransition] = useTransition();

  const alreadyTerminated = row.retention.state === "terminated";

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <dl className="grid content-start gap-1.5 text-sm">
        <DetailRow label="Signed">
          {row.signedAt}
          <span className="text-muted block">{row.signatoryEmail}</span>
        </DetailRow>
        <DetailRow label="Copy to signer">
          {row.copySentOn ? (
            `Emailed ${row.copySentOn}`
          ) : (
            <span className="text-red-deep font-semibold">Never delivered</span>
          )}
        </DetailRow>
        <DetailRow label="Retention">
          <RetentionNote retention={row.retention} />
        </DetailRow>
        <DetailRow label="Fingerprint">
          <code className="text-xs break-all select-all">
            {row.documentHash}
          </code>
        </DetailRow>
      </dl>

      <div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setResend(null);
              startTransition(async () => {
                setResend(describeResend(await actions.resendCopy(row.id)));
              });
            }}
            className="bg-ink rounded-full px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
          >
            {pending
              ? "Working…"
              : row.copySentOn
                ? "Resend copy"
                : "Send copy"}
          </button>

          {alreadyTerminated ? null : (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setTerminate(null);
                setStep(step === "idle" ? "date" : "idle");
              }}
              className="border-line-strong hover:border-ink rounded-full border px-5 py-2.5 text-sm font-bold transition-colors disabled:opacity-50"
            >
              {step === "idle" ? "Mark terminated" : "Cancel"}
            </button>
          )}
        </div>

        {resend ? (
          <p role="status" className="mt-3 text-sm">
            {resend}
          </p>
        ) : null}

        {step === "date" ? (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="min-w-[200px]">
              <span className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">
                Last day the agreement was in effect
              </span>
              <input
                type="date"
                value={date}
                max={today}
                onChange={(event) => setDate(event.target.value)}
                className="border-line focus:border-orange mt-1.5 w-full rounded-sm border bg-white px-3 py-2.5 text-sm"
              />
              <span className="text-muted mt-1 block text-xs">
                A date that has already passed. Notice of a future end date is
                not a termination yet, and this cannot be corrected later.
              </span>
            </label>
            <label className="min-w-[280px]">
              <span className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">
                Who ended it, and why
              </span>
              <select
                value={reason}
                onChange={(event) =>
                  setReason(
                    isAgreementTerminationReason(event.target.value)
                      ? event.target.value
                      : "",
                  )
                }
                className="border-line focus:border-orange mt-1.5 w-full rounded-lg border bg-white px-3 py-2.5 text-sm"
              >
                <option value="">Choose one</option>
                {AGREEMENT_TERMINATION_REASONS.map((value) => (
                  <option key={value} value={value}>
                    {AGREEMENT_TERMINATION_REASON_COPY[value].label}
                  </option>
                ))}
              </select>
              <span className="text-muted mt-1 block text-xs">
                It decides whether the practice is refunded, and it cannot be
                changed once recorded.
              </span>
            </label>
            <button
              type="button"
              disabled={date === "" || reason === ""}
              onClick={() => setStep("confirm")}
              className="border-line-strong hover:border-ink rounded-full border px-5 py-2.5 text-sm font-bold transition-colors disabled:opacity-40"
            >
              Continue
            </button>
          </div>
        ) : null}

        {step === "confirm" ? (
          <div className="border-red/40 bg-red/[0.06] mt-3 rounded-sm border p-4">
            <p className="text-sm font-bold">
              This starts a six-year retention clock, and this console cannot
              stop it.
            </p>
            <p className="text-muted mt-1 text-sm">
              Recording that{" "}
              <span className="font-semibold">
                {row.clinicName ?? "this signer"}
              </span>{" "}
              ended their agreement on{" "}
              <span className="font-semibold">{date}</span> means this record
              must be kept for at least six years from that date, not from
              signature (45 CFR 164.530(j)(2)). The application has no way to
              clear the date afterwards: correcting a mistake means a database
              administrator. Check the year.
            </p>
            <p className="text-muted mt-2 text-sm">
              Unless another agreement still covers the practice, its service
              ends with this one: the assistant stops answering, every location
              starts offboarding, and the subscription is cancelled at once.{" "}
              {reason !== "" &&
              AGREEMENT_TERMINATION_REASON_COPY[reason].refundsFees
                ? "The agreement refunds the fees paid for any time after this date: preview and confirm that refund on the clinic's Billing page."
                : "Nothing is refunded for this ending."}
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (reason === "") return;
                  startTransition(async () => {
                    const result = await actions.markTerminated(
                      row.id,
                      date,
                      reason,
                    );
                    setTerminate(describeTermination(result));
                    // Leave the confirm panel open on failure so the reason
                    // sits next to the date that caused it.
                    if (result.ok && result.data.status === "recorded") {
                      setStep("idle");
                    }
                  });
                }}
                className="bg-red rounded-full px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
              >
                {pending ? "Recording…" : `Record termination on ${date}`}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setStep("date")}
                className="border-line-strong hover:border-ink rounded-full border px-5 py-2.5 text-sm font-bold transition-colors disabled:opacity-50"
              >
                Change the date
              </button>
            </div>
          </div>
        ) : null}

        {terminate ? (
          <p role="status" className="mt-3 text-sm font-semibold">
            {terminate}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function RetentionNote({ retention }: { retention: AgreementRetention }) {
  if (retention.state === "live") {
    return (
      <>
        No date, still in effect.{" "}
        <span className="text-muted">
          Six years run from whenever it ends.
        </span>
      </>
    );
  }
  if (retention.reached) {
    return (
      <>
        Eligible since {retention.until}{" "}
        <span className="text-muted">
          (terminated {retention.on}). Not deleted, and not deletable from here.
        </span>
      </>
    );
  }
  return (
    <>
      Keep until {retention.until}{" "}
      <span className="text-muted">
        (terminated {retention.on}, plus six years).
      </span>
    </>
  );
}

/**
 * The sentence for a resend.
 *
 * The two outcomes this side can describe are described here, next to the
 * screen they appear on. The two it cannot are carried: a transport's own
 * reason for not sending, because inventing a paraphrase of "the transport is
 * not configured" helps nobody, and a refusal, because the ops API knows things
 * about the row that this component does not.
 */
function describeResend(result: OpsResult<ResendOutcome>): string {
  if (!result.ok) return result.message;
  if (result.data.status === "refused") return result.data.message;

  const said =
    result.data.status === "sent"
      ? result.data.firstCopy
        ? "Sent. Recorded as the first copy this signer received."
        : "Sent again. The recorded delivery date is still the first one, because that is the date the counterparty actually got their copy."
      : `Not sent: ${result.data.reason}`;

  return result.data.auditRecorded ? said : `${said} ${UNAUDITED}`;
}

function describeTermination(result: OpsResult<TerminateOutcome>): string {
  if (!result.ok) return result.message;
  if (result.data.status === "refused") return result.data.message;

  const ended = result.data.servicesEnded
    ? result.data.refundDue
      ? " The practice's service has ended and its subscription is being cancelled; preview and confirm its refund on the clinic's Billing page."
      : " The practice's service has ended and its subscription is being cancelled; nothing is refunded."
    : "";
  const recorded = `Recorded as terminated on ${result.data.terminatedOn}. This record must now be kept until ${result.data.retainUntil}, and nothing deletes it when that date passes.${ended}`;

  return result.data.auditRecorded ? recorded : `${recorded} ${UNAUDITED}`;
}

/**
 * The route's filename, reduced to something that cannot do anything.
 *
 * Intercepting the click is what makes `download` win over
 * `Content-Disposition`, so this is the one path where the two could disagree
 * and the fix is to ask. Eight lines duplicated from the checkout's own copy on
 * purpose: importing it would pull the entire checkout flow into the admin
 * bundle to save a regular expression.
 */
function filenameFrom(disposition: string | null, fallback: string): string {
  const match = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition ?? "");
  const raw = (match?.[1] ?? match?.[2] ?? "").trim();
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.\-]+/, "")
    .slice(0, 120);
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : fallback;
}

// -----------------------------------------------------------------------------
// The three states that are not a table
//
// They live beside each other so that "distinguishable" is something a reviewer
// can check by reading forty lines rather than by loading three environments.
// Loading is neutral and says what it is waiting for; empty is quiet and says
// why it is empty; failure is red, names the failure, and offers the one thing
// that could help.
// -----------------------------------------------------------------------------

export function RegisterLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="border-line text-muted mt-8 rounded-md border bg-white p-6 text-sm"
    >
      <p className="font-semibold">Reading the register…</p>
      <p className="mt-1 max-w-[62ch]">
        The agreements live in the application, not in this site, so this is a
        round trip rather than a page render.
      </p>
      <div aria-hidden className="mt-4 grid gap-2">
        <div className="bg-paper-2 h-3 w-1/3 rounded-full" />
        <div className="bg-paper-2 h-3 w-2/3 rounded-full" />
        <div className="bg-paper-2 h-3 w-1/2 rounded-full" />
      </div>
    </div>
  );
}

export function RegisterError({
  failure,
  filters,
}: {
  failure: OpsFailure;
  filters: AgreementQuery;
}) {
  const retry = queryString(filters);

  return (
    <div
      role="status"
      className="border-red/30 bg-red/[0.06] mt-8 rounded-md border p-6"
    >
      <p className="text-sm font-bold">Could not load the register.</p>
      <p className="mt-1 max-w-[62ch] text-sm">{failure.message}</p>

      <div className="mt-4 flex flex-wrap gap-3">
        {failure.code === "unauthenticated" ? (
          <a
            href="/admin/sign-in"
            className="border-line-strong hover:border-ink inline-block rounded-full border px-4 py-2 text-sm font-bold transition-colors"
          >
            Sign in
          </a>
        ) : (
          <a
            href={retry ? `${REGISTER_PATH}?${retry}` : REGISTER_PATH}
            className="border-line-strong hover:border-ink inline-block rounded-full border px-4 py-2 text-sm font-bold transition-colors"
          >
            Try again
          </a>
        )}

        {/* A refused filter is the one failure the operator can fix, so the
            way back to an unfiltered register is offered beside the retry. */}
        {failure.code === "invalid_filter" && retry ? (
          <a
            href={REGISTER_PATH}
            className="border-line-strong hover:border-ink inline-block rounded-full border px-4 py-2 text-sm font-bold transition-colors"
          >
            Clear the filters
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The filters as they came in, so "try again" retries the same search. */
function queryString(filters: AgreementQuery): string {
  const params = new URLSearchParams();
  if (filters.query) params.set("q", filters.query);
  if (filters.signedFrom) params.set("from", filters.signedFrom);
  if (filters.signedTo) params.set("to", filters.signedTo);
  if (filters.version) params.set("version", filters.version);
  if (filters.status) params.set("status", filters.status);
  if (filters.copySent === true) params.set("copy", "sent");
  if (filters.copySent === false) params.set("copy", "missing");
  return params.toString();
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-line text-muted mt-4 rounded-md border bg-white p-6 text-sm">
      {children}
    </p>
  );
}

// -----------------------------------------------------------------------------
// Table furniture
// -----------------------------------------------------------------------------

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 font-bold ${align === "right" ? "text-right" : ""}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td className={`px-4 py-3 ${align === "right" ? "text-right" : ""}`}>
      {children}
    </td>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-0.5">
      <dt className="text-muted min-w-[120px]">{label}</dt>
      <dd className="min-w-0 flex-1 font-medium">{children}</dd>
    </div>
  );
}
