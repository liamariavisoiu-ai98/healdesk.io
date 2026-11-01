"use client";

import { useId, useState, type ReactNode } from "react";

import {
  HoursEditor,
  servicesPayload,
  ServicesEditor,
  WEEKDAY_HOURS,
  type ClosureRow,
  type HoursInitial,
  type ServiceRow,
} from "../editors";
import { useAnnounce } from "../feedback";

import { saveKnowledgeAction } from "./actions";

/**
 * Knowledge's sections (plan Part F3), each a short form with its own Save:
 * the practice, its policies, prices, promotions, quick answers, never-say
 * and hours. A save is announced in the page's one status region; a refused
 * one names the phrase (the server's message) and, where the same text
 * without that sentence passes, offers it: "Try this instead", one tap.
 */

type Problem = { field: string; message: string; rewrite?: string } | null;

function useKnowledgeSave(slug: string, section: string) {
  const announce = useAnnounce();
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  async function save(input: unknown): Promise<boolean> {
    setWorking(true);
    setProblem(null);
    try {
      const result = await saveKnowledgeAction(slug, section, input);
      if (result.ok) {
        announce({ text: result.toast, tone: "ok", ...(result.link ? { link: result.link } : {}) });
        return true;
      }
      announce({ text: result.message, tone: "problem" });
      setProblem({ field: result.field, message: result.message, rewrite: result.rewrite });
      return false;
    } catch {
      announce({
        text: "Something went wrong on our side. Try again in a moment.",
        tone: "problem",
      });
      return false;
    } finally {
      setWorking(false);
    }
  }
  return { save, working, problem, clearProblem: () => setProblem(null) };
}

function Section(props: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section
      id={props.id}
      aria-labelledby={`${props.id}-heading`}
      className="border-line scroll-mt-6 rounded-lg border bg-white px-4 py-4 shadow-sm sm:px-5"
    >
      <h2 id={`${props.id}-heading`} className="text-lg font-semibold">
        {props.title}
      </h2>
      {props.intro ? <div className="text-muted mt-1 text-sm">{props.intro}</div> : null}
      <div className="mt-3 grid gap-3">{props.children}</div>
    </section>
  );
}

function SaveRow(props: { working: boolean; label?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="submit"
        disabled={props.working}
        className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
      >
        {props.working ? "Saving…" : (props.label ?? "Save")}
      </button>
      {props.children}
    </div>
  );
}

