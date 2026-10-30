"use client";

import { useState } from "react";

import { GREETING_LABELS } from "@/lib/setup/greetings";
import type { SetupStripeView } from "@/lib/setup/payments";

import type { SwitchRule } from "@/lib/portal/switch-rules";

import {
  FullPaymentExplainer,
  PAYMENT_ASK_LINE,
  TEXT_LINK_LINE,
  TextLinkExplainer,
} from "../../settings/payment-explainers";
import type { UnlockTargets } from "../../settings/SwitchExplainer";
import { ToggleRow } from "../../settings/ToggleRow";
import { Choice, Field, ScreenShell } from "../ScreenShell";

/**
 * Step 2 · How AYA works (plan Part E): 2.1 tone and greetings, 2.2 which
 * calls reach AYA and 2.3 the direct line (phone only), 2.4 deposits, and 2.5
 * the urgent-help number and where alerts go.
 */

type Common = { slug: string; backHref: string | null; skipCost: string };

// -----------------------------------------------------------------------------
// 2.1 Tone and greetings
// -----------------------------------------------------------------------------

export type GreetingProps = {
  /** "phone" or "chat": which greeting this is. */
  kind: "phone" | "chat";
  /** The locked AI line said before it, which the clinic cannot edit. */
  lockedLine: string;
  /** The greeting as it stands: the clinic's own, or the default. */
  text: string;
  isDefault: boolean;
  /** Said beside it: for the chat greeting, that the Meta channels don't use it. */
  note?: string | null;
};

export function ToneScreen(
  props: Common & {
    tone: "warm" | "clinical";
    toneOptions: readonly { id: "warm" | "clinical"; label: string; line: string }[];
    greetings: readonly GreetingProps[];
  },
) {
  const [tone, setTone] = useState(props.tone);
  const [texts, setTexts] = useState<Record<string, string>>(
    Object.fromEntries(props.greetings.map((g) => [g.kind, g.text])),
  );
  const [editing, setEditing] = useState<Record<string, boolean>>({});

  return (
    <ScreenShell
      slug={props.slug}
      screen="tone"
      title="How AYA sounds"
      intro={<p>Pick the tone, and check the first thing people hear or read.</p>}
      skipCost={props.skipCost}
      backHref={props.backHref}
      payload={() => {
        const out: Record<string, unknown> = { tone };
        for (const g of props.greetings) {
          // Only a greeting the clinic opened and changed is its own; an
          // untouched default stays the default, which follows the name.
          const text = texts[g.kind] ?? g.text;
          const changed = editing[g.kind] && text.trim() !== g.text.trim();
          if (changed || !g.isDefault) {
            out[g.kind === "phone" ? "phoneGreeting" : "chatGreeting"] = text;
          }
        }
        return out;
      }}
    >
      <Choice legend="Tone" value={tone} onChange={setTone} options={props.toneOptions} />
      {props.greetings.map((g) => (
        <div key={g.kind} className="grid gap-2">
          <h2 className="text-sm font-semibold">
            {g.kind === "phone" ? GREETING_LABELS.phone : GREETING_LABELS.chat}
          </h2>
          <p className="text-muted rounded-md border border-line bg-paper-2 px-4 py-3 text-sm">
            {g.lockedLine}
            <span className="mt-1 block text-xs">
              Always said first, on every {g.kind === "phone" ? "call" : "website chat"}. It
              can&rsquo;t be changed.
            </span>
          </p>
          {g.note ? <p className="text-muted text-sm">{g.note}</p> : null}
          {editing[g.kind] ? (
            <Field
              label={g.kind === "phone" ? "Then AYA says" : "Then AYA writes"}
              value={texts[g.kind] ?? ""}
              onChange={(value) => setTexts((t) => ({ ...t, [g.kind]: value }))}
              maxLength={300}
              multiline
            />
          ) : (
            <div className="rounded-md border border-line bg-white px-4 py-3">
              <p>{texts[g.kind]}</p>
              <button
                type="button"
                onClick={() => setEditing((e) => ({ ...e, [g.kind]: true }))}
                className="mt-2 min-h-11 text-sm font-semibold underline"
              >
                Edit
              </button>
            </div>
          )}
        </div>
      ))}
    </ScreenShell>
  );
}

