"use server";

import { redirect, RedirectType } from "next/navigation";

import type { RequestContext } from "@/lib/audit";
import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import {
  consumeConnectionLinkWithin,
  resolveConnectionLink,
  type ResolvedLink,
} from "@/lib/connections/links";
import { saveConnection } from "@/lib/connections/store";
import {
  CredentialValidationError,
  validateCredentials,
  verifyConnection,
} from "@/lib/connections/verify";
import { withTenant } from "@/lib/tenant";

import { connectRequestContext } from "./request-context";
import { log } from "@/lib/log";

/**
 * The one write a clinic ever makes to healdesk.
 *
 * There is no session behind this action and there never will be — a clinic has
 * no account to sign into. The only thing the browser sends that says anything
 * about identity is the token, and it is re-resolved here against the database
 * before a single field is read. The clinic and the platform come back from
 * that lookup; a hidden `clinicId` field would be an authorisation bug with a
 * friendly name. A server action is a public POST endpoint, and the page that
 * rendered the form is not a statement about who is submitting it.
 *
 * ## One transaction, and why the ordering inside it stops mattering
 *
 * `consumeConnectionLinkWithin()` burns the link inside a transaction this
 * action owns, rather than `consumeConnectionLink()` which opens its own. That
 * is the choice links.ts recommends and the reason is the whole security story
 * of this file: with both the credential write and the burn in one transaction,
 * a burn that returns false is answered by throwing, and the credential rolls
 * back with everything else. Exactly one submission per link ever commits a
 * credential.
 *
 * The two ways a second submission can arrive both land there:
 *
 *   1. **Serially** — a second tab, or an impatient second click after the
 *      first request committed. The conditional UPDATE matches nothing and
 *      returns false.
 *   2. **Simultaneously** — both INSERT into provider_connections, which
 *      carries a unique index on (clinic_id, provider). Postgres serialises
 *      them on it: the loser blocks until the winner commits, then aborts with
 *      23505 without ever reaching the burn.
 *
 * ⚠️ Keeping these two calls in one transaction is load-bearing, not tidiness.
 * `saveConnection()` runs first, so for the life of the transaction we have
 * written a credential supplied by someone we have not yet established was
 * entitled to spend this link. That is only safe because it is invisible and
 * undone — it never commits, and under READ COMMITTED no other transaction sees
 * it. Split them apart and anyone holding a spent link, from a forwarded email
 * or a shared front-desk browser's history, can overwrite a live clinic's
 * credential with one they control and be told it worked.
 *
 * ## What the clinic is told, and why it differs by failure
 *
 * A false burn after a successful resolve means something spent the link in
 * between — in practice the same person's other tab, whose credential is
 * already in the vault. They are told it worked, because for them it did, and
 * the losing attempt is written to the audit log in its own transaction, since
 * the one that would have carried it was rolled back on purpose.
 *
 * A null resolve is the opposite case and gets the opposite answer: nothing was
 * stored, we cannot claim it was, and they need a new link. Expired, used,
 * unknown and malformed are one message there for the same reason
 * /connect/invalid is one page.
 *
 * ## Success leaves this URL entirely
 *
 * There is no "stored" state to render, on purpose. This form is progressively
 * enhanced, so a browser with JavaScript off submits it as a real POST to
 * `/connect/<token>` — and after the action commits, Next renders that page to
 * build the response. The render re-resolves a token this very request has just
 * spent, gets null, and redirects to `/connect/invalid`: a clinic whose
 * credential is in the vault, told their link is dead. The page cannot tell that
 * render apart from a plain GET, and the only in-page discriminator would be to
 * soften the null-link redirect, which is the anti-oracle rule.
 *
 * So success ends at `/connect/done`, a static page with nothing to look up.
 * One fix covers both transports — the no-JS POST gets a 303, the JS path a
 * client navigation — and a refresh after success lands somewhere final rather
 * than re-posting at a spent link. See the note on the redirect below for why
 * it has to sit outside the try.
 *
 * ## What is deliberately not done
 *
 * `markVerified()` is never called from this surface. It would set the
 * connection "active" on the strength of a catalogue lookup, and verify.ts is
 * explicit that the per-platform HTTP calls do not exist yet. Telling a clinic
 * we checked their credential when we did not is the failure that surfaces at
 * month end with an empty report. The row stays "pending"; the first sync
 * decides.
 */