/** The refusal beside the form, with the rewrite to take in one tap when there is one. */
function ProblemBox(props: { problem: Problem; onUse?: (rewrite: string) => void }) {
  if (!props.problem) return null;
  const { rewrite } = props.problem;
  return (
    <div className="rounded-md border border-problem-line px-4 py-3 text-sm text-problem">
      <p>{props.problem.message}</p>
      {rewrite && props.onUse ? (
        <div className="text-ink mt-2">
          <p>
            Try this instead: <q>{rewrite}</q>
          </p>
          <button
            type="button"
            onClick={() => props.onUse?.(rewrite)}
            className="border-line mt-2 min-h-11 rounded-full border bg-white px-4 font-semibold"
          >
            Use this
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TextInput(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  type?: "text" | "tel" | "url";
  inputMode?: "text" | "tel" | "url";
  autoComplete?: string;
  maxLength?: number;
  multiline?: boolean;
}) {
  const id = useId();
  const hintId = useId();
  const common = {
    id,
    value: props.value,
    maxLength: props.maxLength,
    "aria-describedby": props.hint ? hintId : undefined,
    className: "border-line w-full rounded-md border bg-white px-4 py-3 text-base",
  };
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-sm font-semibold">
        {props.label}
      </label>
      {props.multiline ? (
        <textarea {...common} rows={4} onChange={(e) => props.onChange(e.target.value)} />
      ) : (
        <input
          {...common}
          type={props.type ?? "text"}
          inputMode={props.inputMode}
          autoComplete={props.autoComplete ?? "off"}
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
      {props.hint ? (
        <p id={hintId} className="text-muted text-xs">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Your practice, and its policies
// -----------------------------------------------------------------------------

export function PracticeForm(props: {
  slug: string;
  initial: { name: string; address: string; phone: string; website: string; timezone: string };
  zones: readonly { id: string; label: string }[];
  /** Who calls the main number: a vet's clients, everyone else's patients. */
  audience: "patients" | "clients";
}) {
  const { save, working, problem } = useKnowledgeSave(props.slug, "practice");
  const [form, setForm] = useState(props.initial);
  const zoneId = useId();
  const zones = props.zones.some((z) => z.id === form.timezone)
    ? props.zones
    : [...props.zones, { id: form.timezone, label: form.timezone }];
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save(form);
      }}
      className="grid gap-3"
    >
      <TextInput
        label="Practice name"
        value={form.name}
        onChange={(name) => set({ name })}
        maxLength={120}
        autoComplete="organization"
      />
      <TextInput
        label="Address"
        hint="AYA gives it to anyone who asks where you are."
        value={form.address}
        onChange={(address) => set({ address })}
        maxLength={300}
        autoComplete="street-address"
      />
      <TextInput
        label="Main phone number"
        hint={`The number your ${props.audience} call. It can't be your direct line.`}
        value={form.phone}
        onChange={(phone) => set({ phone })}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
      />
      <TextInput
        label="Website"
        hint="Leave it empty if the practice has none."
        value={form.website}
        onChange={(website) => set({ website })}
        type="url"
        inputMode="url"
        maxLength={200}
      />
      <div className="grid gap-1">
        <label htmlFor={zoneId} className="text-sm font-semibold">
          Time zone
        </label>
        <select
          id={zoneId}
          value={form.timezone}
          onChange={(e) => set({ timezone: e.target.value })}
          className="border-line min-h-11 rounded-md border bg-white px-4 py-2"
        >
          {zones.map((zone) => (
            <option key={zone.id} value={zone.id}>
              {zone.label}
            </option>
          ))}
        </select>
      </div>
      <ProblemBox problem={problem} />
      <SaveRow working={working} />
    </form>
  );
}

/** A list of short texts, one per row, with add and remove. */
function ListEditor(props: {
  label: string;
  items: string[];
  onItems: (items: string[]) => void;
  addLabel: string;
  placeholder?: string;
  maxLength: number;
}) {
  return (
    <div className="grid gap-2">
      {props.items.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            aria-label={`${props.label} ${i + 1}`}
            value={item}
            maxLength={props.maxLength}
            placeholder={props.placeholder}
            onChange={(e) =>
              props.onItems(props.items.map((x, j) => (j === i ? e.target.value : x)))
            }
            className="border-line min-h-11 flex-1 rounded-md border bg-white px-3"
          />
          <button
            type="button"
            onClick={() => props.onItems(props.items.filter((_, j) => j !== i))}
            className="text-muted min-h-11 px-2 text-sm underline"
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => props.onItems([...props.items, ""])}
        className="border-line min-h-11 w-fit rounded-full border px-4 text-sm font-semibold"
      >
        {props.addLabel}
      </button>
    </div>
  );
}

export function PoliciesForm(props: { slug: string; initial: string[] }) {
  const { save, working, problem, clearProblem } = useKnowledgeSave(props.slug, "policies");
  const [items, setItems] = useState(props.initial);
  const index = problem ? /^policies\[(\d+)\]$/.exec(problem.field)?.[1] : undefined;
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save({ policies: items.filter((p) => p.trim() !== "") });
      }}
      className="grid gap-3"
    >
      <ListEditor
        label="Policy"
        items={items}
        onItems={setItems}
        addLabel="Add a policy"
        placeholder="e.g. 24 hours' notice to cancel, or the deposit is kept"
        maxLength={300}
      />
      <ProblemBox
        problem={problem}
        onUse={
          index === undefined
            ? undefined
            : (rewrite) => {
                const kept = items.filter((p) => p.trim() !== "");
                kept[Number(index)] = rewrite;
                setItems(kept);
                clearProblem();
              }
        }
      />
      <SaveRow working={working} label="Save policies" />
    </form>
  );
}

// -----------------------------------------------------------------------------
// Prices
// -----------------------------------------------------------------------------

export function PricesForm(props: { slug: string; initial: ServiceRow[] }) {
  const { save, working, problem } = useKnowledgeSave(props.slug, "prices");
  const [rows, setRows] = useState(props.initial);
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save({ services: servicesPayload(rows, true) });
      }}
      className="grid gap-3"
    >
      <ServicesEditor rows={rows} onRows={setRows} withDeposit />
      <ProblemBox problem={problem} />
      <SaveRow working={working} label="Save prices" />
    </form>
  );
}

// -----------------------------------------------------------------------------
// Promotions
// -----------------------------------------------------------------------------

export function PromotionsForm(props: { slug: string; initial: string }) {
  const { save, working, problem, clearProblem } = useKnowledgeSave(props.slug, "promotions");
  const [text, setText] = useState(props.initial);
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save({ promotions: text });
      }}
      className="grid gap-3"
    >
      <TextInput
        label="What AYA may offer"
        hint="Empty means no promotions. One offer per line reads best."
        value={text}
        onChange={setText}
        maxLength={1000}
        multiline
      />
      <ProblemBox
        problem={problem}
        onUse={(rewrite) => {
          setText(rewrite);
          clearProblem();
        }}
      />
      <SaveRow working={working} label="Save promotions" />
    </form>
  );
}

