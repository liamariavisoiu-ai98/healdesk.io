import type { ReactNode } from "react";

import type { PortalGrant } from "@/lib/portal/access";
import type { AnsweringStatus } from "@/lib/portal/header";
import { portalNav, sectionPath, type PortalSection } from "@/lib/portal/nav";

import { signOut } from "./actions";
import { HelpPanel } from "./HelpPanel";

/**
 * The frame every portal screen sits in (plan Part F0): the clinic's name,
 * Help and Sign out; the header's line about AYA; the six-item menu; a
 * location switcher only when the sign-in opens several locations; the
 * screen; and Help again at the foot of the page (spec: "Help on every
 * screen").
 *
 * A server component with no data of its own: each page calls requirePortal
 * itself and passes what it read, because a layout does not re-run on client
 * navigation and must never be the only guard (lib/portal/access.ts).
 *
 * One column, mobile first (Part F8). Every target is at least 44px tall, and
 * nothing moves: there is no animation to reduce.
 */

export type ShellProps = {
  slug: string;
  clinicName: string;
  section: PortalSection;
  audience: "patients" | "clients";
  status: AnsweringStatus;
  timeZone: string;
  /** Every clinic this sign-in opens; the switcher shows only when there are several. */
  locations: readonly PortalGrant[];
  children: ReactNode;
};

export function PortalShell(props: ShellProps) {
  const nav = portalNav(props.slug, props.section, { live: props.status.kind !== "not_yet" });
  const others = props.locations.filter((l) => l.slug !== props.slug);

  return (
    <div className="mx-auto min-h-screen max-w-2xl px-4 pb-10">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded-full focus:bg-white focus:px-4 focus:py-2"
      >
        Skip to the page
      </a>
      <header className="pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {others.length > 0 ? (
            <LocationSwitcher current={props.clinicName} others={others} section={props.section} />
          ) : (
            <p className="text-lg font-semibold">{props.clinicName}</p>
          )}
          <div className="flex items-center gap-2">
            <a
              href="#help"
              className="border-line inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold"
            >
              Help
            </a>
            <form action={signOut}>
              <button
                type="submit"
                className="border-line min-h-11 rounded-full border px-4 text-sm font-semibold"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>

        <StatusLine
          slug={props.slug}
          status={props.status}
          audience={props.audience}
          timeZone={props.timeZone}
        />

        <nav aria-label="Portal" className="mt-4">
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {nav.map((item) =>
              item.href !== null ? (
                <li key={item.section}>
                  <a
                    href={item.href}
                    aria-current={item.current ? "page" : undefined}
                    className={`flex min-h-11 items-center justify-center rounded-xl border px-2 py-2 text-center text-sm font-semibold ${
                      item.current ? "border-ink bg-ink text-white" : "border-line bg-white"
                    }`}
                  >
                    {item.label}
                  </a>
                </li>
              ) : (
                <li key={item.section}>
                  <span
                    aria-disabled="true"
                    className="border-line bg-paper-2 text-muted flex min-h-11 flex-col items-center justify-center rounded-xl border px-2 py-1 text-center text-sm"
                  >
                    <span className="font-semibold">{item.label}</span>
                    <span className="text-xs">{item.note}</span>
                  </span>
                </li>
              ),
            )}
          </ul>
        </nav>
      </header>

      <main id="main" className="mt-8 scroll-mt-6">
        {props.children}
      </main>

      <HelpPanel audience={props.audience} />
    </div>
  );
}

/**
 * The header's slot about AYA (lib/portal/header.ts). Before go-live it says
 * she isn't answering yet and links to the build tracker; after it, M6 puts
 * the AYA is answering switch here.
 */
function StatusLine(props: {
  slug: string;
  status: AnsweringStatus;
  audience: "patients" | "clients";
  timeZone: string;
}) {
  const box = "mt-4 rounded-xl border px-4 py-3 text-sm font-semibold";
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
 * The clinic's name, and the other locations this sign-in opens, each a link
 * to the same screen there. A disclosure rather than a select, so it works
 * without a script.
 */
function LocationSwitcher(props: {
  current: string;
  others: readonly PortalGrant[];
  section: PortalSection;
}) {
  return (
    <details className="relative">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-lg font-semibold">
        {props.current}
        <span className="text-muted text-sm font-normal">· switch location</span>
      </summary>
      <ul
        aria-label="Other locations"
        className="border-line mt-2 grid gap-1 rounded-xl border bg-white p-2"
      >
        {props.others.map((location) => (
          <li key={location.slug}>
            <a
              href={sectionPath(location.slug, props.section)}
              className="flex min-h-11 items-center rounded-lg px-3 font-semibold hover:bg-paper-2"
            >
              {location.name}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
