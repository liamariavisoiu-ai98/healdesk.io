import { Suspense } from "react";

import type { AgreementTerminationReason } from "@healdesk/catalog";
import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import {
  DOWNLOAD_COOKIE,
  downloadCookieOptions,
  issueDownloadToken,
} from "@/lib/agreement-download";
import { requireOperator } from "@/lib/admin/operator";
import {
  fetchAgreements,
  markAgreementTerminated as markTerminatedUpstream,
  resendAgreementCopy as resendCopyUpstream,
  type AgreementQuery,
  type AgreementStatus,
  type OpsResult,
  type ResendOutcome,
  type TerminateOutcome,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import {
  AgreementsRegister,
  RegisterError,
  RegisterLoading,
  type MintDownloadResult,
} from "./AgreementsRegister";

/**
 * /admin/agreements, the register of signed business associate agreements.
 *
 * ## Why this is a page of its own and not a panel on /admin/ops
 *
 * The old console carried the agreements panel below the clinic list, and at
 * three agreements that was right. A register is a different thing: it is what
 * somebody opens when counsel asks which version a particular practice signed,
 * or when an auditor asks to see the evidence for one clinic. That reader
 * arrives with a name or a date, wants a filter row rather than a scroll, and
 * does not want the job kill switch anywhere near their cursor.
 *
 * ## The filters are in the URL, and the search runs upstream
 *
 * The console this replaces loaded the newest two hundred rows and filtered
 * them in the browser. That is fine for a panel and wrong for a register: a
 * free-text search that quietly only searches the most recent page answers
 * "which agreement has this fingerprint?" with "no such agreement" as soon as
 * the table outgrows it, and the operator has no way to tell that from a real
 * absence. `lib/agreements/search.ts` in apps/app exists so that the filter and
 * the count describe the whole table, so this page passes the filters through
 * and lets it answer.
 *
 * Keeping them in the query string rather than in component state is what makes
 * that work without JavaScript: the filter row is a plain GET form, submitting
 * it is a navigation, and the result is a URL an operator can bookmark or paste
 * into a ticket. It also means the loading state below is the one React already
 * gives us for a server render, rather than a spinner somebody has to maintain.
 *
 * ## The guard is here, on the page
 *
 * Not on the layout. Layouts do not re-run on client navigation and never run
 * for route handlers, so a check written once above this file is a check a
 * router transition can skip. The two ops actions below are guarded by
 * construction instead: both go through `ops-client`, which asks
 * `requireOperator()` before it will sign anything. `mintDownload` does not
 * cross to apps/app at all, so it asks in its own body.
 *
 * ## Why the data hangs in a Suspense boundary
 *
 * The register crosses a network to apps/app, which can take a second on a cold
 * start. Awaiting it before returning anything would leave the operator on a
 * blank tab with no indication that the click registered. Suspending after the
 * guard means the heading and the explanation arrive immediately and the table
 * arrives when it arrives, so "still loading" is a state the screen can show
 * rather than an absence the operator has to interpret.
 *
 * The guard deliberately runs OUTSIDE the boundary. Streaming a page shell to
 * someone who is not signed in, and only then deciding to redirect, would put
 * the shape of an internal surface in front of them for no reason.
 */

export const metadata: Metadata = {
  title: "Agreements",
};

/**
 * Never cached. `requireOperator()` reads cookies and would force this dynamic
 * anyway; saying so out loud means the guarantee does not depend on noticing
 * that side effect. A cached register is a register that shows a copy as never
 * delivered after somebody has resent it.
 */
export const dynamic = "force-dynamic";

/** Postgres `uuid`, which is what an acceptance id is. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** YYYY-MM-DD, which is what a date input submits and what the search takes. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Matches `MAX_QUERY_LENGTH` in the ops API. Longer is refused there anyway. */
const MAX_QUERY = 200;
const MAX_VERSION = 64;

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AgreementsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (!(await requireOperator())) redirect("/admin/sign-in");

  const filters = readFilters(await searchParams);

  return (
    <main className="mx-auto w-full max-w-[1240px] px-5 py-12 sm:px-8 lg:px-14">
      <h1 className="font-display text-[clamp(31.2px,4.32vw,40.8px)] leading-tight font-medium tracking-[-0.024em]">
        Agreements.
      </h1>
      <p className="text-muted mt-3 max-w-[68ch] text-[18px]">
        Every BAA anyone has signed, paid for or not. Retention runs six years
        from the later of signature and termination (45 CFR 164.530(j)(2)), so
        an agreement that is still in effect has no purge date at all: the clock
        has not started.
      </p>

      {/* Keyed on the filters so a new search shows the loading state rather
          than the previous answer under a heading that now describes a
          different one. */}
      <Suspense key={JSON.stringify(filters)} fallback={<RegisterLoading />}>
        <Register filters={filters} />
      </Suspense>
    </main>
  );
}