// -----------------------------------------------------------------------------
// 2.2 Which calls reach AYA
// -----------------------------------------------------------------------------

export function CoverageScreen(
  props: Common & {
    coverageMode: "all_calls" | "overflow_after_hours" | "after_hours_only";
    options: readonly {
      id: "all_calls" | "overflow_after_hours" | "after_hours_only";
      label: string;
      line: string;
    }[];
    landlineNote: string;
  },
) {
  const [mode, setMode] = useState(props.coverageMode);
  return (
    <ScreenShell
      slug={props.slug}
      screen="coverage"
      title="Which calls reach AYA?"
      intro={
        <p>
          You keep your number. Later you set call forwarding on it, and the steps match what you
          choose here. You can change it any time.
        </p>
      }
      skipCost={props.skipCost}
      backHref={props.backHref}
      payload={() => ({ coverageMode: mode })}
    >
      <Choice
        legend="Calls that reach AYA"
        value={mode}
        onChange={setMode}
        options={props.options.map((o) =>
          o.id === "overflow_after_hours" ? { ...o, label: `${o.label} (recommended)` } : o,
        )}
      />
      {mode === "after_hours_only" ? (
        <p className="text-muted text-sm">{props.landlineNote}</p>
      ) : null}
    </ScreenShell>
  );
}

// -----------------------------------------------------------------------------
// 2.3 The direct line
// -----------------------------------------------------------------------------

export function DirectLineScreen(props: Common & { directLine: string; isSet: boolean }) {
  const [line, setLine] = useState(props.directLine);
  return (
    <ScreenShell
      slug={props.slug}
      screen="direct_line"
      title="Your direct line"
      intro={
        <>
          <p>
            A second line or a manager&rsquo;s mobile: a number that rings a person and is never
            forwarded to AYA. Whenever AYA can&rsquo;t answer, because you paused her or something
            failed, calls go here, so nobody calling you is left without someone to reach.
          </p>
          <p>AYA also gives this number to someone reporting something urgent.</p>
          {props.isSet ? (
            <p>
              Changing it later needs Face ID or your screen lock on a device you&rsquo;ve added.
            </p>
          ) : null}
        </>
      }
      skipCost={props.skipCost}
      backHref={props.backHref}
      payload={() => ({ directLine: line })}
    >
      <Field
        label="Direct line"
        hint="Not your main number: calls to that one will forward to AYA."
        value={line}
        onChange={setLine}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
      />
    </ScreenShell>
  );
}

// -----------------------------------------------------------------------------
// 2.4 Deposits
// -----------------------------------------------------------------------------

