"use client";

import { useState, useTransition } from "react";

import { ASKED_FOR_WORDS, recordedWords, RIGHTS_KIND_WORDS, VERIFICATION_WORDS } from "@/components/admin/rights-words";
import { Section } from "@/components/admin/ui";
import type { OpsResult, RecordRightsIntakeOutcome, RightsAskedFor, RightsKind, RightsVerification } from "@/lib/admin/ops-client";

import type { RecordRequestInput } from "./record-input";

/**
 * The Patient rights page's "Record a request" form (ops automation lane
 * P6b): a request as it reached us, recorded the day it came so its clock
 * is tracked before anything runs on the host (apps/app lib/rights/
 * tracker.ts recordIntake). Every field is a choice from a closed list or a
 * day: the clinic, what it asks for, the day received, how it was verified,
 * and for a patient's own request what was asked. Nothing typed, nothing
 * about the person: the request names nobody here.
 *
 * The request key is a uuid generated once when the form opens and sent
 * with it, so a double click, or a retried submit, records one request
 * (apps/app answers `already_recorded` for the same key). A form that has
 * recorded one is a fresh form for the next: it keeps its choices and mints
 * a new key, since a second request of one kind on one day is a second row.
 */

export type RecordAction = (input: RecordRequestInput) => Promise<OpsResult<RecordRightsIntakeOutcome | { status: "refused"; message: string }>>;

export type ClinicChoice = { id: string; name: string; synthetic: boolean };

const KINDS = Object.keys(RIGHTS_KIND_WORDS) as RightsKind[];
const VERIFICATIONS = Object.keys(VERIFICATION_WORDS) as RightsVerification[];
const ASKED_FOR = Object.keys(ASKED_FOR_WORDS) as RightsAskedFor[];

export const NO_CLINICS = "The clinic list could not be read, so no request can be recorded here until it can.";

const LABEL = "text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase";
const FIELD = "border-line rounded-sm border bg-white px-3 py-2.5";

function newKey(): string {
  return crypto.randomUUID();
}

export function RecordRequestForm({
  clinics,
  today,
  onRecord,
}: {
  /** Null when the clinic list could not be read. */
  clinics: ClinicChoice[] | null;
  /** The server's UTC day, YYYY-MM-DD: the latest day a request can have reached us. */
  today: string;
  onRecord: RecordAction;
}) {
  const [key, setKey] = useState(newKey);
  const [clinicId, setClinicId] = useState(clinics?.[0]?.id ?? "");
  const [kind, setKind] = useState<RightsKind>("erasure");
  const [receivedOn, setReceivedOn] = useState(today);
  const [verifiedVia, setVerifiedVia] = useState<RightsVerification>("notice_address");
  const [askedFor, setAskedFor] = useState<RightsAskedFor>("access");
  const [said, setSaid] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, start] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending) return;
    const input: RecordRequestInput = { clinicId, requestKey: key, kind, receivedOn, verifiedVia, ...(kind === "patient_request" ? { askedFor } : {}) };
    start(async () => {
      const result = await onRecord(input);
      if (!result.ok) {
        setSaid({ tone: "bad", text: result.message });
        return;
      }
      if ("status" in result.data) {
        setSaid({ tone: "bad", text: result.data.message });
        return;
      }
      setSaid({ tone: "ok", text: recordedWords(result.data) });
      // Recorded: the next request is a new one, under a new key.
      if (result.data.outcome === "recorded") setKey(newKey());
    });
  }

  return (
    <Section id="record" title="Record a request">
      {clinics === null || clinics.length === 0 ? (
        <p role="status" className="text-red-deep text-sm font-semibold">
          {NO_CLINICS}
        </p>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <p className="max-w-[68ch] text-sm">
            A request as it reached us, so its clock is tracked from today. Nothing about the person is recorded here.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">
              <span className={LABEL}>Clinic</span>
              <select name="clinicId" value={clinicId} onChange={(e) => setClinicId(e.target.value)} className={FIELD}>
                {clinics.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.synthetic ? " (synthetic)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className={LABEL}>What it asks for</span>
              <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as RightsKind)} className={FIELD}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {RIGHTS_KIND_WORDS[k]}
                  </option>
                ))}
              </select>
            </label>
            {kind === "patient_request" ? (
              <label className="grid gap-1 text-sm">
                <span className={LABEL}>What the patient asked for</span>
                <select name="askedFor" value={askedFor} onChange={(e) => setAskedFor(e.target.value as RightsAskedFor)} className={FIELD}>
                  {ASKED_FOR.map((a) => (
                    <option key={a} value={a}>
                      {ASKED_FOR_WORDS[a]}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="grid gap-1 text-sm">
              <span className={LABEL}>Day received</span>
              <input type="date" name="receivedOn" value={receivedOn} max={today} required onChange={(e) => setReceivedOn(e.target.value)} className={FIELD} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className={LABEL}>How it was verified</span>
              <select name="verifiedVia" value={verifiedVia} onChange={(e) => setVerifiedVia(e.target.value as RightsVerification)} className={FIELD}>
                {VERIFICATIONS.map((v) => (
                  <option key={v} value={v}>
                    {VERIFICATION_WORDS[v]}
                  </option>
                ))}
              </select>
            </label>
            <input type="hidden" name="requestKey" value={key} />
            <button
              type="submit"
              disabled={pending}
              aria-busy={pending || undefined}
              className="inline-flex min-h-9 items-center rounded-full bg-ink px-4 py-1.5 text-sm font-bold text-white transition-colors disabled:opacity-50"
            >
              {pending ? "Working…" : "Record a request"}
            </button>
          </div>
          {said ? (
            <p role="status" className={`text-sm ${said.tone === "ok" ? "text-done" : "text-red-deep font-semibold"}`}>
              {said.text}
            </p>
          ) : null}
        </form>
      )}
    </Section>
  );
}
