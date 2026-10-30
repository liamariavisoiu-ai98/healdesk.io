import type { GoogleCalendarDisclosure } from "@healdesk/catalog";
import type { ReactNode } from "react";

import { Notice } from "@/app/channels/shared";
import type {
  CalendarPageModel,
  CalendarPageNotice,
  ElectionFormModel,
} from "@/lib/connections/calendar-links";
import type { GoogleConnectOutcome } from "@/lib/connections/google-oauth";

/**
 * The calendar link's page, as a pure function of its model (plan §4.1):
 * what lib/connections/calendar-links.ts decided the location's state is,
 * and what the query said happened last, from closed sets only. Nothing
 * here reads a database or a request, so the tests render it directly.
 *
 * Rules the copy keeps: the data-use notice sits immediately above its
 * unticked box and the Google button, with nothing in between; a
 * Workspace location sees the Trusted-app guidance before it; a mismatch
 * states what was observed as a fact and pre-selects nothing; an election
 * form pre-selects nothing either.
 */

export type CalendarPageActions = {
  submitElection: (form: FormData) => Promise<void>;
  requestChangeLink: (form: FormData) => Promise<void>;
  chooseCalendar: (form: FormData) => Promise<void>;
  reissue: (form: FormData) => Promise<void>;
};

/** A form field the election form can be sent back about. */
export type CalendarFormProblem =
  "name" | "accepted" | "bookingSystem" | "calendarAccount" | "calendar";

export type CalendarPageQuery = {
  outcome: GoogleConnectOutcome | "election_changed" | null;
  notice: CalendarPageNotice | null;
  problem: CalendarFormProblem | null;
  /** The mismatch page's "Use this account instead" was chosen: show the election form. */
  elect: boolean;
};

const TRUSTED_APP =
  "If your Google Workspace administrator limits which apps may use Calendar, Google will stop the sign-in with “admin_policy_enforced”. Ask your administrator to mark healdesk as trusted first: Admin console › Security › Access and data control › API controls › Manage third-party app access.";

const WHICH_ACCOUNT =
  "Sign in with the Google account whose calendar holds your appointments — many practices use a dedicated account such as bookings@yourpractice.com.";

const OUTCOME_COPY: Record<Exclude<GoogleConnectOutcome, "mismatch">, string> = {
  connected:
    "Your Google Calendar is connected. Your assistant books into it from now on, as your calendar terms allow.",
  declined: "You didn't allow access in Google, so nothing was connected.",
  admin_blocked:
    "Your Google Workspace administrator has blocked healdesk from your calendar. Ask them to mark healdesk as trusted, then try again.",
  failed: "Something went wrong connecting your calendar. Nothing was stored; please try again.",
  scopes:
    "Please leave every calendar permission ticked when Google asks: healdesk needs all three to read free and busy times and add its bookings. Nothing was stored.",
  no_refresh:
    "Google didn't give healdesk lasting access to the calendar. Nothing was stored; please try again.",
  probe:
    "healdesk couldn't read that calendar's free and busy times, or the account isn't the calendar's owner. Nothing was stored.",
  different_account:
    "You signed in with a different Google account from the one already connected, so nothing changed. Only the practice owner can change the account: ask for a link below and we'll email it to them.",
  election_needed:
    "That account is a different kind of Google account, or in another Workspace domain, from the one connected now, so the practice owner records a calendar election for it first. Nothing changed.",
  account_in_use:
    "That Google account is already connected to another healdesk account; nothing was stored.",
  already_connected: "This link was already used to connect a calendar.",
  terms: "This location's calendar terms don't let healdesk use a calendar.",
  disclosure: "Please tick the box under the notice before signing in with Google.",
  unavailable: "Calendar connection isn't available yet.",
};

