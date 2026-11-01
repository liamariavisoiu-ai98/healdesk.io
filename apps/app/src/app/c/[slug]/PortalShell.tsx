import type { Channel } from "@healdesk/catalog";
import type { ReactNode } from "react";

import wordmark from "@/brand/healdesk-wordmark.webp";
import type { PortalGrant } from "@/lib/portal/access";
import type { AnsweringControl, AnsweringStatus } from "@/lib/portal/header";
import { notYetLine, portalNav, sectionPath, type PortalSection } from "@/lib/portal/nav";

import { signOut } from "./actions";
import { HelpPanel } from "./HelpPanel";
import { PauseSwitch } from "./PauseSwitch";

/**
 * The frame every portal screen sits in (plan Part F0; redesigned with the
 * owner, 1 November 2026): healdesk's mark and the clinic's name, the
 * six-item menu as a sidebar from a laptop up and a row of pills on a phone,
 * Help and Sign out; then the line or switch about AYA, the screen, and Help
 * again at the foot of the page (spec: "Help on every screen"). A location
 * switcher only when the sign-in opens several accounts.
 *
 * A server component with no data of its own: each page calls requirePortal
 * itself and passes what it read, because a layout does not re-run on client
 * navigation and must never be the only guard (lib/portal/access.ts).
 *
 * Mobile first (Part F8): one column on a phone. Every target is at least
 * 44px tall, and nothing moves: there is no animation to reduce.
 */

export type ShellProps = {
  slug: string;
  clinicName: string;
  section: PortalSection;
  audience: "patients" | "clients";
  status: AnsweringStatus;
  /** The AYA is answering switch, after go-live (lib/portal/header.ts); null shows the line alone. */
  answering?: AnsweringControl | null;
  /** The channels that have gone live, for what the menu's unbuilt screens say. */
  liveChannels?: readonly Channel[];
  timeZone: string;
  /**
   * Every account this sign-in opens: separate practices that share one email
   * address, never the locations of one account, which AYA answers for
   * together. The switcher shows only when there are several.
   */
  locations: readonly PortalGrant[];
  /** The patient screens the menu links to (openPatientScreens). */
  opened?: readonly PortalSection[];
  children: ReactNode;
};

