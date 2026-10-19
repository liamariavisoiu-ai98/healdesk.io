"use client";

import {
  annualTotalUsd,
  DEFAULT_STEPS,
  getPlan,
  PACKAGES,
  planIdFor,
  USAGE_STEPS,
  type PackageId,
} from "@healdesk/catalog";
import { useId, useState } from "react";

import { useAnnounce } from "../feedback";

import {
  addLocationAction,
  changePlanAction,
  openStripePortalAction,
  previewLocationAction,
  previewPlanAction,
  saveBillingSwitchAction,
  startAgreementResignAction,
  type BillingActionResult,
  type PlanPreview,
} from "./actions";

/**
 * Billing's controls (plan Part F6): the three switches, changing the plan,
 * adding a location, and Stripe's portal for the card and invoices. Every
 * amount charged is shown from the server (Package C's previews); the one
 * price worked out here is a plan's list price, and the catalog works it out.
 */

function useBillingAnnounce() {
  const announce = useAnnounce();
  return (result: BillingActionResult) =>
    announce(
      result.ok
        ? { text: result.toast, tone: "ok" }
        : { text: result.message, tone: "problem", stepUpHref: result.stepUpHref },
    );
}

const SOMETHING_WRONG = "Something went wrong on our side. Try again in a moment.";
const FAILED: BillingActionResult = { ok: false, message: SOMETHING_WRONG };

// -----------------------------------------------------------------------------
// The three switches
// -----------------------------------------------------------------------------

export function BillingSwitch(props: {
  slug: string;
  settingKey: "usage_alerts" | "auto_renew";
  label: string;
  line: string;
  /** The line under it while it is off, when that differs (auto-renew before the start). */
  offLine?: string;
  initial: boolean;
}) {
  const say = useBillingAnnounce();
  const [on, setOn] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const labelId = useId();
  const lineId = useId();

  async function toggle() {
    const next = !on;
    setBusy(true);
    let result: BillingActionResult;
    try {
      result = await saveBillingSwitchAction(props.slug, props.settingKey, next);
    } catch {
      result = FAILED;
    }
    say(result);
    if (result.ok) setOn(next);
    setBusy(false);
  }

  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <p id={labelId} className="font-semibold">
          {props.label}
        </p>
        <p id={lineId} className="text-muted mt-1 text-sm">
          {!on && props.offLine ? props.offLine : props.line}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={labelId}
        aria-describedby={lineId}
        disabled={busy}
        onClick={() => void toggle()}
        className="flex min-h-11 shrink-0 items-center gap-2 rounded-full px-1 disabled:opacity-50"
      >
        <span className="w-7 text-right text-sm font-semibold">{on ? "On" : "Off"}</span>
        <span
          aria-hidden="true"
          className={`flex h-7 w-12 items-center rounded-full p-0.5 transition-colors ${
            on ? "bg-green justify-end" : "bg-line-strong justify-start"
          }`}
        >
          <span className="block h-6 w-6 rounded-full bg-white shadow" />
        </span>
      </button>
    </div>
  );
}