const NOTICE_COPY: Record<CalendarPageNotice, string> = {
  election_recorded:
    "Your calendar election is recorded, and a copy is on its way to the practice's address.",
  owner_asked:
    "That choice needs the practice owner's agreement, so we've emailed them a link to confirm it. Nothing changes until they do.",
  change_link_sent:
    "We've emailed the practice owner a link to connect a different Google account. Nothing changes until they use it.",
  calendar_chosen: "Saved. Your assistant books into that calendar from now on.",
};

const PROBLEM_COPY: Record<CalendarFormProblem, string> = {
  name: "Type your name to accept the election.",
  accepted: "Tick the box to accept the calendar election.",
  bookingSystem: "Choose where the practice's bookings live.",
  calendarAccount: "Choose which kind of Google account holds the calendar.",
  calendar: "That calendar can't be used. Choose one from the list.",
};

export function CalendarLinkView({
  model,
  query,
  actions,
}: {
  model: CalendarPageModel;
  query: CalendarPageQuery;
  actions: CalendarPageActions;
}) {
  switch (model.state) {
    case "expired":
      return (
        <Frame title="This link has expired or has already been used">
          <p className="mt-4 text-[15px]">
            Calendar links work once, and only for a few days. We can email a new one to the
            practice&apos;s calendar contacts.
          </p>
          {model.token ? (
            <form action={actions.reissue} className="mt-6">
              <input type="hidden" name="token" value={model.token} />
              <button type="submit" className={BUTTON}>
                Email a new link to the practice&apos;s calendar contacts
              </button>
            </form>
          ) : null}
        </Frame>
      );
    case "unavailable":
      return (
        <Frame title="Calendar connection isn't available yet">
          <p className="mt-4 text-[15px]">
            Nothing is needed from you now. Your assistant takes each booking as a request for your
            staff to confirm until it is.
          </p>
        </Frame>
      );
    case "terms_unavailable":
      return (
        <Frame title="Your calendar terms aren't available yet" clinicName={model.clinicName}>
          <p className="mt-4 text-[15px]">
            We&apos;ll email you when they are. Until then your assistant takes each booking as a
            request for your staff to confirm.
          </p>
        </Frame>
      );
    case "election":
      return (
        <Frame title="Your calendar terms" clinicName={model.clinicName}>
          <Messages query={query} />
          {model.manual ? (
            <p className="mt-4 text-[15px]">
              Your booking system doesn&apos;t read Google Calendar, or we haven&apos;t confirmed
              that it does, so healdesk doesn&apos;t connect to your calendar: your assistant takes
              each booking as a request and your staff confirm it in your own system. If that has
              changed, record a calendar election below.
            </p>
          ) : (
            <p className="mt-4 text-[15px]">
              Before healdesk can use a calendar for this location, the practice records a short
              calendar election: where its bookings live, and which kind of Google account holds its
              calendar.
            </p>
          )}
          {model.form ? (
            <ElectionForm
              token={model.token}
              clinicName={model.clinicName}
              form={model.form}
              action={actions.submitElection}
            />
          ) : (
            <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
              Changing it here isn&apos;t available yet. We&apos;ll email you when it is.
            </p>
          )}
        </Frame>
      );
    case "confirm":
      return (
        <Frame title="Confirm a calendar election" clinicName={model.clinicName}>
          <Messages query={query} />
          {model.document === null ? (
            <Notice tone="problem">
              This election has changed; start again from the practice&apos;s calendar link.
            </Notice>
          ) : (
            <>
              <p className="mt-4 text-[15px]">
                Someone at the practice chose these calendar terms. As the practice owner, read the
                election and accept it to put it into effect.
              </p>
              <pre className="mt-4 overflow-x-auto rounded-sm border border-[color:var(--color-line)] p-4 text-[13px] whitespace-pre-wrap">
                {model.document}
              </pre>
              <form action={actions.submitElection} className="mt-6 space-y-4">
                <input type="hidden" name="token" value={model.token} />
                <input type="hidden" name="bookingSystem" value={model.choice.bookingSystem} />
                <input type="hidden" name="calendarAccount" value={model.choice.calendarAccount} />
                <Signature clinicName={model.clinicName} />
                <button type="submit" className={BUTTON}>
                  Confirm
                </button>
              </form>
            </>
          )}
        </Frame>
      );
    case "connect": {
      const mismatch = query.outcome === "mismatch";
      // The owner's change link brought in an account of another kind or
      // Workspace domain (plan §4.5 step 6): the election form here is the
      // owner's, and once it is recorded the same sign-in goes through.
      const electing = query.outcome === "election_needed" && model.accountChange;
      return (
        <Frame
          title={
            model.accountChange
              ? "Connect a different Google account"
              : "Connect your Google Calendar"
          }
          clinicName={model.clinicName}
        >
          <Messages query={query} />
          {mismatch ? <MismatchFact workspace={model.workspace} /> : null}
          {model.accessRemoved && !mismatch ? (
            <Notice tone="info">
              healdesk&apos;s access was removed in your Google Account. Nothing more is needed if
              you meant to; otherwise connect again below.
            </Notice>
          ) : null}
          {electing && model.form ? (
            <>
              <p className="mt-6 text-[15px]">
                As the practice owner, record the calendar election for the account you want to use:
                where the practice&apos;s bookings live, and which kind of Google account holds its
                calendar. Then sign in with that account again.
              </p>
              <ElectionForm
                token={model.token}
                clinicName={model.clinicName}
                form={model.form}
                action={actions.submitElection}
              />
              <p className="mt-4 text-[15px]">
                <a href={`/calendar/${model.token}`} className={LINK}>
                  Sign in with a different account instead
                </a>
              </p>
            </>
          ) : mismatch && query.elect && model.form ? (
            <>
              <p className="mt-6 text-[15px]">
                Using that account means a calendar outside Google&apos;s business associate
                agreement, or another kind of account than your terms name; the practice takes
                responsibility for that disclosure. Record the calendar election that matches the
                account you want to use.
              </p>
              <ElectionForm
                token={model.token}
                clinicName={model.clinicName}
                form={model.form}
                action={actions.submitElection}
              />
            </>
          ) : (
            <>
              {electing ? (
                <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
                  Recording that election here isn&apos;t available yet. We&apos;ll email you when
                  it is.
                </p>
              ) : null}
              <p className="mt-4 text-[15px]">{WHICH_ACCOUNT}</p>
              {model.workspace ? <p className="mt-3 text-[15px]">{TRUSTED_APP}</p> : null}
              <ConnectForm
                token={model.token}
                disclosure={model.disclosure}
                label={
                  mismatch
                    ? model.workspace
                      ? "Sign in with the Workspace account"
                      : "Sign in with the personal account"
                    : "Sign in with Google"
                }
              />
              {mismatch && model.form ? (
                <p className="mt-4 text-[15px]">
                  <a href={`/calendar/${model.token}?outcome=mismatch&elect=1`} className={LINK}>
                    Use this account instead
                  </a>
                </p>
              ) : null}
            </>
          )}
        </Frame>
      );
    }
    case "connected":
      return (
        <Frame
          title={
            model.broken ? "This connection stopped working" : "Your Google Calendar is connected"
          }
          clinicName={model.clinicName}
        >
          <Messages query={query} />
          <p className="mt-4 text-[15px]">
            Connected as{" "}
            <span className="font-semibold">{model.account.email ?? "a Google account"}</span> (
            {accountKind(model.account)}){model.connectedOn ? ` on ${model.connectedOn}` : ""}.
          </p>
          {model.calendars ? (
            <form action={actions.chooseCalendar} className="mt-6 space-y-3">
              <input type="hidden" name="token" value={model.token} />
              <fieldset>
                <legend className="text-[15px] font-semibold">
                  The calendar your assistant books into
                </legend>
                {model.calendars.map((calendar) => (
                  <label key={calendar.id} className="mt-2 flex items-center gap-2 text-[15px]">
                    <input
                      type="radio"
                      name="calendarId"
                      value={calendar.primary ? "primary" : calendar.id}
                      defaultChecked={calendar.current}
                    />
                    {calendar.name ?? "Untitled calendar"}
                    {calendar.primary ? " (main calendar)" : ""}
                  </label>
                ))}
              </fieldset>
              <button type="submit" className={BUTTON}>
                Save
              </button>
            </form>
          ) : null}
          <h2 className="mt-8 text-lg font-semibold">Reconnect</h2>
          <p className="mt-2 text-[15px]">{WHICH_ACCOUNT}</p>
          {model.workspace ? <p className="mt-3 text-[15px]">{TRUSTED_APP}</p> : null}
          <ConnectForm token={model.token} disclosure={model.disclosure} label="Reconnect" />
          <form action={actions.requestChangeLink} className="mt-6">
            <input type="hidden" name="token" value={model.token} />
            <button type="submit" className={SECONDARY}>
              Use a different Google account
            </button>
            <p className="mt-2 text-sm text-[color:var(--color-muted)]">
              We email the practice owner a link to connect a different account.
            </p>
          </form>
        </Frame>
      );
  }
}