async function Register({ filters }: { filters: AgreementQuery }) {
  const result = await fetchAgreements(filters);
  if (isHostUnreachable(result)) return <HostStandbyNotice what="The agreement register" />;
  if (!result.ok) return <RegisterError failure={result} filters={filters} />;

  return (
    <AgreementsRegister
      register={result.data}
      filters={filters}
      actions={{ resendCopy, markTerminated, mintDownload }}
    />
  );
}

/**
 * The query string, reduced to a filter the ops API will accept.
 *
 * Anything malformed is DROPPED rather than passed on, and the filter row is
 * rendered from what survives, so a hand-edited URL with `from=yesterday` in
 * it shows an empty date field, which is the screen telling the operator what
 * it actually applied. Forwarding it instead would trade a visibly empty box
 * for a red banner about a filter they did not type.
 *
 * A repeated parameter arrives as an array. Taking the first is the only
 * defensible reading; joining them would invent a filter nobody asked for.
 */
function readFilters(params: SearchParams): AgreementQuery {
  const filters: AgreementQuery = {};

  const query = one(params.q).trim().slice(0, MAX_QUERY);
  if (query) filters.query = query;

  const from = one(params.from).trim();
  if (isRealDate(from)) filters.signedFrom = from;

  const to = one(params.to).trim();
  if (isRealDate(to)) filters.signedTo = to;

  const version = one(params.version).trim().slice(0, MAX_VERSION);
  if (version) filters.version = version;

  const status = one(params.status).trim();
  if (isStatus(status)) filters.status = status;

  const copy = one(params.copy).trim();
  if (copy === "sent") filters.copySent = true;
  if (copy === "missing") filters.copySent = false;

  return filters;
}

/**
 * A UTC calendar date that actually exists.
 *
 * The shape test alone is not enough, and the gap is not theoretical: 2026-02-31
 * matches `\d{4}-\d{2}-\d{2}` and is not a day. Forwarded, it reached the ops
 * API, which refuses unparseable dates on purpose, and the whole register was
 * replaced by a refusal banner with no filter row under it: the operator could
 * not see, let alone correct, the field that caused it. That contradicts what
 * this function promises above, which is that a filter this page will not apply
 * comes back as an empty box rather than as an error about something the
 * operator did not type. A date input cannot produce 2026-02-31, but a
 * hand-edited URL and a pasted link both can, and a pasted link is how an
 * operator arrives at this page from a ticket.
 *
 * Same rule as `parseInstant` in lib/agreements/search.ts: round-trip through
 * `Date` and require the text back, which rejects the days some engines roll
 * forward into the following month.
 */
function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const at = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

function one(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? "";
  return "";
}

function isStatus(value: string): value is AgreementStatus {
  return (
    value === "in_effect" ||
    value === "terminated" ||
    value === "retention_review"
  );
}

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

/**
 * Send the signer their copy again.
 *
 * Every reason this is needed is a reason it must be cheap: the transport was
 * unconfigured at signature, the address bounced and was fixed, the clinic's
 * office manager left and took the mailbox with them, or their counsel simply
 * asked for it. Nothing here re-signs anything. The document, its hash and its
 * signature block all come from the stored row.
 */
async function resendCopy(
  agreementId: string,
): Promise<OpsResult<ResendOutcome>> {
  "use server";

  const result = await resendCopyUpstream(agreementId);
  // Re-read either way. On success `copy_sent_at` may have just been stamped;
  // on failure the row is unchanged but the operator should see the list they
  // are working from refresh under them rather than wonder.
  revalidatePath("/admin/agreements");
  return result;
}