/**
 * Only the states the form has to draw.
 *
 * Success is absent because it is no longer a state: it is a redirect to
 * `/connect/done`, and an action that redirects never resolves to anything the
 * client renders. A "stored" variant kept here for symmetry would be a branch
 * nothing can reach and an invitation to render the confirmation inline again,
 * which is the bug in the header note.
 */
export type ConnectFormState =
  | { status: "idle" }
  | { status: "failed"; message: string; field?: string };

/**
 * The driver error behind whatever drizzle threw.
 *
 * drizzle-orm 0.45 wraps every driver error in a `DrizzleQueryError` whose own
 * `code` is undefined; the pg `DatabaseError` carrying the SQLSTATE sits on
 * `.cause`. So anything reading `error.code` directly never matches, silently —
 * the failure mode this repo has already been bitten by once, in
 * lib/provisioning.ts, which walks the chain for exactly this reason.
 *
 * Bounded depth because a cause chain is attacker-adjacent input in the general
 * case and a cycle here would hang the request.
 */
function pgCause(
  error: unknown,
): { code: string; constraint?: string } | undefined {
  let current: unknown = error;

  for (let depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown };

    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        constraint:
          typeof candidate.constraint === "string"
            ? candidate.constraint
            : undefined,
      };
    }

    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

/**
 * The index two simultaneous submissions collide on. See the transaction note.
 *
 * Named rather than matched by bare code, and lib/provisioning.ts is the
 * cautionary tale: a plain `23505` check there was correct right up until a
 * second unique index appeared on the same path, at which point it read an
 * unrelated violation as the one it was hunting. Here that mistake would be
 * worse than a retry storm — an unrelated 23505 would be reported to the clinic
 * as "stored" for a credential that was never written, which is the one lie
 * this action must never tell. Every other unique index reachable inside this
 * transaction is a primary key on a generated uuid.
 */
const CONCURRENT_CONNECTION_INSERT = "provider_connections_clinic_provider_idx";

function isConcurrentConnectionInsert(error: unknown): boolean {
  const cause = pgCause(error);
  return (
    cause?.code === "23505" && cause.constraint === CONCURRENT_CONNECTION_INSERT
  );
}

/**
 * What may go in a log line from this path.
 *
 * This replaces `${error.name}: ${error.message}`, which was defended by a
 * comment saying driver errors "carry bound parameters on some clients". For
 * drizzle the message IS where they live: a `DrizzleQueryError` holds `query`
 * and `params` as own properties and interpolates both into its message, so a
 * failing write here logs the whole INSERT plus a clinic's ciphertext, IV, auth
 * tag and wrapped DEK. Verified against a live database, not inferred.
 *
 * The envelope holds, so none of that is plaintext. It is still far more than
 * that comment meant to allow, and application logs are the one store with none
 * of the protections drizzle/0024 and crypto/envelope.ts give the database —
 * no RLS, no grants, no BAA on whoever aggregates them.
 *
 * So a database error is reported by its SQLSTATE, which is the part that
 * actually helps at 3am, and its message is dropped. Everything else keeps its
 * message: those are our own errors, built from catalogue field labels rather
 * than from anything a caller typed.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";

  const cause = pgCause(error);
  if (cause) return `${error.name}: database error (SQLSTATE ${cause.code})`;

  // A drizzle wrapper with no SQLSTATE under it — a pool timeout, a socket
  // dropped mid-query. No code to report, and its message still carries the
  // query and its parameters, so it gets neither.
  if ("query" in error || "params" in error) {
    return `${error.name}: query failed before the database answered`;
  }

  return `${error.name}: ${error.message}`;
}

/** Thrown to roll the credential back when this request lost the burn. */
class LinkAlreadyConsumedError extends Error {
  constructor() {
    super("Connection link was consumed by another submission.");
    this.name = "LinkAlreadyConsumedError";
  }
}