export function DepositsScreen(
  props: Common & {
    services: readonly { name: string; depositUsd: number | null }[];
    collectionLine: string;
    /** The payment account, for a package with a chat channel. */
    stripe?: SetupStripeView;
    /**
     * The text and full-payment switches, from `switchRules` (the same answer
     * Settings reads). Absent: neither is shown. `voice` is whether phone was bought.
     */
    paymentSwitches?: {
      voice: boolean;
      text: SwitchRule;
      full: SwitchRule;
      targets: UnlockTargets;
      /** What the clinic has saved now, so reopening shows it and saving keeps it. */
      textPaymentLink: boolean;
      paymentAsk: "deposit_only" | "full_payment";
    };
  },
) {
  const switches = props.paymentSwitches;
  const [textLink, setTextLink] = useState(switches?.textPaymentLink ?? false);
  const [paymentAsk, setPaymentAsk] = useState<"deposit_only" | "full_payment">(
    switches?.paymentAsk ?? "deposit_only",
  );
  const anyDeposit = props.services.some((s) => (s.depositUsd ?? 0) > 0);
  const [needs, setNeeds] = useState<"no" | "yes">(anyDeposit ? "yes" : "no");
  const [amounts, setAmounts] = useState<Record<string, string>>(
    Object.fromEntries(
      props.services.map((s) => [s.name, s.depositUsd ? String(s.depositUsd) : ""]),
    ),
  );
  return (
    <ScreenShell
      slug={props.slug}
      screen="deposits"
      title="Do any treatments need a deposit?"
      intro={<p>{props.collectionLine}</p>}
      lead={props.stripe?.offered ? <StripeConnect stripe={props.stripe} /> : undefined}
      skipCost={props.skipCost}
      backHref={props.backHref}
      payload={() => ({
        needsDeposits: needs === "yes",
        deposits: Object.fromEntries(
          Object.entries(amounts).map(([name, value]) => [
            name,
            value.trim() === "" ? null : Number(value.replace(/[$,\s]/g, "")),
          ]),
        ),
        // Only what the clinic changed is sent: absent means unchanged, so a
        // re-save never resets a stored choice (the server holds the rules).
        ...(switches && textLink !== switches.textPaymentLink ? { textPaymentLink: textLink } : {}),
        ...(switches && paymentAsk !== switches.paymentAsk ? { paymentAsk } : {}),
      })}
    >
      <Choice
        legend="Deposits"
        value={needs}
        onChange={setNeeds}
        options={[
          { id: "no", label: "No", line: "AYA books without asking for one." },
          {
            id: "yes",
            label: "Yes, for some treatments",
            line: "Set the amount for each one below.",
          },
        ]}
      />
      {needs === "yes" ? (
        props.services.length === 0 ? (
          <p className="text-muted text-sm">
            Add your services first, in step 1, then set their deposits here.
          </p>
        ) : (
          <div className="grid gap-2">
            {props.services.map((service) => (
              <label
                key={service.name}
                className="border-line flex min-h-11 items-center justify-between gap-3 rounded-md border bg-white px-4 py-2"
              >
                <span className="font-semibold">{service.name}</span>
                <span className="flex items-center gap-1">
                  $
                  <input
                    inputMode="decimal"
                    aria-label={`Deposit for ${service.name}, in dollars`}
                    placeholder="None"
                    value={amounts[service.name] ?? ""}
                    onChange={(event) =>
                      setAmounts((a) => ({ ...a, [service.name]: event.target.value }))
                    }
                    className="border-line min-h-11 w-24 rounded-sm border px-2"
                  />
                </span>
              </label>
            ))}
          </div>
        )
      ) : null}
      {switches?.voice ? (
        <ToggleRow
          label="Text the payment link after a call"
          line={TEXT_LINK_LINE}
          checked={textLink}
          onChange={setTextLink}
          locked={!switches.text.enabled}
          explainerId="explain-text-link"
          explainer={
            <TextLinkExplainer
              id="explain-text-link"
              rule={switches.text}
              targets={switches.targets}
            />
          }
        />
      ) : null}
      {switches ? (
        <>
          <Choice
            legend="What AYA asks the patient to pay"
            describedBy="explain-payment-ask"
            value={paymentAsk}
            onChange={setPaymentAsk}
            options={[
              { id: "deposit_only", label: "Deposit only", line: PAYMENT_ASK_LINE },
              {
                id: "full_payment",
                label: "Full payment",
                disabled: !switches.full.enabled,
              },
            ]}
          />
          <FullPaymentExplainer
            id="explain-payment-ask"
            rule={switches.full}
            targets={switches.targets}
            calendarLater
          />
        </>
      ) : null}
    </ScreenShell>
  );
}

/**
 * Connect Stripe, or do it later in Settings → Payments, which is the
 * default: saving this screen without it changes nothing about deposits but
 * how they are collected. Outside the screen's form, so leaving for Stripe
 * loses no amount typed below; the step-up and Stripe's sign-in come back
 * here (lib/setup/payments.ts).
 */
