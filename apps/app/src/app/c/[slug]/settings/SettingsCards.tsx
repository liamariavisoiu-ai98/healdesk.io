import type { CoverageModeId } from "@healdesk/catalog";
import type { ReactNode } from "react";

import { isBuiltSection, sectionPath } from "@/lib/portal/nav";
import type { SettingsView } from "@/lib/portal/settings-view";
import { WEB_CHAT_COUNTS_LINE } from "@/lib/setup/channels";
import type { ForwardingView } from "@/lib/setup/forwarding";
import type { ForwardingTestView } from "@/lib/setup/forwarding-test-words";
import { GREETING_LABELS, META_GREETING_NOTE } from "@/lib/setup/greetings";

import { portalMetaOutcome } from "@/lib/meta/portal-return";

import { ForwardingTestPanel } from "../ForwardingTestPanel";
import { MetaConnectButtons } from "../MetaConnectButtons";
import { SendStepsForm } from "../SendStepsForm";
import { WebsiteLinePanel } from "../WebsiteLinePanel";

import { CoverageSetting } from "./CoverageSetting";

import {
  ChecklistSetting,
  ChoiceSetting,
  SwitchSetting,
  TextSetting,
} from "./controls";
import { DisconnectPayments } from "./DisconnectPayments";

/**
 * Settings' cards (plan Part F2's card table, in its order): Channels, How
 * AYA talks, Calendar, Payments, Safety net and Alerts. Calendar and Sign-in
 * are their own files. Server components: each card is static text around the client
 * controls in ./controls.tsx, which save as they change.
 *
 * Only what the clinic bought is shown (spec: "bought channels only"), and a
 * switch whose channels are not answering yet carries "Applies when … opens".
 */

const SENSITIVE_HINT = "Changing it needs Face ID or your screen lock on a device you've added.";

