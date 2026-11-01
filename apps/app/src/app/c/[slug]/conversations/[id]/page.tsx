import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  CHANNEL_NAMES,
  CORRECTION_WORDS,
  OUTCOME_NAMES,
  OUTCOME_STYLES,
  phoneText,
  receiptSentence,
  REQUEST_STATUS_NAMES,
} from "@/lib/portal/conversation-words";
import { bookingRequestPath } from "@/lib/portal/booking-paths";
import { readConversation } from "@/lib/portal/conversations";
import { portalDay, portalMoment } from "@/lib/portal/format";
import { isBuiltSection, sectionPath } from "@/lib/portal/nav";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { patientGuardProps, requirePatientPage } from "@/lib/portal/patient-page";
import { PATIENT_REQUESTERS, REQUESTER_LABELS } from "@/lib/patient-rights/requesters";

import { FeedbackProvider } from "../../feedback";
import { PatientPageGuard } from "../../PatientPageGuard";
import { PortalShell } from "../../PortalShell";

import { FlagAnswer, PersonExport, SendAgain } from "./ConversationControls";

export const metadata: Metadata = { title: "Conversation · healdesk", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * One conversation, opened (plan Part F4): its channel, when, its outcome,
 * who as the clinic's records name them, the booking request it produced,
 * any amendment the practice directed, the transcript's delivery receipt
 * with "Send again" until delivery is confirmed, and "Flag this answer"
 * with its optional correction, or the flag and whether its correction is
 * live. Never a word of the conversation: none is kept. A patient page: requirePatientPage first, and
 * the open writes its access rows (the conversation, its receipt, its
 * request) in the transaction that reads it. An id this clinic does not hold
 * is "not found".
 */
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const page = await requirePatientPage(slug, { returnTo: `/c/${slug}/conversations` });
  const now = new Date();
  const portalPage = await loadPortalPage(page.portal, now);
  if (!portalPage) notFound();
  const shell = shellProps(page.portal, portalPage, "conversations");
  const detail = await readConversation(page, id);
  if (!detail) notFound();

  const zone = shell.timeZone;
  const when = (iso: string) => portalMoment(new Date(iso), zone, now);
  const clinicSlug = page.portal.clinicSlug;
  const person = shell.audience === "clients" ? "client" : "patient";
  const meta = detail.source === "meta_thread";
  const who = [detail.callerName, detail.callerPhone ? phoneText(detail.callerPhone) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <PortalShell {...shell}>
      <FeedbackProvider>
        <p>
          <a
            href={sectionPath(clinicSlug, "conversations")}
            className="inline-flex min-h-11 items-center text-sm font-semibold underline"
          >
            All conversations
          </a>
        </p>
        <PatientPageGuard {...patientGuardProps(page)}>
          <h1 className="text-2xl font-semibold">
            {CHANNEL_NAMES[detail.channel]} · {when(detail.startedAt)}
          </h1>

          <dl className="border-line mt-6 grid gap-3 rounded-md border bg-white px-4 py-4">
            <div>
              <dt className="text-muted text-sm">Outcome</dt>
              <dd className="mt-1">
                {detail.outcome ? (
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${OUTCOME_STYLES[detail.outcome]}`}
                  >
                    {OUTCOME_NAMES[detail.outcome]}
                  </span>
                ) : (
                  <span className="text-muted">
                    Not stored: {CHANNEL_NAMES[detail.channel]} keeps no record of what was said.
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted text-sm">Who</dt>
              <dd className="mt-1">
                {who || (
                  <span className="text-muted">
                    {meta ? "Name and number not shared" : "No name or number"}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted text-sm">{meta ? "Last message" : "Ended"}</dt>
              <dd className="mt-1">{detail.endedAt ? when(detail.endedAt) : "Not recorded"}</dd>
            </div>
            {meta && detail.conversationsCount !== null ? (
              <div>
                <dt className="text-muted text-sm">Conversations with this {person} here</dt>
                <dd className="mt-1">{detail.conversationsCount}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-muted text-sm">Booking request</dt>
              <dd className="mt-1">
                {detail.request ? (
                  <>
                    {REQUEST_STATUS_NAMES[detail.request.status] ?? detail.request.status}, taken{" "}
                    {when(detail.request.createdAt)}
                    {isBuiltSection("bookings") ? (
                      <>
                        {" · "}
                        <a
                          href={bookingRequestPath(clinicSlug, detail.request.id)}
                          className="font-semibold underline"
                        >
                          See it in Bookings
                        </a>
                      </>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted">None</span>
                )}
              </dd>
            </div>
          </dl>

          <section aria-labelledby="transcript-heading" className="mt-10">
            <h2 id="transcript-heading" className="text-lg font-semibold">
              Transcript
            </h2>
            {meta ? (
              <p className="text-muted mt-2">
                Messages on {CHANNEL_NAMES[detail.channel]} aren&rsquo;t kept, and no transcript is
                emailed for them.
              </p>
            ) : (
              <div className="border-line mt-3 rounded-md border bg-white px-4 py-4">
                <p>{receiptSentence(detail.receipt, when)}</p>
                {detail.receipt && detail.receipt.attempts > 0 ? (
                  <p className="text-muted mt-1 text-sm">
                    {detail.receipt.attempts === 1
                      ? "1 send so far."
                      : `${detail.receipt.attempts} sends so far.`}
                  </p>
                ) : null}
                {detail.canSendAgain ? (
                  <>
                    <p id="send-again-note" className="text-muted mt-3 text-sm">
                      Sends it to {portalPage.state.address ?? "your clinic's address"} again. You
                      can do this until your mail server confirms it arrived; then healdesk deletes
                      its copy.
                    </p>
                    <SendAgain slug={clinicSlug} conversationId={detail.id} />
                  </>
                ) : null}
              </div>
            )}
          </section>

          <section aria-labelledby="flag-heading" className="mt-10">
            <h2 id="flag-heading" className="text-lg font-semibold">
              Flag this answer
            </h2>
            {detail.flag ? (
              <div className="border-line mt-3 rounded-md border bg-white px-4 py-4">
                <p>
                  Flagged {when(detail.flag.flaggedAt)}. healdesk has been told.
                </p>
                <p className="mt-1">
                  <span
                    className={detail.flag.correction === "live" ? "text-green font-semibold" : "font-semibold"}
                  >
                    {CORRECTION_WORDS[detail.flag.correction]}
                  </span>
                  {detail.flag.correction !== "none" ? (
                    <>
                      {". "}
                      <a
                        href={`${sectionPath(clinicSlug, "knowledge")}#quick-answers`}
                        className="font-semibold underline"
                      >
                        See it in Your practice
                      </a>
                    </>
                  ) : null}
                </p>
                {detail.flag.correction === "none" ? (
                  <FlagAnswer
                    slug={clinicSlug}
                    conversationId={detail.id}
                    flagged
                    audience={shell.audience}
                  />
                ) : null}
              </div>
            ) : (
              <>
                <p className="text-muted mt-2">
                  Did AYA get something wrong here? Flag it and healdesk is told at once. If you
                  know the right answer, add it: AYA uses it from the next call or chat.
                </p>
                <FlagAnswer
                  slug={clinicSlug}
                  conversationId={detail.id}
                  flagged={false}
                  audience={shell.audience}
                />
              </>
            )}
            {meta ? (
              <p className="text-muted mt-2 text-sm">
                On {CHANNEL_NAMES[detail.channel]}, AYA doesn&rsquo;t use Quick answers, so a
                correction is used on phone and website chat.
              </p>
            ) : null}
          </section>

          {detail.amendments.length > 0 ? (
            <section aria-labelledby="amendments-heading" className="mt-10">
              <h2 id="amendments-heading" className="text-lg font-semibold">
                Amendments
              </h2>
              <ul className="mt-3 grid gap-2">
                {detail.amendments.map((a) => (
                  <li key={a.id} className="border-line rounded-md border bg-white px-4 py-3">
                    <p className="whitespace-pre-line">{a.amendment}</p>
                    <p className="text-muted mt-1 text-sm">
                      To the {a.on === "booking_request" ? "booking request" : "conversation"},
                      recorded {portalDay(a.recordedAt, zone, now)}. Asked for by{" "}
                      {REQUESTER_LABELS[a.requestedBy].toLowerCase()}.
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {detail.contactId ? (
            <section aria-labelledby="person-export-heading" className="mt-10">
              <h2 id="person-export-heading" className="text-lg font-semibold">
                This {person}&rsquo;s records
              </h2>
              <PersonExport
                slug={clinicSlug}
                conversationId={detail.id}
                audience={shell.audience}
                requesters={PATIENT_REQUESTERS.map((value) => ({
                  value,
                  label: REQUESTER_LABELS[value],
                }))}
              />
            </section>
          ) : null}
        </PatientPageGuard>
      </FeedbackProvider>
    </PortalShell>
  );
}
