"use client";

import { useState, useTransition } from "react";

import type {
  OpsResult,
  PlatformAttestationOutcome,
  PlatformComplianceView,
  PlatformSubjectId,
} from "@/lib/admin/ops-client";

export type AttestationForm = {
  action: "attest" | "withdraw";
  subject: PlatformSubjectId;
  documentRef: string;
  effectiveOn: string;
  expiresOn?: string;
  code: string;
};

type Actions = {
  enter: (input: AttestationForm) => Promise<OpsResult<PlatformAttestationOutcome>>;
};

type Subject = PlatformComplianceView["subjects"][number];

/** "2026-10-09 14:32 UTC": the console's clock, as everywhere else in it. */
function utc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function standing(subject: Subject): { word: string; tone: "ok" | "bad" } {
  if (subject.attested) return { word: "Attested", tone: "ok" };
  if (subject.lapsed) return { word: "Lapsed", tone: "bad" };
  if (subject.latest?.action === "withdrawn") return { word: "Withdrawn", tone: "bad" };
  return { word: "Not attested", tone: "bad" };
}

export function CompliancePanel({
  view,
  openPromises,
  actions,
}: {
  view: OpsResult<PlatformComplianceView>;
  openPromises: { id: string; promise: string }[];
  actions: Actions;
}) {
  if (!view.ok) {
    return (
      <main className="mx-auto max-w-[1000px] px-5 py-10">
        <h1 className="font-display text-[28px] font-semibold tracking-[-0.02em]">Compliance</h1>
        <p className="text-red-deep mt-4 font-semibold">{view.message}</p>
      </main>
    );
  }
  const v = view.data;
  const vendors = v.subjects.filter((s) => s.kind === "vendor");
  const readiness = v.subjects.filter((s) => s.kind === "readiness");
  return (
    <main className="mx-auto max-w-[1000px] px-5 py-10 sm:px-8">
      <h1 className="font-display text-[32px] font-medium tracking-[-0.02em]">Compliance</h1>
      <p className="text-muted mt-2 max-w-[70ch] text-sm">
        Go-live is automatic: a clinic goes to production by itself once its own part is done and
        everything below that its channel needs is attested and built. A withdrawal never takes a
        live channel offline; it holds back what has not gone live yet. A business associate
        agreement withdrawn, or past its expiry with no renewal, also stops AYA answering where that
        vendor serves (every channel for the model provider, AWS and the database host; phone for
        Retell): calls go to each clinic&apos;s direct line until a renewal is recorded here. Each
        entry needs a fresh code from your authenticator. Days are UTC; today is {v.today}.
      </p>

      <Section title="Business associate agreements in the chain">
        <SubjectList subjects={vendors} actions={actions} openPromises={openPromises} />
      </Section>

      <Section title="Gate B: what a person confirms">
        <SubjectList subjects={readiness} actions={actions} openPromises={openPromises} />
      </Section>

      <Section title="Gate B: what the code holds">
        <ul className="grid gap-2 text-sm">
          {v.gateB.map((item) => (
            <li key={item.id} className="border-line rounded-sm border bg-white px-3 py-2">
              <p className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{item.label}</span>
                <span className={item.built ? "text-sm" : "text-red-deep text-sm font-semibold"}>
                  {item.built ? "Built" : "Not built: holds every go-live"}
                </span>
              </p>
              <p className="text-muted mt-1">{item.detail}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="History">
        {v.history.length === 0 ? (
          <p className="text-muted text-sm">Nothing has been attested yet.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {v.history.map((h, i) => (
              <li key={`${h.subject}-${h.recordedAt}-${i}`}>
                {utc(h.recordedAt)}:{" "}
                <span className="font-semibold">{h.subject.replace(/_/g, " ")}</span> {h.action} by{" "}
                {h.actorLabel}, effective {h.effectiveOn}
                {h.expiresOn ? `, until ${h.expiresOn}` : ""}. {h.documentRef}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-line mt-8 rounded-md border bg-white p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function SubjectList({
  subjects,
  actions,
  openPromises,
}: {
  subjects: Subject[];
  actions: Actions;
  openPromises: { id: string; promise: string }[];
}) {
  return (
    <ul className="grid gap-3">
      {subjects.map((s) => (
        <SubjectRow key={s.subject} subject={s} actions={actions} openPromises={openPromises} />
      ))}
    </ul>
  );
}

function SubjectRow({
  subject: s,
  actions,
  openPromises,
}: {
  subject: Subject;
  actions: Actions;
  openPromises: { id: string; promise: string }[];
}) {
  const { word, tone } = standing(s);
  const blocked = s.subject === "launch_promises" && openPromises.length > 0;
  return (
    <li className="border-line rounded-sm border px-4 py-3 text-sm">
      <p className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">{s.label}</span>
        <span className={tone === "ok" ? "font-semibold" : "text-red-deep font-semibold"}>
          {word}
        </span>
      </p>
      <p className="text-muted mt-1">
        {s.attests} Needed by: {s.needs}.
      </p>
      {s.latest ? (
        <p className="mt-1">
          Last {s.latest.action} by {s.latest.actorLabel} on {utc(s.latest.recordedAt)}, effective{" "}
          {s.latest.effectiveOn}
          {s.latest.expiresOn ? `, until ${s.latest.expiresOn}` : ""}: {s.latest.documentRef}
        </p>
      ) : null}
      {blocked ? (
        <div className="mt-2">
          <p className="text-red-deep font-semibold">
            Open on /admin/seo, each blocking go-live; this can&rsquo;t be attested until each is
            on:
          </p>
          <ul className="list-disc pl-5">
            {openPromises.map((p) => (
              <li key={p.id}>{p.promise}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <EntryForm subject={s} actions={actions} canAttest={!blocked} />
    </li>
  );
}

function EntryForm({
  subject,
  actions,
  canAttest,
}: {
  subject: Subject;
  actions: Actions;
  canAttest: boolean;
}) {
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const withdraw = subject.attested || subject.lapsed;
  if (!withdraw && !canAttest) return null;
  return (
    <form
      className="border-line mt-3 grid gap-3 border-t pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        // The button pressed: FormData built from the form alone leaves it out.
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        const action = submitter?.value === "withdraw" ? "withdraw" : "attest";
        start(async () => {
          const result = await actions.enter({
            action,
            subject: subject.subject,
            documentRef: String(form.get("documentRef") ?? ""),
            effectiveOn: String(form.get("effectiveOn") ?? ""),
            expiresOn: String(form.get("expiresOn") ?? ""),
            code: String(form.get("code") ?? ""),
          });
          if (!result.ok) return setNote({ tone: "bad", text: result.message });
          if (result.data.status !== "recorded")
            return setNote({ tone: "bad", text: result.data.message });
          setNote({
            tone: "ok",
            text: result.data.attested
              ? "Attested. Clinics waiting only on this go live at their next check, within the hour."
              : "Recorded. What has not gone live waits on it again; nothing live was taken offline.",
          });
        });
      }}
    >
      <label className="grid gap-1">
        <span className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">
          {withdraw
            ? "Why, or where it is recorded"
            : "Where the document is kept, or what the check was"}
        </span>
        <input
          name="documentRef"
          maxLength={300}
          required
          autoComplete="off"
          className="border-line rounded-sm border bg-white px-3 py-2.5"
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="grid gap-1">
          <span className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">
            Effective (UTC)
          </span>
          <input
            name="effectiveOn"
            type="date"
            required
            className="border-line rounded-sm border bg-white px-3 py-2"
          />
        </label>
        {canAttest ? (
          <label className="grid gap-1">
            <span className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">
              Lapses on (optional)
            </span>
            <input
              name="expiresOn"
              type="date"
              className="border-line rounded-sm border bg-white px-3 py-2"
            />
          </label>
        ) : null}
        <label className="grid gap-1">
          <span className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">
            Code from your authenticator
          </span>
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            className="border-line w-40 rounded-sm border bg-white px-3 py-2.5 font-mono"
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        {canAttest ? (
          <button
            type="submit"
            name="intent"
            value="attest"
            disabled={pending}
            className="bg-ink w-fit rounded-full px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
          >
            {pending ? "Recording…" : subject.attested ? "Attest again" : "Attest"}
          </button>
        ) : null}
        {withdraw ? (
          <button
            type="submit"
            name="intent"
            value="withdraw"
            disabled={pending}
            className="border-line-strong hover:border-ink w-fit rounded-full border px-5 py-2.5 text-sm font-bold disabled:opacity-50"
          >
            Withdraw
          </button>
        ) : null}
      </div>
      {note ? (
        <p
          role="status"
          className={note.tone === "bad" ? "text-red-deep font-semibold" : "font-semibold"}
        >
          {note.text}
        </p>
      ) : null}
    </form>
  );
}