const BUTTON =
  "rounded-sm bg-[color:var(--color-ink)] px-4 py-2.5 text-[15px] font-semibold text-white";
const SECONDARY =
  "rounded-sm border border-[color:var(--color-line)] px-4 py-2.5 text-[15px] font-semibold";
const LINK = "font-semibold underline underline-offset-2";

function accountKind(account: {
  kind: "workspace" | "personal" | null;
  domain: string | null;
}): string {
  if (account.kind === "workspace")
    return `Google Workspace${account.domain ? `, ${account.domain}` : ""}`;
  if (account.kind === "personal") return "personal account";
  return "Google account";
}

function Frame({
  title,
  clinicName,
  children,
}: {
  title: string;
  clinicName?: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-14">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        healdesk{clinicName ? ` · ${clinicName}` : ""}
      </p>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
        {title}
      </h1>
      {children}
      <p className="mt-10 border-t border-[color:var(--color-line)] pt-6 text-sm text-[color:var(--color-muted)]">
        Something doesn&apos;t look right? Reply to the email that brought you here, or write to{" "}
        <a
          href="mailto:hello@healdesk.io"
          className="font-semibold text-[color:var(--color-ink)] underline underline-offset-2"
        >
          hello@healdesk.io
        </a>
        .
      </p>
    </main>
  );
}