export function Card(props: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section
      id={props.id}
      aria-labelledby={`${props.id}-heading`}
      className="border-line scroll-mt-6 rounded-2xl border bg-white px-4 py-4 sm:px-5"
    >
      <h2 id={`${props.id}-heading`} className="text-lg font-semibold">
        {props.title}
      </h2>
      {props.intro ? <div className="text-muted mt-1 text-sm">{props.intro}</div> : null}
      <div className="divide-line mt-2 divide-y">{props.children}</div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Channels
// -----------------------------------------------------------------------------

/** Phone's forwarding in Settings, once phone is ready for it: the steps for each mode, and the test. */
export type SettingsForwarding = {
  views: Readonly<Record<CoverageModeId, ForwardingView>>;
  /** "Test it now", while phone waits on the clinic's forwarding; null otherwise. */
  test: ForwardingTestView | null;
};

export function ChannelsCard({
  view,
  phoneSteps = null,
  forwarding = null,
  webLine = null,
  metaOutcome = null,
}: {
  view: SettingsView;
  /** `?meta=` from a Facebook login or WhatsApp sign-up that just returned here. */
  metaOutcome?: string | null;
  /** AYA's number as the page prints it, once phone is ready on our side; null until then. */
  phoneSteps?: { numberLabel: string } | null;
  /** The forwarding steps and the test, once phone is ready for forwarding; null until then. */
  forwarding?: SettingsForwarding | null;
  /** Website chat's line once the channel is open (lib/setup/snippet.ts); null until then. */
  webLine?: string | null;
}) {
  return (
    <Card id="channels" title="Channels" intro="Each channel you bought, on or off on its own.">
      {portalMetaOutcome(metaOutcome) ? (
        <p
          role={portalMetaOutcome(metaOutcome)!.ok ? "status" : "alert"}
          className={`my-3 rounded-xl border px-4 py-3 text-sm ${
            portalMetaOutcome(metaOutcome)!.ok ? "border-line bg-tint-mint" : "border-red-200 text-red-800"
          }`}
        >
          {portalMetaOutcome(metaOutcome)!.text}
        </p>
      ) : null}
      {view.channels.map((c) =>
        c.key ? (
          <div key={c.channel}>
            <SwitchSetting
              slug={view.slug}
              settingKey={c.key}
              label={c.name}
              line={c.switchLine}
              applies={c.applies}
              initial={c.on}
            />
            <StatusLine label={c.statusLabel} line={c.line} />
          </div>
        ) : (
          // The Meta channel: a switch for each platform the clinic has
          // connected (spec: Instagram, Messenger and WhatsApp, each on its
          // own), then where the channel stands. Before any is connected,
          // only where it stands.
          <div key={c.channel}>
            {c.platforms.map((p) => (
              <div key={p.platform}>
                <SwitchSetting
                  slug={view.slug}
                  settingKey={p.key}
                  label={p.name}
                  line={p.switchLine}
                  applies={c.applies}
                  initial={p.on}
                />
                <StatusLine label={p.statusLabel} />
              </div>
            ))}
            {c.platforms.length === 0 ? (
              <>
                <p className="pt-3 font-semibold">{c.name}</p>
                <StatusLine label={c.statusLabel} line={c.line} />
              </>
            ) : (
              <StatusLine line={c.line} />
            )}
          </div>
        ),
      )}
      {view.metaConnect ? (
        <div id="meta-connections" className="py-3">
          <h3 className="font-semibold">Instagram, Messenger &amp; WhatsApp logins</h3>
          <MetaConnectButtons slug={view.slug} from="settings" view={view.metaConnect} />
        </div>
      ) : null}
      {view.bought.voice && forwarding ? (
        <CoverageSetting
          slug={view.slug}
          legend="Which calls reach AYA"
          line={`Your call forwarding steps follow this choice. ${view.coverage.landlineNote}`}
          applies={view.applies.coverage_mode}
          options={view.coverage.options as readonly { id: CoverageModeId; label: string; line: string }[]}
          initial={view.coverage.mode as CoverageModeId}
          views={forwarding.views}
        />
      ) : view.bought.voice ? (
        <ChoiceSetting
          slug={view.slug}
          settingKey="coverage_mode"
          legend="Which calls reach AYA"
          line={`Your call forwarding steps follow this choice. ${view.coverage.landlineNote}`}
          applies={view.applies.coverage_mode}
          options={view.coverage.options}
          initial={view.coverage.mode}
        />
      ) : null}
      {view.bought.voice && forwarding?.test ? (
        <div className="py-3">
          <ForwardingTestPanel slug={view.slug} initial={forwarding.test} />
        </div>
      ) : null}
      {view.bought.voice && phoneSteps ? (
        <SendStepsForm slug={view.slug} numberLabel={phoneSteps.numberLabel} />
      ) : null}
      {view.bought.web && webLine ? (
        // The line stays here for good once it is open (spec: "available in
        // the dashboard forever"), live or not: O10 and Home link here.
        <div id="website-line" className="scroll-mt-6 pb-3">
          <WebsiteLinePanel slug={view.slug} snippet={webLine} />
        </div>
      ) : view.bought.web ? (
        <p className="text-muted py-3 text-sm">
          The line to paste on your website appears here when website chat is ready, with a button
          to send it to whoever looks after your site. {WEB_CHAT_COUNTS_LINE}
        </p>
      ) : null}
      {!view.bought.meta && isBuiltSection("billing") ? (
        <p className="py-3 text-sm">
          <a href={sectionPath(view.slug, "billing")} className="font-semibold underline">
            Add Instagram, Messenger &amp; WhatsApp in Billing
          </a>
        </p>
      ) : null}
    </Card>
  );
}

// There is no Records card. It offered "Keep transcripts for" (BAA 1.3.0
// clause 11), until the owner decided on 13 October 2026 that healdesk keeps
// no transcript: each is emailed to the clinic when its conversation ends, and
// BAA 1.4.0 gives the clinic no period to shorten (lib/portal/settings.ts).

/** A channel's status word, and the one line on what happens next. */
/** A channel's status label (the wizard's, with its time) and its line. */
function StatusLine({ label, line }: { label?: string; line?: string }) {
  return (
    <p className="text-muted -mt-1 pb-3 text-sm">
      {label ? (
        <span className="bg-paper-2 text-ink mr-2 inline-block max-w-full rounded-full px-2 py-0.5 text-xs font-semibold">
          {label}
        </span>
      ) : null}
      {line}
    </p>
  );
}

// -----------------------------------------------------------------------------
// How AYA talks
// -----------------------------------------------------------------------------

export function TalkCard({ view }: { view: SettingsView }) {
  const { talk } = view;
  return (
    <Card
      id="how-aya-talks"
      title="How AYA talks"
      intro="One assistant, the same answers on every channel. Your guardrails and the line saying AYA is an AI assistant can't be changed here."
    >
      <ChoiceSetting
        slug={view.slug}
        settingKey="tone"
        legend="Tone"
        line="How AYA speaks on every channel."
        applies={view.applies.tone}
        options={talk.toneOptions}
        initial={talk.tone}
      />
      {talk.greetings.map((g) => (
        <TextSetting
          key={g.key}
          slug={view.slug}
          settingKey={g.key}
          label={g.key === "phone_greeting" ? GREETING_LABELS.phone : GREETING_LABELS.chat}
          before={
            <>
              <p className="border-line bg-paper-2 rounded-xl border px-4 py-3 text-sm">
                {g.lockedLine}
                <span className="text-muted mt-1 block text-xs">
                  Always first, on every {g.key === "phone_greeting" ? "call" : "website chat"}. It
                  can&rsquo;t be changed.
                </span>
              </p>
              {g.key === "chat_greeting" && view.bought.meta ? (
                <p className="text-muted mt-2 text-sm">{META_GREETING_NOTE}</p>
              ) : null}
            </>
          }
          initial={g.isDefault ? "" : g.text}
          placeholder={g.isDefault ? g.text : undefined}
          hint={
            g.isDefault
              ? "Then AYA says the default shown in the box, which follows your practice's name. Write your own to replace it."
              : "Then AYA says this."
          }
          applies={view.applies[g.key]}
          multiline
          maxLength={300}
          resetLabel="Use the default"
        />
      ))}
      <ChecklistSetting
        slug={view.slug}
        settingKey="languages"
        legend="Languages"
        line="AYA answers in the language each person uses, and stays in it, on the phone and the website chat. Instagram, Messenger and WhatsApp answer in English."
        applies={view.applies.languages}
        options={talk.languageOptions}
        initial={talk.languages}
      />
      {view.bought.voice || view.bought.web ? (
        <>
          <SwitchSetting
            slug={view.slug}
            settingKey="suggest_add_ons"
            label="Suggest add-on treatments"
            line="On lets AYA suggest complementary treatments and products during a booking, on phone and website chat. Off keeps her to what was asked."
            applies={view.applies.suggest_add_ons}
            initial={talk.suggestAddOns}
          />
          <SwitchSetting
            slug={view.slug}
            settingKey="mention_promotions"
            label="Mention promotions"
            line="Whether AYA uses what you write in Knowledge → Promotions, on phone and website chat."
            applies={view.applies.mention_promotions}
            initial={talk.mentionPromotions}
          />
        </>
      ) : null}
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Payments
// -----------------------------------------------------------------------------

const CONNECT_OUTCOMES: Record<string, { text: string; ok: boolean }> = {
  ok: { text: "Your Stripe account is connected.", ok: true },
  declined: { text: "Stripe wasn't connected: it was declined on Stripe's page.", ok: false },
  failed: {
    text: "We couldn't connect your Stripe account. Try again, or email hello@healdesk.io.",
    ok: false,
  },
};

export function PaymentsCard({
  view,
  connectOutcome,
}: {
  view: SettingsView;
  connectOutcome: string | null;
}) {
  const { payments } = view;
  const outcome = connectOutcome ? CONNECT_OUTCOMES[connectOutcome] : undefined;
  const chat = view.bought.web || view.bought.meta;
  const blocked = !payments.isConnected
    ? "Connect your Stripe account first."
    : !payments.hasDepositAmount
      ? "Set a deposit on a treatment in Knowledge → Prices first."
      : null;
  const holdOptions = [30, 60, 120, 240, 1440].includes(payments.holdMinutes)
    ? [30, 60, 120, 240, 1440]
    : [payments.holdMinutes, 30, 60, 120, 240, 1440].sort((a, b) => a - b);

  return (
    <Card
      id="payments"
      title="Payments"
      intro="Deposits are paid straight into your own Stripe account. AYA never takes a card number."
    >
      {outcome ? (
        <p
          role="status"
          className={`my-3 rounded-xl border px-4 py-3 text-sm ${outcome.ok ? "border-line bg-tint-mint" : "border-red-200 text-red-800"}`}
        >
          {outcome.text}
        </p>
      ) : null}
      <div className="py-3">
        <p className="font-semibold">Payment account</p>
        {payments.isConnected ? (
          <>
            <p className="text-muted mt-1 text-sm">Your Stripe account is connected.</p>
            <DisconnectPayments slug={view.slug} />
          </>
        ) : payments.connectAvailable ? (
          <>
            <p className="text-muted mt-1 text-sm">
              Not connected. Connecting it needs Face ID or your screen lock, then your Stripe
              sign-in.
            </p>
            <a
              href={`/api/connect/stripe/start?clinic=${encodeURIComponent(view.slug)}&from=settings`}
              className="bg-ink mt-3 inline-flex min-h-11 items-center rounded-full px-5 text-sm font-bold text-white"
            >
              Connect Stripe
            </a>
          </>
        ) : (
          <p className="text-muted mt-1 text-sm">
            Not connected. Email hello@healdesk.io and we&rsquo;ll connect it with you.
          </p>
        )}
      </div>
      <SwitchSetting
        slug={view.slug}
        settingKey="deposits_enabled"
        label="Take deposits"
        line="Whether AYA can ask for a deposit at all. In chat she sends a secure payment link; on a call she can't take a card, so she books and flags the deposit for your team."
        applies={view.applies.deposits_enabled}
        initial={payments.depositsEnabled}
        blockedLine={payments.depositsEnabled ? null : blocked}
      />
      <div className="py-3">
        <p className="font-semibold">Deposit per treatment</p>
        <p className="text-muted mt-1 text-sm">
          {payments.servicesWithDeposit === 0
            ? "No treatment asks for a deposit yet."
            : payments.servicesWithDeposit === 1
              ? "One treatment asks for a deposit."
              : `${payments.servicesWithDeposit} treatments ask for a deposit.`}{" "}
          {isBuiltSection("knowledge") ? (
            <a
              href={`${sectionPath(view.slug, "knowledge")}#prices`}
              className="text-ink font-semibold underline"
            >
              Set them in Knowledge → Prices
            </a>
          ) : null}
        </p>
      </div>
      {view.bought.voice ? (
        <SwitchSetting
          slug={view.slug}
          settingKey="book_voice_without_deposit"
          label="Book by phone without a deposit"
          line="On: AYA books and flags the deposit for your team to collect. Off: she won't book a treatment that needs one, and passes the caller to your team."
          applies={view.applies.book_voice_without_deposit}
          initial={payments.bookVoiceWithoutDeposit}
        />
      ) : null}
      {chat ? (
        <>
          <SwitchSetting
            slug={view.slug}
            settingKey="book_chat_without_deposit"
            label="Book by chat without a deposit"
            line="On: AYA books and flags the deposit. Off: she sends the payment link first, which protects the slot."
            applies={view.applies.book_chat_without_deposit}
            initial={payments.bookChatWithoutDeposit}
          />
          <ChoiceSetting
            slug={view.slug}
            settingKey="deposit_uncollectable"
            legend="When a deposit can't be collected"
            line="A channel's own “book without a deposit” switch decides first; this applies when it's off and a link can't be sent."
            applies={view.applies.deposit_uncollectable}
            options={[
              {
                id: "book_and_flag",
                label: "Book and flag",
                line: "AYA books and flags the deposit for your team.",
              },
              {
                id: "hold_and_alert",
                label: "Hold the slot and alert staff",
                line: `The slot is kept for ${payments.holdMinutes} minutes while your team is alerted.`,
              },
              {
                id: "decline_and_alert",
                label: "Do not book and alert staff",
                line: "AYA doesn't book, and your team is alerted.",
              },
            ]}
            initial={payments.uncollectable}
          />
          <ChoiceSetting
            slug={view.slug}
            settingKey="deposit_hold_minutes"
            legend="How long a slot is held for its deposit"
            applies={view.applies.deposit_hold_minutes}
            options={holdOptions.map((m) => ({
              id: String(m),
              label:
                m === 1440
                  ? "A day"
                  : m < 60
                    ? `${m} minutes`
                    : m === 60
                      ? "An hour"
                      : `${m / 60} hours`,
            }))}
            initial={String(payments.holdMinutes)}
          />
        </>
      ) : null}
      <p className="text-muted py-3 text-sm">
        Booking without a deposit fills the calendar and raises no-show risk. Requiring one protects
        the slot and loses some bookings to friction.
      </p>
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Safety net
// -----------------------------------------------------------------------------

export function SafetyNetCard({ view }: { view: SettingsView }) {
  const { safety } = view;
  return (
    <Card
      id="safety-net"
      title="Safety net"
      intro="Whatever happens, someone calling or writing to your practice reaches a person."
    >
      {view.bought.voice ? (
        <TextSetting
          slug={view.slug}
          settingKey="direct_line"
          label="Direct line"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          initial={safety.directLine}
          hint={`A line at the practice that doesn't forward to AYA: a second line or a manager's mobile. Calls go here whenever AYA can't answer.${safety.directLineIsSet ? ` ${SENSITIVE_HINT}` : ""}`}
          applies={view.applies.direct_line}
        />
      ) : null}
      {safety.vet ? (
        <TextSetting
          slug={view.slug}
          settingKey="vet_referral"
          label="Your emergency referral clinic"
          type="tel"
          inputMode="tel"
          initial={safety.vetReferral}
          hint="AYA gives this number to anyone describing an urgent problem with their animal, after telling them to get help now."
          applies={view.applies.vet_referral}
        />
      ) : (
        <TextSetting
          slug={view.slug}
          settingKey="urgent_help"
          label={`A number ${view.audience} can call for urgent help`}
          type="tel"
          inputMode="tel"
          initial={safety.urgent.value}
          placeholder={safety.urgent.placeholder}
          hint={`AYA tells anyone reporting something urgent to call 911 in an emergency, then gives this number. ${safety.urgent.hint}`}
          applies={view.applies.urgent_help}
          resetLabel="Use the default"
        />
      )}
      <div className="py-3">
        <p className="font-semibold">What AYA does when…</p>
        <dl className="mt-2 grid gap-2 text-sm">
          {safety.failures.map((f) => (
            <div key={f.when}>
              <dt className="font-semibold">{f.when}</dt>
              <dd className="text-muted">{f.then}</dd>
            </div>
          ))}
        </dl>
        {safety.allowance && isBuiltSection("billing") ? (
          <p className="mt-2 text-sm">
            <a
              href={`${sectionPath(view.slug, "billing")}#switches`}
              className="font-semibold underline"
            >
              Change what happens when the allowance runs out, in Billing
            </a>
          </p>
        ) : null}
      </div>
      {safety.undo.length > 0 ? (
        <div className="py-3">
          <p className="font-semibold">How to undo call forwarding</p>
          <p className="text-muted mt-1 text-sm">
            Follow the steps for your carrier and kind of line, with no call to us.
            {/* A cloud phone system's one step is a rule to remove, with nothing to dial. */}
            {safety.undo.some((u) => u.steps.some((s) => s.dial !== ""))
              ? " Dial each code from the practice\u2019s own line."
              : null}
          </p>
          <div className="mt-2 grid gap-2">
            {safety.undo.map((u) => (
              <details key={u.carrier} className="border-line rounded-xl border px-4 py-2 text-sm">
                <summary className="min-h-8 cursor-pointer font-semibold">{u.carrier}</summary>
                <ul className="mt-2 grid gap-1">
                  {u.steps.map((s) => (
                    <li key={`${s.label}${s.dial}`}>
                      {s.label}
                      {s.dial ? <strong className="ml-1 font-mono">{s.dial}</strong> : null}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Alerts
// -----------------------------------------------------------------------------

export function AlertsCard({ view }: { view: SettingsView }) {
  const { alerts } = view;
  return (
    <Card id="alerts" title="Alerts">
      <div className="py-3">
        <p className="font-semibold">
          {alerts.urgentAlertsReady ? "Everything goes to " : "Everything will go to "}
          {alerts.address ?? "your practice's address"}
        </p>
        <ul className="text-muted mt-1 grid list-disc gap-1 pl-5 text-sm">
          <li>urgent alerts, the moment AYA hears something urgent;</li>
          <li>when someone asks to speak to a person;</li>
          <li>booking requests and deposits to collect;</li>
          <li>the daily summary, and billing.</li>
        </ul>
        {alerts.urgentAlertsReady ? null : (
          <p className="mt-2 text-sm font-semibold" data-urgent-alerts="off">
            Urgent alerts are not switched on yet, so none reach you today. Until they are, AYA
            tells anyone reporting something urgent to call 911 and gives them your number for
            urgent help, and does not say your team has been told.
          </p>
        )}
        <p className="text-muted mt-2 text-sm">
          Read it on a phone with notifications on. Emails point into healdesk and never carry{" "}
          {view.audience === "clients" ? "client" : "patient"} details.
        </p>
      </div>
      <SwitchSetting
        slug={view.slug}
        settingKey="daily_summary"
        label="Daily summary email"
        line="At the start of each working day: what AYA handled, booked and escalated, every booking and booking request with its link, and every request still open."
        applies={view.applies.daily_summary}
        initial={alerts.dailySummary}
      />
      {view.bought.voice ? (
        <>
          <SwitchSetting
            slug={view.slug}
            settingKey="transfer_live_calls"
            label="Transfer live calls"
            line="On lets AYA put a caller through to a real person during your opening hours."
            applies={view.applies.transfer_live_calls}
            initial={alerts.transferLiveCalls}
          />
          <TextSetting
            slug={view.slug}
            settingKey="transfer_number"
            label="Transfer number"
            type="tel"
            inputMode="tel"
            initial={alerts.transferNumber}
            placeholder={alerts.transferPlaceholder}
            hint={`Leave it empty and transfers go to your direct line.${alerts.transferIsSet ? ` ${SENSITIVE_HINT}` : ""}`}
            applies={view.applies.transfer_number}
            resetLabel="Use the direct line"
          />
        </>
      ) : null}
    </Card>
  );
}