/**
 * Record the date a BAA stopped being in effect.
 *
 * 45 CFR 164.530(j)(2) requires documentation to be retained six years "from
 * the date of its creation or the date when it last was in effect, whichever is
 * later". For an agreement, "last in effect" is termination, so writing this
 * date starts a six-year clock that runs from it, and a clinic that stayed
 * three years is a record we hold for nine.
 *
 * The application cannot clear the column again: the grant that lets the
 * statement run is column-scoped and no path in this codebase sets
 * `terminated_at` back to null. Undoing a mistake means a human with the
 * migrator role, deliberately, which is the same bar purging has. The register
 * says so before it fires, because an operator who learns that afterwards has
 * learned it too late.
 */
async function markTerminated(
  agreementId: string,
  terminationDate: string,
  terminationReason: AgreementTerminationReason,
): Promise<OpsResult<TerminateOutcome>> {
  "use server";

  const result = await markTerminatedUpstream(
    agreementId,
    terminationDate,
    terminationReason,
  );
  revalidatePath("/admin/agreements");
  return result;
}

/**
 * Authorise this browser to download exactly one agreement's PDF.
 *
 * ## Why the register does not get its own download route
 *
 * `/api/agreement/pdf` already exists and is cookie-gated per agreement: the
 * uuid in its query string authorises nothing, and the credential is a
 * short-lived HMAC bound by `lib/agreement-download.ts` to one id. The obvious
 * move, widen that route to also accept an admin session, would put a second
 * authorisation path on the one route in this app that serves an executed
 * HIPAA contract, and the weaker of two paths is the one that gets exercised by
 * mistake.
 *
 * So nothing about that route changes. This action mints the same token the
 * checkout mints, for the row the operator actually asked for, after checking
 * that they are signed in. The register then fetches the PDF exactly as the
 * checkout does.
 *
 * ## What that means for what the cookie is worth
 *
 * One agreement at a time, for thirty minutes. Each download replaces the
 * previous token, so a browser never accumulates authority: the cookie an
 * operator carries away is good for the last row they clicked and nothing else.
 * That is a narrower grant than the register itself, which is the right
 * direction for a credential that outlives the page.
 *
 * `requireOperator()` is called here rather than left to `ops-client`, because
 * this action never reaches apps/app. It is the one place in this slice where
 * the check has to be written out.
 *
 * ## The cost, stated rather than discovered later
 *
 * Setting a cookie inside a server action makes Next re-render the current
 * route in the same response, so every PDF click also re-runs the register
 * search upstream. That is one extra signed round trip per download, it happens
 * alongside the download rather than in front of it, and the operator gets a
 * fresh table out of it. The way to avoid it is a route handler of its own,
 * which is a second authorisation surface in front of an executed HIPAA
 * contract. The round trip is the cheaper of the two.
 */
async function mintDownload(agreementId: string): Promise<MintDownloadResult> {
  "use server";

  if (!(await requireOperator())) {
    return {
      ok: false,
      message: "Your session has ended. Sign in again to download this.",
    };
  }

  // Shape, after the session check so it can never become an oracle for which
  // ids exist. Reaching this branch means the register rendered something that
  // is not an id, which is our bug.
  if (!UUID.test(agreementId)) {
    console.error(
      "[healdesk] admin agreements: download requested for a non-uuid id",
    );
    return { ok: false, message: "That is not an agreement id." };
  }

  let token: string;
  try {
    token = issueDownloadToken(agreementId);
  } catch (error) {
    // Throws when HEALDESK_GATE_SECRET is missing in production. The operator
    // cannot fix that from here, so they are told what it means for them and
    // the detail goes to the log.
    console.error(
      "[healdesk] admin agreements: could not mint a download",
      error,
    );
    return {
      ok: false,
      message:
        "This deployment cannot sign a download link, so the PDF is unavailable here.",
    };
  }

  const store = await cookies();
  store.set(DOWNLOAD_COOKIE, token, downloadCookieOptions());

  return { ok: true };
}
