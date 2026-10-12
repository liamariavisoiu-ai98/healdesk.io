import {
  CALENDAR_ACCOUNT_OPTIONS,
  type CalendarAccount,
  type GoogleCalendarDisclosure,
} from "@healdesk/catalog";
import type { ReactNode } from "react";

import type { CalendarStep } from "@/lib/setup/calendar";

/**
 * Setup 3.1's Google panel (plan Part E), rendered on the server from
 * calendarStep's answer, for a location Google can be asked about. Before
 * the button: a picture of the warning Google shows while it has not
 * verified healdesk, with its two taps; which account to sign in with, and
 * what the location's agreement says about that kind of account (a non-
 * blocking check of Google's business associate agreement for Workspace, and
 * why a personal @gmail.com account will not connect under Workspace terms);
 * then Google's data-use notice, directly above its unticked box and the
 * Google-branded button, with nothing in between (calendar contract §2).
 *
 * Connected, it says which account and since when, offers Reconnect and
 * Disconnect, and opens the reconnect at once when the connection has
 * stopped working or was made under a notice that has since changed. A pure
 * function of its props, with the two server actions passed in, so tests
 * render it directly.
 */

export type CalendarConnectActions = {
  connect: (form: FormData) => Promise<void>;
  disconnect: (form: FormData) => Promise<void>;
};

type GoogleStep = Extract<CalendarStep, { kind: "google" }>;

export function CalendarConnect(props: {
  slug: string;
  step: GoogleStep;
  /** The day the connection was made, on the clinic's own calendar, or null. */
  connectedOn: string | null;
  actions: CalendarConnectActions;
}) {
  const { connection, account, disclosure } = props.step;
  const signIn = (
    <>
      <BeforeYouSignIn account={account} />
      <SignInForm slug={props.slug} disclosure={disclosure} action={props.actions.connect} />
    </>
  );

  if (connection.status === "not_connected") {
    return (
      <section aria-label="Connect your Google Calendar" className="grid gap-4">
        {connection.accessRemovedAt ? (
          <p className="rounded-xl border border-ink bg-white px-4 py-3 text-sm">
            healdesk&rsquo;s access was removed in your Google Account, so your calendar isn&rsquo;t
            connected now. Connect it again below.
          </p>
        ) : null}
        {signIn}
      </section>
    );
  }

  const broken = connection.status === "error";
  const reconnectNow = broken || !connection.disclosureCurrent;
  const reconnect = (
    <div className="grid gap-4">
      <p className="text-sm">
        Reconnecting asks for Face ID or your screen lock first, because it can change the Google
        account your bookings go into.
      </p>
      {signIn}
    </div>
  );
  return (
    <section aria-label="Your Google Calendar" className="grid gap-4">
      <div className="rounded-xl border border-line bg-white px-4 py-3">
        <p className="font-semibold">
          {broken
            ? "Your calendar connection stopped working"
            : "Your Google Calendar is connected"}
        </p>
        <p className="text-muted mt-1 text-sm">
          Connected as{" "}
          <span className="text-ink font-semibold">
            {connection.account.email ?? "a Google account"}
          </span>{" "}
          ({accountKind(connection.account)}){props.connectedOn ? ` on ${props.connectedOn}` : ""}.
        </p>
        {broken ? (
          <p className="mt-2 text-sm">
            Bookings arrive as requests your team confirms until you reconnect it.
          </p>
        ) : null}
        {!connection.disclosureCurrent ? (
          <p className="mt-2 text-sm">
            The notice you agreed to when you connected has changed. Reconnect to keep using this
            calendar.
          </p>
        ) : null}
        {connection.account.kind === "personal" ? (
          <p className="text-muted mt-2 text-sm">
            This is a personal Google account. {optionFor("personal").description}
          </p>
        ) : null}
      </div>
      {reconnectNow ? (
        <>
          <h2 className="font-semibold">Reconnect</h2>
          {reconnect}
        </>
      ) : (
        <details className="rounded-xl border border-line bg-white px-4 py-3">
          <summary className="min-h-11 cursor-pointer py-2 font-semibold">
            Reconnect, or use another Google account
          </summary>
          <div className="mt-2">{reconnect}</div>
        </details>
      )}
      <form action={props.actions.disconnect} className="grid gap-2">
        <input type="hidden" name="slug" value={props.slug} />
        <button
          type="submit"
          className="border-line min-h-11 justify-self-start rounded-full border px-5 py-2 text-sm font-semibold"
        >
          Disconnect
        </button>
        <p className="text-muted text-sm">
          healdesk then deletes its access to the calendar, and bookings arrive as requests your
          team confirms. Face ID or your screen lock is asked for first.
        </p>
      </form>
    </section>
  );
}

function optionFor(account: CalendarAccount) {
  return CALENDAR_ACCOUNT_OPTIONS.find((option) => option.id === account)!;
}