/**
 * The same sentence for every rejection a stranger could provoke.
 *
 * Expired, already used, never issued and malformed are one outcome here for
 * the same reason they are one page: whoever holds a URL they should not have
 * learns nothing about which tokens are real, or which clinic one belongs to.
 */
const DEAD_LINK_MESSAGE =
  "This link is no longer valid. Reply to the email that brought you here and we'll send a new one.";

export async function submitCredential(
  _previous: ConnectFormState,
  formData: FormData,
): Promise<ConnectFormState> {
  const token = formData.get("token");

  // FormData can hand back a File. Everything else about a token's shape is
  // links.ts's business — it is contracted to return null or false for anything
  // malformed rather than throw, and a second, quietly diverging opinion here
  // would only add a timing difference between "wrong shape" and "wrong token".
  if (typeof token !== "string") {
    return { status: "failed", message: DEAD_LINK_MESSAGE };
  }

  // Read before the limiter, because the limiter needs the address and because
  // the resolve below wants it too: the open it records is the trail's only
  // sighting of a link being submitted from somewhere it should not be.
  const request = await connectRequestContext();

  // Before the database, before envelope encryption — before anything that
  // costs us work on a stranger's behalf. Keyed on the token AND on the
  // address: on its own the token key bounds nothing a stranger does, because a
  // caller presenting a fresh token every time opens a fresh window every time.
  // See lib/connections/attempt-limit.ts.
  if (
    !withinConnectAttemptLimit("submit", token, request.ipAddress ?? null)
  ) {
    return {
      status: "failed",
      message:
        "That's several attempts in a row. Give it ten minutes, or reply to your setup email and we'll do this with you.",
    };
  }

  const link: ResolvedLink | null = await resolveConnectionLink(token, request);
  if (!link) {
    return { status: "failed", message: DEAD_LINK_MESSAGE };
  }

  const submitted: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key === "token") continue;
    if (typeof value === "string") submitted[key] = value;
  }

  const context = {
    clinicId: link.clinicId,
    actor: { type: "service" as const, serviceName: "connect-link" },
    request,
  };

  try {
    // The platform comes from the link row, never from the form. Field-level
    // errors are why this runs here rather than being left to the write:
    // "API key is required" is actionable, "that didn't work" is not.
    const credentials = validateCredentials(link.platformId, submitted);

    // Local — it reads the platform catalogue and makes no network call. Kept
    // for `ok` and the field-free rejection message; its `unverifiedReason` is
    // no longer rendered from here, because success no longer renders anything
    // from here. The generic form of that same sentence — we have not called
    // your booking system yet — is on /connect/done, which is static and so
    // cannot name the platform. Nothing about this call is evidence the
    // credential works; see the header note on markVerified().
    const verification = await verifyConnection({
      platformId: link.platformId,
      credentials,
    });

    if (!verification.ok) {
      return {
        status: "failed",
        message: verification.error ?? "We couldn't save that. Please try again.",
      };
    }

    let lostTheBurn = false;

    try {
      await withTenant(context, async (tx) => {
        const connectionId = await saveConnection(tx.db, {
          clinicId: link.clinicId,
          provider: link.platformId,
          credentials,
        });

        tx.audit.record({
          action: "create",
          resourceType: "provider_connection",
          resourceId: connectionId,
          // Metadata describes the access and never carries what was accessed.
          // No token, no credential, nothing assertNoPhi() would refuse.
          metadata: { provider: link.platformId, via: "connect_link" },
        });

        // The link is scoped to this transaction's tenant by RLS, so there is
        // no clinic id to pass and no comparison anyone can forget.
        const burned = await consumeConnectionLinkWithin(
          tx,
          token,
          request.ipAddress ?? null,
        );

        // Take the credential down with the transaction. The winner's copy is
        // already committed; a second one would mean the link bought two
        // writes, and the second could be a stranger's.
        if (!burned) throw new LinkAlreadyConsumedError();
      });
    } catch (error) {
      // A 23505 on (clinic, provider) can only be a concurrent insert of this
      // same pair: saveConnection() takes the UPDATE path whenever a row
      // already exists, so nothing else on this path raises that constraint.
      if (
        error instanceof LinkAlreadyConsumedError ||
        isConcurrentConnectionInsert(error)
      ) {
        lostTheBurn = true;
      } else {
        throw error;
      }
    }

    if (lostTheBurn) await recordLostBurn(context);
  } catch (error) {
    if (error instanceof CredentialValidationError) {
      return { status: "failed", message: error.message, field: error.field };
    }

    // Never the error object, and never a driver message — see describeError(),
    // where the bound parameters on this path are a clinic's sealed credential.
    // The clinic gets nothing specific either: whoever is holding this link
    // should not be able to read our internals through the form.
    log.error("connect-link submission failed", { error: describeError(error) });
    return {
      status: "failed",
      message:
        "We couldn't save that. Please try again, or reply to your setup email.",
    };
  }

  // ⚠️ Outside the try, and that is the whole of why this works. `redirect()`
  // signals by throwing a NEXT_REDIRECT error; one line higher, the catch-all
  // above would swallow it, log a finished setup as a failure and tell a clinic
  // whose credential is committed "We couldn't save that". Reached only when
  // nothing above returned, which is only when the transaction committed (or a
  // second submission lost the burn to the clinic's own first one, which is
  // also a success from where they are sitting).
  //
  // `replace` rather than the Server Action default of `push`: with a pushed
  // entry, Back from the confirmation returns to /connect/<token>, which
  // re-resolves a spent token and answers "This link is no longer valid" — the
  // exact support ticket the whole route is written to avoid, delivered
  // immediately after telling someone they were finished. The no-JS transport
  // gets a 303 and ignores the type entirely.
  redirect("/connect/done", RedirectType.replace);
}