export function AllowanceChoice(props: { slug: string; initial: "allow" | "hard_cap" }) {
  const say = useBillingAnnounce();
  const [value, setValue] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const name = useId();

  async function choose(next: "allow" | "hard_cap") {
    if (next === value) return;
    setBusy(true);
    let result: BillingActionResult;
    try {
      result = await saveBillingSwitchAction(props.slug, "overage_mode", next);
    } catch {
      result = FAILED;
    }
    say(result);
    if (result.ok) setValue(next);
    setBusy(false);
  }

  const options = [
    {
      id: "allow" as const,
      label: "Keep going and bill the extra",
      line: "AYA keeps answering. Each started block of 100 extra minutes or conversations is billed at its price under Usage.",
    },
    {
      id: "hard_cap" as const,
      label: "Stop and fall back",
      line: "Calls go to your direct line and website chat shows a contact form until the allowance renews, rather than a surprise invoice.",
    },
  ];
  return (
    <fieldset className="grid gap-2 py-3">
      <legend className="font-semibold">When the monthly allowance runs out</legend>
      {options.map((option) => {
        const id = `${name}-${option.id}`;
        return (
          <label
            key={option.id}
            htmlFor={id}
            className="border-line flex min-h-11 cursor-pointer gap-3 rounded-xl border bg-white px-4 py-3"
          >
            <input
              id={id}
              type="radio"
              name={name}
              checked={value === option.id}
              disabled={busy}
              onChange={() => void choose(option.id)}
              className="mt-1 h-5 w-5 shrink-0"
            />
            <span>
              <span className="block font-semibold">{option.label}</span>
              <span className="text-muted block text-sm">{option.line}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

// -----------------------------------------------------------------------------
// Changing the plan
// -----------------------------------------------------------------------------

/** A plan and how it is billed: the current one, or a change in flight. */
export type PlanChoice = { planId: string; interval: "month" | "year" };

/** The channels each product answers on, in the portal's words. */
const PRODUCT_CHANNELS: Record<"voice" | "webchat" | "metachat", string> = {
  voice: "Phone",
  webchat: "Website chat",
  metachat: "Instagram, Messenger, WhatsApp and website chat",
};

/**
 * Changing the plan (the pricing sheet of 13 October 2026): a package, then a
 * step for each thing it meters, voice minutes and chat conversations, 100 to
 * 1,500 in steps of 100. The choice names one catalog plan (planIdFor), and
 * that plan id is what the preview and the change are asked about, exactly as
 * when the screen listed the seven fixed packages: a step change within a
 * package and a change of package are the same action, and the setup-fee
 * difference (none between steps of one package) is the preview's to say.
 *
 * The list price beside the choice is the catalog's own; what would actually
 * be charged comes from Stripe's preview, after "See what it costs". A change
 * in flight starts selected, and is finished by previewing it again, never
 * greyed out.
 */
export function ChangePlan(props: {
  slug: string;
  /** Whether the plan has started: before it, the new price starts with the plan. */
  isStarted: boolean;
  current: PlanChoice;
  pending: PlanChoice | null;
}) {
  const say = useBillingAnnounce();
  const from = getPlan((props.pending ?? props.current).planId);
  const [interval, setInterval] = useState(props.pending?.interval ?? props.current.interval);
  const [packageId, setPackageId] = useState<PackageId>(from?.packageId ?? "voice");
  const [voiceMinutes, setVoiceMinutes] = useState<number>(
    from?.includedVoiceMinutes || DEFAULT_STEPS.voiceMinutes,
  );
  const [chatConversations, setChatConversations] = useState<number>(
    from?.includedChatConversations || DEFAULT_STEPS.chatConversations,
  );
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [asked, setAsked] = useState<PlanChoice | null>(null);
  const [working, setWorking] = useState(false);
  const name = useId();

  const pkg = PACKAGES.find((p) => p.id === packageId) ?? PACKAGES[0]!;
  const plan = getPlan(
    planIdFor(pkg.id, {
      voiceMinutes: pkg.voice ? voiceMinutes : undefined,
      chatConversations: pkg.chat ? chatConversations : undefined,
    }),
  )!;
  const same = (choice: PlanChoice | null) =>
    choice !== null && choice.planId === plan.id && choice.interval === interval;
  const isCurrent = same(props.current);
  const isPending = same(props.pending);
  const currentPackage = getPlan(props.current.planId)?.packageId ?? null;
  const price =
    interval === "year"
      ? `${money(annualTotalUsd(plan) * 100)} a year (${money(plan.annualMonthlyUsd * 100)} a month)`
      : `${money(plan.monthlyUsd * 100)} a month`;

  /** Any change of choice drops a preview that was for another plan. */
  function changed(apply: () => void) {
    apply();
    setPreview(null);
    setAsked(null);
  }

  async function ask() {
    const choice = { planId: plan.id, interval };
    setAsked(choice);
    setPreview(null);
    setWorking(true);
    try {
      setPreview(await previewPlanAction(props.slug, choice.planId, choice.interval));
    } catch {
      setPreview({ status: "not_available", message: SOMETHING_WRONG });
    }
    setWorking(false);
  }

  async function confirm() {
    if (!asked || !preview || preview.status !== "ok") return;
    setWorking(true);
    let result: BillingActionResult;
    try {
      result = await changePlanAction(props.slug, {
        planId: asked.planId,
        interval: asked.interval,
        requestId: preview.requestId,
      });
    } catch {
      result = FAILED;
    }
    say(result);
    setWorking(false);
    if (result.ok) {
      if (result.href) window.open(result.href, "_blank", "noopener,noreferrer");
      window.location.reload();
    }
  }

  const stepSelect = (
    label: string,
    unit: string,
    value: number,
    set: (n: number) => void,
  ) => {
    const id = `${name}-${unit}`;
    return (
      <label htmlFor={id} className="grid gap-1 text-sm">
        <span className="font-semibold">{label}</span>
        <select
          id={id}
          value={value}
          disabled={working}
          onChange={(e) => changed(() => set(Number(e.target.value)))}
          className="border-line min-h-11 rounded-xl border bg-white px-3"
        >
          {USAGE_STEPS.map((step) => (
            <option key={step} value={step}>
              {step.toLocaleString("en-US")} {unit}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <div className="grid gap-3 py-3">
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Billed</legend>
        {(["month", "year"] as const).map((i) => (
          <label
            key={i}
            className="border-line flex min-h-11 items-center gap-2 rounded-full border px-4"
          >
            <input
              type="radio"
              name={`${name}-interval`}
              checked={interval === i}
              disabled={working}
              onChange={() => changed(() => setInterval(i))}
              className="h-5 w-5"
            />
            {i === "month" ? "Monthly" : "Annual"}
          </label>
        ))}
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="font-semibold">Package</legend>
        {PACKAGES.map((option) => {
          const id = `${name}-${option.id}`;
          const products = [
            ...(option.voice ? [PRODUCT_CHANNELS.voice] : []),
            ...(option.chat ? [PRODUCT_CHANNELS[option.chat]] : []),
          ];
          return (
            <label
              key={option.id}
              htmlFor={id}
              className="border-line flex min-h-11 cursor-pointer gap-3 rounded-xl border bg-white px-4 py-3"
            >
              <input
                id={id}
                type="radio"
                name={`${name}-package`}
                checked={packageId === option.id}
                disabled={working}
                onChange={() => changed(() => setPackageId(option.id))}
                className="mt-1 h-5 w-5 shrink-0"
              />
              <span>
                <span className="block font-semibold">
                  {option.name}
                  {option.id === currentPackage ? " · your package" : ""}
                </span>
                <span className="text-muted block text-sm">{products.join(" · ")}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        {pkg.voice
          ? stepSelect("Voice minutes a month", "minutes", voiceMinutes, setVoiceMinutes)
          : null}
        {pkg.chat
          ? stepSelect(
              "Chat conversations a month",
              "conversations",
              chatConversations,
              setChatConversations,
            )
          : null}
      </div>
      <div className="border-line rounded-xl border px-4 py-3 text-sm">
        <p className="font-semibold">
          {plan.name}
          {isCurrent ? " · your plan" : ""}
          {isPending ? " · being changed to" : ""}
        </p>
        <p className="text-muted mt-1">{price} at list price, per location.</p>
        <button
          type="button"
          disabled={working || (isCurrent && !isPending)}
          onClick={() => void ask()}
          className="border-line mt-3 min-h-11 rounded-full border px-5 font-semibold disabled:opacity-50"
        >
          {isCurrent && !isPending ? "This is your plan" : "See what it costs"}
        </button>
      </div>
      {preview ? (
        <div className="border-line rounded-xl border px-4 py-3 text-sm" role="status">
          {preview.status === "ok" ? (
            <>
              <p className="font-semibold">
                {preview.setupFeeDeltaCents > 0
                  ? `Setup fee difference: ${money(preview.setupFeeDeltaCents)}, charged now.`
                  : "No setup fee difference to pay."}
              </p>
              {preview.prorationCents > 0 ? (
                <p className="mt-1">
                  {money(preview.prorationCents)} now for the rest of this billing period.
                </p>
              ) : null}
              <p className="mt-1">
                {props.isStarted
                  ? `Then ${money(preview.recurringCents)} ${asked?.interval === "year" ? "a year" : "a month"} from your next renewal.`
                  : `${asked?.interval === "year" ? "Annual" : "Monthly"} billing (${money(preview.recurringCents)}) starts the day AYA first answers, at the price of the channels in service then.`}
              </p>
              {preview.droppedChannels.length > 0 ? (
                <p className="mt-1 font-semibold text-red-800">
                  A channel that&rsquo;s answering now isn&rsquo;t in this plan: its calls and
                  messages would go to your team.
                </p>
              ) : null}
              {preview.isInProgress ? (
                <p className="mt-1">
                  This change was started before and didn&rsquo;t finish. Confirming finishes it,
                  and nothing is charged twice.
                </p>
              ) : null}
              <p className="text-muted mt-1">
                Changing the plan needs Face ID or your screen lock.
              </p>
              <button
                type="button"
                disabled={working}
                onClick={() => void confirm()}
                className="bg-ink mt-3 min-h-11 rounded-full px-5 font-bold text-white disabled:opacity-50"
              >
                {working
                  ? "Changing…"
                  : preview.isInProgress
                    ? "Finish this change"
                    : "Change my plan"}
              </button>
            </>
          ) : (
            <p>{preview.message}</p>
          )}
        </div>
      ) : working ? (
        <p className="text-muted text-sm" role="status">
          Asking Stripe what this costs…
        </p>
      ) : null}
    </div>
  );
}

function money(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}

// -----------------------------------------------------------------------------
// Adding a location
// -----------------------------------------------------------------------------

export function AddLocation(props: { slug: string; interval: "month" | "year" }) {
  const say = useBillingAnnounce();
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewLocationAction>> | null>(
    null,
  );
  const [label, setLabel] = useState("");
  const [working, setWorking] = useState(false);
  const labelId = useId();

  async function ask() {
    setWorking(true);
    try {
      setPreview(await previewLocationAction(props.slug));
    } catch {
      setPreview({ status: "not_available", message: SOMETHING_WRONG });
    }
    setWorking(false);
  }

  async function confirm() {
    if (!preview || preview.status !== "ok") return;
    setWorking(true);
    let result: BillingActionResult;
    try {
      result = await addLocationAction(props.slug, { requestId: preview.requestId, name: label });
    } catch {
      result = FAILED;
    }
    say(result);
    setWorking(false);
    if (result.ok && result.href) window.location.assign(result.href);
  }

  if (!preview) {
    return (
      <button
        type="button"
        disabled={working}
        onClick={() => void ask()}
        className="border-line mt-3 min-h-11 rounded-full border px-5 text-sm font-semibold disabled:opacity-50"
      >
        {working ? "Asking Stripe…" : "Add a location"}
      </button>
    );
  }
  if (preview.status !== "ok") {
    return (
      <p className="mt-3 text-sm" role="status">
        {preview.message}
      </p>
    );
  }
  return (
    <div className="border-line mt-3 grid gap-2 rounded-xl border px-4 py-3 text-sm" role="status">
      <p className="font-semibold">
        {money(preview.setupFeeCents)} setup fee now, then {money(preview.recurringCents)}{" "}
        {props.interval === "year" ? "a year" : "a month"} for the location.
      </p>
      {preview.prorationCents > 0 ? (
        <p>{money(preview.prorationCents)} now for the rest of this billing period.</p>
      ) : null}
      <label htmlFor={labelId} className="font-semibold">
        What should we call it?
      </label>
      <input
        id={labelId}
        value={label}
        maxLength={120}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="e.g. Uptown"
        className="border-line min-h-11 rounded-xl border px-3"
      />
      <p className="text-muted">Adding it needs Face ID or your screen lock.</p>
      <button
        type="button"
        disabled={working}
        onClick={() => void confirm()}
        className="bg-ink min-h-11 w-fit rounded-full px-5 font-bold text-white disabled:opacity-50"
      >
        {working ? "Adding…" : "Add the location"}
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Stripe's portal
// -----------------------------------------------------------------------------

export function StripePortalButton(props: {
  slug: string;
  flow: "payment_method_update" | null;
  label: string;
}) {
  const say = useBillingAnnounce();
  const [working, setWorking] = useState(false);
  async function open() {
    setWorking(true);
    let result: BillingActionResult;
    try {
      result = await openStripePortalAction(props.slug, props.flow);
    } catch {
      result = FAILED;
    }
    if (result.ok && result.href) {
      window.location.assign(result.href);
      return;
    }
    say(result);
    setWorking(false);
  }
  return (
    <button
      type="button"
      disabled={working}
      onClick={() => void open()}
      className="border-line min-h-11 rounded-full border px-5 text-sm font-semibold disabled:opacity-50"
    >
      {working ? "Opening Stripe…" : props.label}
    </button>
  );
}

// -----------------------------------------------------------------------------
// The agreement: a DPA practice that now bills insurance (plan Part L)
// -----------------------------------------------------------------------------

/**
 * "We've started billing insurance electronically", and, once that re-sign is
 * open, "Sign your updated agreement". The first asks once more before it
 * acts, because it pauses AYA on every channel until the agreement is signed.
 * Both need a passkey step-up, and both land on the agreement to sign.
 */
export function AgreementResignButton(props: { slug: string; open: boolean }) {
  const say = useBillingAnnounce();
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  async function go() {
    setWorking(true);
    let result: BillingActionResult;
    try {
      result = await startAgreementResignAction(props.slug);
    } catch {
      result = FAILED;
    }
    say(result);
    if (result.ok && result.href) {
      window.location.assign(result.href);
      return;
    }
    setWorking(false);
    setConfirming(false);
  }

  if (props.open) {
    return (
      <button
        type="button"
        disabled={working}
        onClick={() => void go()}
        className="bg-ink mt-3 min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
      >
        {working ? "Opening…" : "Sign your updated agreement"}
      </button>
    );
  }
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="border-line mt-3 min-h-11 rounded-full border px-5 text-sm font-semibold"
      >
        We&rsquo;ve started billing insurance electronically
      </button>
    );
  }
  return (
    <div className="border-line mt-3 rounded-xl border px-4 py-3 text-sm">
      <p>
        Your agreement becomes a business associate agreement, which you sign next. Until it&rsquo;s
        signed, AYA is paused: calls go to your direct line, website chat shows a contact form, and
        messages wait for your team.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={working}
          onClick={() => void go()}
          className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
        >
          {working ? "Recording…" : "Yes, we bill insurance electronically"}
        </button>
        <button
          type="button"
          disabled={working}
          onClick={() => setConfirming(false)}
          className="border-line min-h-11 rounded-full border px-5 text-sm font-semibold"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