function StripeConnect({ stripe }: { stripe: SetupStripeView }) {
  return (
    <div className="border-line rounded-md border bg-white px-4 py-3 text-sm">
      <p className="font-semibold">Deposits paid in chat</p>
      {stripe.outcome ? (
        <p
          role="status"
          className={`mt-2 rounded-sm border px-3 py-2 ${stripe.outcome.ok ? "border-line bg-tint-mint" : "border-problem-line text-problem"}`}
        >
          {stripe.outcome.text}
        </p>
      ) : null}
      {stripe.isConnected ? (
        <p className="text-muted mt-1">
          Your Stripe account is connected. In chat, AYA sends a secure link and the deposit is paid
          straight into it. Change it in Settings → Payments.
        </p>
      ) : (
        <>
          <p className="text-muted mt-1">
            Connect your Stripe account and AYA can send a secure link in chat, paid straight into
            it. AYA never takes a card number.
          </p>
          <p className="mt-2">
            <span className="font-semibold">Do it later in Settings → Payments</span>, or connect it
            now: it needs Face ID or your screen lock, then your Stripe sign-in, and brings you back
            here.
          </p>
          {stripe.available ? (
            <a
              href={stripe.href}
              className="border-line mt-3 inline-flex min-h-11 items-center rounded-full border px-5 font-semibold"
            >
              Connect Stripe
            </a>
          ) : (
            <p className="text-muted mt-2">
              Email hello@healdesk.io and we&rsquo;ll connect it with you.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// 2.5 Urgent help and where alerts go
// -----------------------------------------------------------------------------

export function UrgentScreen(
  props: Common & {
    /** The clinic's own urgent number, or empty for the default. */
    urgentHelp: string;
    /** The default, as it stands now: shown, never filled in. */
    urgentPlaceholder: string;
    urgentHint: string;
    /** A veterinary practice gives its emergency referral clinic instead. */
    vet: boolean;
    vetReferral: string;
    audience: "patients" | "clients";
    address: string | null;
    /**
     * Whether an urgent alert would reach the clinic today (urgentAlertReadiness,
     * lib/notices/urgent-readiness.ts): the screen says AYA tells the team only
     * when it would, and otherwise that urgent alerts are not switched on yet.
     */
    teamAlerted?: boolean;
  },
) {
  const [urgent, setUrgent] = useState(props.urgentHelp);
  const [referral, setReferral] = useState(props.vetReferral);
  return (
    <ScreenShell
      slug={props.slug}
      screen="urgent"
      title="Urgent help"
      intro={
        props.vet ? (
          <p>
            When a client reports an emergency with their animal, AYA gives them your emergency
            referral clinic, and your own number while you&rsquo;re open. Anyone reporting that a
            person is hurt is told to call 911.
          </p>
        ) : (
          <p>
            When someone reports a complication or something urgent, AYA tells them to call 911 if
            it&rsquo;s an emergency
            {props.teamAlerted
              ? ", gives them the number below, and tells your team at once."
              : " and gives them the number below."}
          </p>
        )
      }
      skipCost={props.skipCost}
      backHref={props.backHref}
      payload={() => (props.vet ? { vetReferral: referral } : { urgentHelp: urgent })}
    >
      {props.vet ? (
        <Field
          label="Your emergency referral clinic"
          hint="The animal hospital you send clients to when you can't see them. AYA gives this number to anyone with an urgent problem."
          value={referral}
          onChange={setReferral}
          type="tel"
          inputMode="tel"
        />
      ) : (
        <Field
          label={`A number ${props.audience} can call for urgent help`}
          hint={props.urgentHint}
          value={urgent}
          onChange={setUrgent}
          placeholder={props.urgentPlaceholder}
          type="tel"
          inputMode="tel"
        />
      )}
      {props.teamAlerted ? null : (
        <div className="rounded-md border border-line bg-white px-4 py-3 text-sm">
          <p className="font-semibold">Urgent alerts are not switched on yet</p>
          <p className="text-muted mt-1">
            Until they are, AYA does not alert your team about an urgent message and does not say
            it has. It gives the person {props.vet ? "the emergency numbers" : "911"} and the number
            below.
          </p>
        </div>
      )}
      <div className="rounded-md border border-line bg-white px-4 py-3 text-sm">
        <p className="font-semibold">Where alerts go</p>
        <p className="text-muted mt-1">
          Urgent alerts, booking requests and everything else go to{" "}
          {props.address ?? "your clinic's address"}. Read it on a phone with notifications on.
        </p>
      </div>
    </ScreenShell>
  );
}