/**
 * A submission that reached a link something else had already burned.
 *
 * This has to be its own transaction. `consumeConnectionLinkWithin()` records
 * its own rejection row, but it records it into the transaction we then roll
 * back on purpose — so without this, the one trace of a second submission
 * against a spent link disappears along with the credential it was refusing.
 *
 * The label says what we know rather than what we assume. The likely story is a
 * double-click, and the first submission's credential is safely stored. The
 * same false is what a replayed link produces. And in the rare case where the
 * link expired in the milliseconds between the resolve and the burn, nothing
 * was stored at all and we still said it worked — this row is what lets an
 * operator find that.
 *
 * Best-effort. Losing it must not fail a request whose credential is already in
 * the vault: that would tell a clinic their finished setup had failed and send
 * them back down the same losing path. The facts that carry weight — one
 * credential stored, one link burned — were written transactionally by the
 * submission that won and cannot be lost here.
 */
async function recordLostBurn(context: {
  clinicId: string;
  actor: { type: "service"; serviceName: string };
  request: RequestContext;
}): Promise<void> {
  try {
    await withTenant(context, async (tx) => {
      tx.audit.record({
        action: "update",
        resourceType: "connection_link",
        metadata: {
          surface: "connect_form",
          outcome: "rejected",
          reason: "lost_the_burn",
          told_clinic: "stored",
        },
      });
    });
  } catch (error) {
    log.error("could not record a losing connect-link submission", {
      error: describeError(error),
    });
  }
}
