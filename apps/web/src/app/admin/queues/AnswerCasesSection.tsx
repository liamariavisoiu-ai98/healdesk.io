import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { Failure, Section } from "@/components/admin/ui";
import { requireOperator } from "@/lib/admin/operator";
import {
  fetchAnswerCases,
  MISS_CASE_STATUSES,
  setMissCaseStatus,
  type MissCaseStatus,
  type MissCaseView,
  type OutageView,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

/**
 * Queues › Misses and outages: the records behind the three emails about AYA
 * not answering (apps/app lib/channels/answer-notices.ts), each opened in the
 * transaction that queued its email.
 *
 *   - An outage: opened with "AYA can't answer right now" once AYA has failed
 *     to answer a clinic for ten minutes, and closed by itself with "AYA is
 *     answering again" once she has answered for ten minutes with nothing
 *     failing, with the calls and chats unanswered meanwhile. Escalated to
 *     the owner two hours after it opened, then every twelve.
 *   - A miss case: opened with "Looking into a call (or message)" for a
 *     first-month miss, one per channel and day with its count. The owner
 *     marks it looking, explained or closed here; the clinic's reply, which
 *     carries the case's ref, is a case on the Support page.
 *
 * Ids, channels, counts and times, as the ops API sends them: never a caller,
 * a number or a word. Plain forms posting to a server action, which checks
 * the operator itself. The outcome comes back in `?miss=`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESULTS: Record<string, string> = {
  moved: "The miss case is updated.",
  already: "The miss case already had that status.",
  closed: "That miss case is closed; a new miss opens a new case.",
  not_found: "That miss case is not one this clinic has.",
  bad_note:
    "The closing note was not saved: one or two plain lines, up to 280 characters, with no address or link, and only when marking it explained.",
  error: "The change could not be sent. Reload and check before trying again.",
};

const CHANNEL_WORDS: Record<string, string> = { voice: "Phone", web: "Website chat", meta: "Meta" };
const STATUS_WORDS: Record<MissCaseStatus, string> = {
  open: "Open",
  looking: "Looking into it",
  explained: "Explained",
  closed: "Closed",
};

async function moveMissCase(formData: FormData): Promise<void> {
  "use server";
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const clinicId = String(formData.get("clinicId") ?? "");
  const caseId = String(formData.get("caseId") ?? "");
  const status = String(formData.get("status") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!UUID.test(clinicId) || !UUID.test(caseId) || !(MISS_CASE_STATUSES as readonly string[]).includes(status)) {
    redirect("/admin/queues?miss=not_found#answer-cases");
  }
  const outcome = await setMissCaseStatus(clinicId, caseId, status as MissCaseStatus, note || undefined);
  revalidatePath("/admin/queues");
  redirect(`/admin/queues?miss=${outcome.ok ? outcome.data.status : "error"}#answer-cases`);
}

/** "6 Oct, 14:07", New York time. */
function when(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function channels(list: readonly string[]): string {
  return list.map((c) => CHANNEL_WORDS[c] ?? c).join(", ");
}

function OutageRow({ outage }: { outage: OutageView }) {
  return (
    <li className="border-line rounded-md border bg-white p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-semibold">{outage.status === "open" ? "Not answering" : "Answering again"}</span>
        <span className="text-muted text-sm">
          since {when(outage.startedAt)} · {channels(outage.channels)}
        </span>
      </div>
      <p className="text-muted mt-1 text-sm">
        Clinic{" "}
        <a className="underline" href={`/admin/clinics/${outage.clinicId}/care`}>
          {outage.clinicSlug}
        </a>{" "}
        · clinic told {when(outage.openedAt)}
        {outage.status === "open"
          ? ` · escalate by ${when(outage.replyByAt)}${outage.escalations > 0 ? ` · escalated ${outage.escalations} time(s)` : ""}`
          : null}
      </p>
      {outage.status === "closed" && outage.endedAt ? (
        <p className="mt-2 text-sm font-semibold">
          Answering again {when(outage.endedAt)}: {outage.callCount ?? 0} call(s) and {outage.chatCount ?? 0} chat(s) went unanswered
          meanwhile. The clinic was told.
        </p>
      ) : null}
    </li>
  );
}

function MoveButton({ c, status, label }: { c: MissCaseView; status: MissCaseStatus; label: string }) {
  return (
    <form action={moveMissCase}>
      <input type="hidden" name="clinicId" value={c.clinicId} />
      <input type="hidden" name="caseId" value={c.caseId} />
      <input type="hidden" name="status" value={status} />
      <button type="submit" className="border-line rounded-sm border px-3 py-1.5 text-sm font-semibold">
        {label}
      </button>
    </form>
  );
}

function MissCaseRow({ c }: { c: MissCaseView }) {
  return (
    <li className="border-line rounded-md border bg-white p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-xs font-semibold">{c.ref}</span>
        <span className="text-sm font-semibold">{STATUS_WORDS[c.status]}</span>
        <span className="text-muted text-sm">
          {CHANNEL_WORDS[c.channel] ?? c.channel} · {c.missCount} missed on {c.missedOn}, first {when(c.firstMissedAt)}
        </span>
      </div>
      <p className="text-muted mt-1 text-sm">
        Clinic{" "}
        <a className="underline" href={`/admin/clinics/${c.clinicId}/care`}>
          {c.clinicSlug}
        </a>{" "}
        · look into it by {c.replyByOn}
        {c.replied ? " · the clinic replied: its email is a case on the Support page with this ref" : null}
      </p>
      {c.status === "closed" ? null : (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {c.status === "open" ? <MoveButton c={c} status="looking" label={"Mark looking"} /> : null}
          <MoveButton c={c} status="closed" label={"Close miss case"} />
        </div>
      )}
      {c.status === "closed" ? null : (
        <form action={moveMissCase} className="mt-3 grid gap-2">
          <input type="hidden" name="clinicId" value={c.clinicId} />
          <input type="hidden" name="caseId" value={c.caseId} />
          <input type="hidden" name="status" value="explained" />
          <label className="text-sm font-semibold" htmlFor={`note-${c.caseId}`}>
            Closing note for the clinic (shown in its portal beside each missed call or chat, never emailed)
          </label>
          <textarea
            id={`note-${c.caseId}`}
            name="note"
            maxLength={280}
            rows={2}
            className="border-line rounded-sm border px-3 py-2 text-sm"
            placeholder="One or two plain lines: what went wrong and that it is fixed."
          />
          <button type="submit" className="border-line w-fit rounded-sm border px-3 py-1.5 text-sm font-semibold">
            {"Mark explained"}
          </button>
        </form>
      )}
    </li>
  );
}

export default async function AnswerCasesSection({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { result } = await searchParams;
  const loaded = await fetchAnswerCases();
  const openOutages = loaded.ok ? loaded.data.outages.filter((o) => o.status === "open") : [];
  const openCases = loaded.ok ? loaded.data.missCases.filter((c) => c.status !== "closed") : [];

  return (
    <Section
      id="answer-cases"
      title="Misses and outages"
    >
      <p className="text-muted text-sm">
        Each outage and each missed call or message a clinic was emailed about. An outage closes by itself once AYA has
        answered for ten minutes with nothing failing, and the clinic is told. A miss case waits for you to look into it.
      </p>

      {result && RESULTS[result] ? (
        <p className="border-line mt-3 rounded-sm border bg-white px-4 py-3 text-xs font-semibold" role="status">
          {RESULTS[result]}
        </p>
      ) : null}

      {isHostUnreachable(loaded) ? (
        <HostStandbyNotice what="The misses and outages" />
      ) : !loaded.ok ? (
        <Failure failure={loaded} what="the misses and outages" />
      ) : (
        <>
          {loaded.data.unreadClinics > 0 ? (
            <p className="text-red-deep mt-2 text-xs font-semibold">
              {loaded.data.unreadClinics} clinic(s) could not be read, so their cases are missing below.
            </p>
          ) : null}
          <h3 className="mt-4 text-sm font-bold">Outages ({openOutages.length} open)</h3>
          {loaded.data.outages.length === 0 ? (
            <p className="text-muted mt-2 text-sm">No outage has been recorded.</p>
          ) : (
            <ul className="mt-3 grid gap-3">
              {loaded.data.outages.map((o) => (
                <OutageRow key={o.outageId} outage={o} />
              ))}
            </ul>
          )}
          <h3 className="mt-6 text-sm font-bold">Miss cases ({openCases.length} open)</h3>
          {loaded.data.missCases.length === 0 ? (
            <p className="text-muted mt-2 text-sm">No miss has been recorded.</p>
          ) : (
            <ul className="mt-3 grid gap-3">
              {loaded.data.missCases.map((c) => (
                <MissCaseRow key={c.caseId} c={c} />
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}