// -----------------------------------------------------------------------------
// Quick answers
// -----------------------------------------------------------------------------

/** `flagId`: the row is a correction from Flag this answer, kept through every save. */
type Answer = { question: string; answer: string; flagId?: string };

export function QuickAnswersForm(props: { slug: string; initial: Answer[] }) {
  const { save, working, problem, clearProblem } = useKnowledgeSave(props.slug, "quick_answers");
  const [rows, setRows] = useState<Answer[]>(props.initial);
  const filled = () => rows.filter((r) => r.question.trim() !== "" || r.answer.trim() !== "");
  const target = problem ? /^quickAnswers\[(\d+)\]\.(question|answer)$/.exec(problem.field) : null;
  const update = (i: number, patch: Partial<Answer>) =>
    setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const kept = filled();
        setRows(kept);
        void save({ quickAnswers: kept });
      }}
      className="grid gap-3"
    >
      {rows.map((row, i) => (
        <fieldset key={i} className="border-line grid gap-2 rounded-md border px-4 py-3">
          <legend className="sr-only">Quick answer {i + 1}</legend>
          {row.flagId ? (
            <p className="text-muted text-sm font-semibold">From a flagged conversation</p>
          ) : null}
          <input
            aria-label={`Question ${i + 1}`}
            placeholder="The question, e.g. Where do I park?"
            value={row.question}
            maxLength={300}
            onChange={(e) => update(i, { question: e.target.value })}
            className="border-line min-h-11 rounded-sm border px-3 font-semibold"
          />
          <textarea
            aria-label={`Answer ${i + 1}`}
            placeholder="Your answer"
            value={row.answer}
            maxLength={300}
            rows={2}
            onChange={(e) => update(i, { answer: e.target.value })}
            className="border-line rounded-sm border px-3 py-2"
          />
          <button
            type="button"
            onClick={() => setRows((list) => list.filter((_, j) => j !== i))}
            className="text-muted min-h-11 w-fit text-sm underline"
          >
            Remove
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        onClick={() => setRows((list) => [...list, { question: "", answer: "" }])}
        className="border-line min-h-11 w-fit rounded-full border px-4 text-sm font-semibold"
      >
        Add a quick answer
      </button>
      <ProblemBox
        problem={problem}
        onUse={
          target
            ? (rewrite) => {
                update(Number(target[1]), { [target[2] as "question" | "answer"]: rewrite });
                clearProblem();
              }
            : undefined
        }
      />
      <SaveRow working={working} label="Save quick answers" />
    </form>
  );
}

// -----------------------------------------------------------------------------
// Never say
// -----------------------------------------------------------------------------

export function NeverSayForm(props: { slug: string; initial: string[] }) {
  const { save, working, problem } = useKnowledgeSave(props.slug, "never_say");
  const restore = useKnowledgeSave(props.slug, "never_say_defaults");
  const [items, setItems] = useState(props.initial);
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save({ neverSay: items.filter((p) => p.trim() !== "") });
      }}
      className="grid gap-3"
    >
      <ListEditor
        label="Phrase"
        items={items}
        onItems={setItems}
        addLabel="Add a phrase"
        placeholder="e.g. cheapest in town"
        maxLength={120}
      />
      <ProblemBox problem={problem ?? restore.problem} />
      <SaveRow working={working || restore.working} label="Save the list">
        <button
          type="button"
          disabled={working || restore.working}
          onClick={async () => {
            if (await restore.save({})) window.location.reload();
          }}
          className="border-line min-h-11 rounded-full border px-5 text-sm font-semibold disabled:opacity-50"
        >
          Restore the defaults
        </button>
      </SaveRow>
    </form>
  );
}

// -----------------------------------------------------------------------------
// Hours
// -----------------------------------------------------------------------------

export function HoursForm(props: {
  slug: string;
  /** Null when the practice has no hours on file: weekdays, 9 to 5, as setup starts. */
  initial: HoursInitial | null;
  closures: ClosureRow[];
  today: string;
}) {
  const { save, working, problem } = useKnowledgeSave(props.slug, "hours");
  const [hours, setHours] = useState<HoursInitial>(props.initial ?? WEEKDAY_HOURS);
  const [closures, setClosures] = useState(props.closures);
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save({ hours, closures: closures.filter((c) => c.closedOn) });
      }}
      className="grid gap-4"
    >
      <HoursEditor
        hours={hours}
        onHours={setHours}
        closures={closures}
        onClosures={setClosures}
        today={props.today}
        closuresHeading="h3"
      />
      <ProblemBox problem={problem} />
      <SaveRow working={working} label="Save hours" />
    </form>
  );
}

export { Section };