function Messages({ query }: { query: CalendarPageQuery }) {
  return (
    <>
      {query.notice ? <Notice tone="info">{NOTICE_COPY[query.notice]}</Notice> : null}
      {query.outcome === "election_changed" ? (
        <Notice tone="problem">This election has changed; start again.</Notice>
      ) : query.outcome && query.outcome !== "mismatch" ? (
        <Notice tone={query.outcome === "connected" ? "info" : "problem"}>
          {OUTCOME_COPY[query.outcome]}
        </Notice>
      ) : null}
      {query.problem ? <Notice tone="problem">{PROBLEM_COPY[query.problem]}</Notice> : null}
    </>
  );
}

function MismatchFact({ workspace }: { workspace: boolean }) {
  return (
    <Notice tone="problem">
      {workspace
        ? "You signed in with a personal Google account; this location's calendar terms are for a Google Workspace account. Nothing was stored."
        : "You signed in with a Google Workspace account; this location's calendar terms are for a personal Google account. Nothing was stored."}
    </Notice>
  );
}

/** The notice, then the unticked box and the button, with nothing in between (plan §4.2). */
function ConnectForm({
  token,
  disclosure,
  label,
}: {
  token: string;
  disclosure: GoogleCalendarDisclosure;
  label: string;
}) {
  const last = disclosure.paragraphs.length - 1;
  return (
    <form method="post" action="/api/calendar/google/start" className="mt-6">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="disclosureVersion" value={disclosure.version} />
      <section className="rounded-sm border border-[color:var(--color-line)] p-4">
        <h2 className="text-lg font-semibold">{disclosure.heading}</h2>
        {disclosure.paragraphs.map((paragraph, index) =>
          index === last ? (
            <p key={index} className="mt-3 text-[15px]">
              {withLimitedUseLink(paragraph, disclosure)}{" "}
              <a href={disclosure.privacyHref} className={LINK}>
                Our privacy notice
              </a>{" "}
              says more.
            </p>
          ) : (
            <p key={index} className="mt-3 text-[15px]">
              {paragraph}
            </p>
          ),
        )}
      </section>
      <label className="mt-3 flex items-start gap-2 text-[15px]">
        <input type="checkbox" name="disclosure" value="accepted" required />
        <span>{disclosure.tickLabel}</span>
      </label>
      <button type="submit" className={`mt-3 ${BUTTON}`}>
        {label}
      </button>
    </form>
  );
}