function accountKind(account: {
  kind: "workspace" | "personal" | null;
  domain: string | null;
}): string {
  if (account.kind === "workspace") {
    return `Google Workspace${account.domain ? `, ${account.domain}` : ""}`;
  }
  return account.kind === "personal" ? "a personal account" : "a Google account";
}

const TRUSTED_APP =
  "If your Google Workspace administrator limits which apps may use Calendar, Google stops the sign-in. Ask them to mark healdesk as trusted first: Admin console › Security › Access and data control › API controls › Manage third-party app access.";

/** Everything the plan puts before the button, none of which stops anyone signing in. */
function BeforeYouSignIn({ account }: { account: CalendarAccount }) {
  const terms = optionFor(account);
  const workspace = account !== "personal";
  return (
    <div className="grid gap-4">
      <GoogleWarningPicture />
      <p className="text-sm">
        Sign in with the Google account whose calendar holds your appointments. Many practices use a
        shared account, such as bookings@yourpractice.com.
        {workspace
          ? " Use your practice's Workspace account: Google tells healdesk when an account is a personal one (@gmail.com), and a personal account won't connect under your agreement."
          : ""}
      </p>
      <div className="rounded-xl border border-line bg-white px-4 py-3 text-sm">
        <p className="font-semibold">
          Which Google account bookings go into, as your agreement with healdesk records it
        </p>
        <p className="mt-1">{terms.title}</p>
        <p className="text-muted mt-1">
          {terms.description}
          {account === "workspace_baa"
            ? " If you're not sure your administrator accepted it, ask them before you connect."
            : ""}
        </p>
      </div>
      {workspace ? <p className="text-sm">{TRUSTED_APP}</p> : null}
    </div>
  );
}

/**
 * Google's warning for an app it has not verified, drawn rather than
 * pictured (no screenshot of Google's page is ours to ship), with its two
 * taps numbered. Worded with "if", so it stays true once Google has verified
 * healdesk and stops showing the warning.
 */
function GoogleWarningPicture() {
  return (
    <figure className="rounded-xl border border-line bg-white px-4 py-3">
      <div aria-hidden="true" className="rounded-lg border border-line bg-paper px-4 py-3 text-sm">
        <p className="font-semibold">Google hasn&rsquo;t verified this app</p>
        <p className="text-muted mt-1">
          The app is requesting access to sensitive info in your Google Account.
        </p>
        <p className="mt-3 flex items-center gap-2">
          <Tap n={1} />
          <span className="font-semibold underline">Advanced</span>
        </p>
        <p className="mt-2 flex items-center gap-2">
          <Tap n={2} />
          <span className="font-semibold underline">Go to healdesk (unsafe)</span>
        </p>
      </div>
      <figcaption className="mt-3 text-sm">
        If Google shows this warning, tap <strong>Advanced</strong>, then{" "}
        <strong>Go to healdesk (unsafe)</strong>. Google shows it for apps it hasn&rsquo;t finished
        verifying; the next page lists exactly what healdesk asks for.
      </figcaption>
    </figure>
  );
}

function Tap({ n }: { n: number }) {
  return (
    <span className="bg-ink inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white">
      {n}
    </span>
  );
}

/** The notice, then the unticked box and the button, with nothing in between. */
function SignInForm(props: {
  slug: string;
  disclosure: GoogleCalendarDisclosure;
  action: (form: FormData) => Promise<void>;
}) {
  const { disclosure } = props;
  const last = disclosure.paragraphs.length - 1;
  return (
    <form action={props.action} className="grid gap-3">
      <input type="hidden" name="slug" value={props.slug} />
      <input type="hidden" name="disclosureVersion" value={disclosure.version} />
      <section className="rounded-xl border border-line bg-white px-4 py-3 text-sm">
        <h2 className="text-base font-semibold">{disclosure.heading}</h2>
        {disclosure.paragraphs.map((paragraph, index) => (
          <p key={index} className="mt-2">
            {index === last ? (
              <>
                {withLimitedUseLink(paragraph, disclosure)}{" "}
                <a href={disclosure.privacyHref} className="font-semibold underline">
                  Our privacy notice
                </a>{" "}
                says more.
              </>
            ) : (
              paragraph
            )}
          </p>
        ))}
      </section>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" name="disclosure" value="accepted" required className="mt-1" />
        <span>{disclosure.tickLabel}</span>
      </label>
      <button
        type="submit"
        className="inline-flex min-h-11 items-center gap-3 justify-self-start rounded-full border border-[#747775] bg-white px-5 py-2 text-sm font-semibold text-[#1f1f1f]"
      >
        <GoogleMark />
        Sign in with Google
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
      <a href={disclosure.limitedUse.href} className="font-semibold underline">
        {disclosure.limitedUse.linkText}
      </a>
      {paragraph.slice(at + disclosure.limitedUse.linkText.length)}
    </>
  );
}

/** Google's "G", as its sign-in button guidelines draw it. */
function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" width="18" height="18">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