export function PortalShell(props: ShellProps) {
  const nav = portalNav(props.slug, props.section, props.opened, props.liveChannels ?? []);
  const links = nav.filter((item) => item.href !== null);
  const notYet = notYetLine(nav);
  const others = props.locations.filter((l) => l.slug !== props.slug);

  const clinic =
    others.length > 0 ? (
      <AccountSwitcher current={props.clinicName} others={others} section={props.section} />
    ) : (
      <p className="text-muted text-sm font-semibold">{props.clinicName}</p>
    );

  return (
    // portal-glow: the sign-in pages' light, faint, in the top corner (globals.css).
    <div className="portal-glow min-h-screen lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded-full focus:bg-white focus:px-4 focus:py-2"
      >
        Skip to the page
      </a>

      {/* The menu: a sidebar from a laptop up, a row of pills on a phone
          (portal redesign, owner, 1 November 2026). The same links either
          way, in the spec's order. */}
      <header className="border-line bg-white/70 px-4 pt-5 pb-3 backdrop-blur lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:border-r lg:px-4 lg:pt-7 lg:pb-6">
        <div className="flex items-center justify-between gap-3 lg:block">
          <div className="lg:px-3">
            <Brand />
            <div className="mt-1 lg:mt-2">{clinic}</div>
          </div>
          <div className="flex items-center gap-2 lg:hidden">
            <a
              href="#help"
              className="border-line inline-flex min-h-11 items-center rounded-full border bg-white px-4 text-sm font-semibold"
            >
              Help
            </a>
            <form action={signOut}>
              <button
                type="submit"
                className="border-line min-h-11 rounded-full border bg-white px-4 text-sm font-semibold"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>

        <nav aria-label="Portal" className="mt-4 lg:mt-8">
          <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:mx-0 lg:grid lg:gap-1 lg:overflow-visible lg:px-0">
            {links.map((item) => (
              <li key={item.section} className="shrink-0">
                <a
                  href={item.href}
                  aria-current={item.current ? "page" : undefined}
                  className={`flex min-h-11 items-center gap-3 rounded-full px-4 text-sm font-semibold whitespace-nowrap lg:rounded-sm lg:px-3 ${
                    item.current
                      ? "bg-ink text-white"
                      : "border-line border bg-white lg:border-transparent lg:bg-transparent lg:hover:bg-paper-2"
                  }`}
                >
                  <NavIcon section={item.section} />
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
          {notYet ? <p className="text-muted mt-2 text-sm lg:px-3">{notYet}</p> : null}
        </nav>

        <div className="mt-auto hidden gap-2 px-3 pt-8 lg:grid">
          <a href="#help" className="text-muted inline-flex min-h-11 items-center text-sm font-semibold">
            Help
          </a>
          <form action={signOut}>
            <button type="submit" className="text-muted min-h-11 text-sm font-semibold">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-4 pb-10 lg:px-10 lg:pt-4">
        {props.answering ? (
          <PauseSwitch slug={props.slug} control={props.answering} />
        ) : (
          <StatusLine
            slug={props.slug}
            status={props.status}
            audience={props.audience}
            timeZone={props.timeZone}
          />
        )}

        <main id="main" className="mt-8 scroll-mt-6">
          {props.children}
        </main>

        <HelpPanel audience={props.audience} />
      </div>
    </div>
  );
}

/**
 * healdesk's wordmark, the logo itself as on the site and the sign-in pages
 * (owner, 1 November 2026: the portal's shared parts in the sign-in look),
 * in place of the orange dot and the name typed out. The same static asset
 * as sign-in, served from this app (app/sign-in/shell.tsx says why).
 */
function Brand() {
  return (
    <img
      src={wordmark.src}
      width={wordmark.width}
      height={wordmark.height}
      alt="healdesk"
      draggable={false}
      className="block h-6 w-auto select-none lg:h-7"
    />
  );
}

/** A line icon for each screen; decorative, the label carries the meaning. */
function NavIcon({ section }: { section: PortalSection }) {
  const paths: Record<PortalSection, string> = {
    home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
    settings: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
    knowledge: "M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2zM4 21V5M8 7h6",
    conversations: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z",
    bookings: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M8 3v4M16 3v4",
    billing: "M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 10h20",
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="hidden h-[18px] w-[18px] shrink-0 lg:block"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[section]} />
    </svg>
  );
}

/**
 * The header's slot about AYA where it holds no switch (lib/portal/header.ts):
 * before go-live it says she isn't answering yet and links to the build
 * tracker; with every live channel switched Off in Settings, it says so.
 * After go-live the slot is the AYA is answering switch (PauseSwitch.tsx).
 */
function StatusLine(props: {
  slug: string;
  status: AnsweringStatus;
  audience: "patients" | "clients";
  timeZone: string;
}) {
  const box = "mt-4 rounded-md border px-4 py-3 text-sm font-semibold";
  switch (props.status.kind) {
    case "not_yet":
      return (
        <p className={`${box} border-line bg-paper-2`}>
          AYA isn&rsquo;t answering {props.audience} yet.{" "}
          <a href={`/c/${props.slug}#tracker`} className="underline underline-offset-2">
            See where she&rsquo;s up to
          </a>
          .
        </p>
      );
    case "answering":
      return <p className={`${box} border-line bg-white`}>AYA is answering.</p>;
    case "off":
      return (
        <p className={`${box} border-line bg-paper-2`}>
          Every channel is switched off in Settings, so AYA isn&rsquo;t answering.
        </p>
      );
    case "paused":
      return (
        <p className={`${box} border-line bg-paper-2`}>
          AYA is paused
          {props.status.until
            ? ` until ${formatPauseEnd(props.status.until, props.timeZone)}`
            : " until someone turns her back on"}
          .
        </p>
      );
  }
}

function formatPauseEnd(until: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
    }).format(until);
  } catch {
    return until.toISOString();
  }
}

/**
 * The account's name, and the other accounts this sign-in opens, each a link
 * to the same screen there. They are separate accounts that share one email
 * address (a business that bought a second account at checkout with the same
 * address), not locations: the locations of one account share it, and its
 * one AYA, so switching between them is never this. A disclosure rather than
 * a select, so it works without a script.
 */
function AccountSwitcher(props: {
  current: string;
  others: readonly PortalGrant[];
  section: PortalSection;
}) {
  return (
    <details className="relative">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-lg font-semibold">
        {props.current}
        <span className="text-muted text-sm font-normal">· switch account</span>
      </summary>
      <ul
        aria-label="Other accounts"
        className="border-line mt-2 grid gap-1 rounded-md border bg-white p-2"
      >
        {props.others.map((account) => (
          <li key={account.slug}>
            <a
              href={sectionPath(account.slug, props.section)}
              className="flex min-h-11 items-center rounded-sm px-3 font-semibold hover:bg-paper-2"
            >
              {account.name}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