function withLimitedUseLink(paragraph: string, disclosure: GoogleCalendarDisclosure): ReactNode {
  const at = paragraph.indexOf(disclosure.limitedUse.linkText);
  if (at < 0) return paragraph;
  return (
    <>
      {paragraph.slice(0, at)}
      <a href={disclosure.limitedUse.href} className={LINK}>
        {disclosure.limitedUse.linkText}
      </a>
      {paragraph.slice(at + disclosure.limitedUse.linkText.length)}
    </>
  );
}

/** Where bookings live and which account holds the calendar, with nothing pre-selected. */
function ElectionForm({
  token,
  clinicName,
  form,
  action,
}: {
  token: string;
  clinicName: string;
  form: ElectionFormModel;
  action: (form: FormData) => Promise<void>;
}) {
  return (
    <form action={action} className="mt-6 space-y-5">
      <input type="hidden" name="token" value={token} />
      <fieldset>
        <legend className="text-[15px] font-semibold">Where do bookings live today?</legend>
        {form.bookingSystems.map((system) => (
          <label key={system.id} className="mt-2 flex items-center gap-2 text-[15px]">
            <input type="radio" name="bookingSystem" value={system.id} required />
            {system.label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend className="text-[15px] font-semibold">
          Which Google account will bookings go into?
        </legend>
        {form.accounts.map((account) => (
          <label key={account.id} className="mt-2 flex items-start gap-2 text-[15px]">
            <input type="radio" name="calendarAccount" value={account.id} required />
            <span>
              {account.title}
              <span className="block text-sm text-[color:var(--color-muted)]">
                {account.description}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="text-sm text-[color:var(--color-muted)]">
        If your choice lets healdesk start adding bookings to a calendar, or moves the calendar
        outside Google&apos;s business associate agreement, we&apos;ll email the practice owner to
        confirm it first.
      </p>
      <Signature clinicName={clinicName} />
      <button type="submit" className={BUTTON}>
        Record the calendar election
      </button>
    </form>
  );
}

function Signature({ clinicName }: { clinicName: string }) {
  return (
    <>
      <label className="block text-[15px]">
        Your name
        <input
          type="text"
          name="name"
          required
          minLength={2}
          maxLength={120}
          className="mt-1 block w-full rounded border border-[color:var(--color-line)] px-3 py-2"
        />
      </label>
      <label className="block text-[15px]">
        Your title (optional)
        <input
          type="text"
          name="title"
          maxLength={70}
          className="mt-1 block w-full rounded border border-[color:var(--color-line)] px-3 py-2"
        />
      </label>
      <label className="flex items-start gap-2 text-[15px]">
        <input type="checkbox" name="accepted" value="yes" required />
        <span>I accept this calendar election for {clinicName}.</span>
      </label>
    </>
  );
}
