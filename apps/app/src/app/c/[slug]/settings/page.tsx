import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requirePortal } from "@/lib/portal/access";
import { readSignInFactors } from "@/lib/portal/devices";
import { portalDay, portalMoment } from "@/lib/portal/format";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { readCalendarCard } from "@/lib/portal/settings-calendar";
import { readSettingsView } from "@/lib/portal/settings-view";
import { sessionBinding } from "@/lib/portal/step-up";

import { PortalShell } from "../PortalShell";

import { FeedbackProvider } from "../feedback";
import { CalendarCard } from "./CalendarCard";
import {
  AlertsCard,
  ChannelsCard,
  PaymentsCard,
  SafetyNetCard,
  TalkCard,
} from "./SettingsCards";
import { SignInCard } from "./SignInCard";

export const metadata: Metadata = { title: "Settings · healdesk", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * Settings (plan Part F2; spec, "Settings: every switch on one page, in
 * cards"): Channels, How AYA talks, Calendar, Payments, Safety net, Alerts
 * and Sign-in, for the channels the clinic bought. Each switch saves the
 * moment it changes and says what it did (actions.ts, lib/portal/settings.ts);
 * the Calendar card's are calendar-actions.ts, and Sign-in's devices, backup
 * and "Someone left" are sign-in-actions.ts. A sign-in with Google comes
 * back here with `?calendar=<outcome>`.
 *
 * No step-up to open the page: it shows no patient. The changes that send
 * calls or money somewhere new ask for one when they are made.
 */
export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ connect?: string | string[]; calendar?: string | string[] }>;
}) {
  const { slug } = await params;
  const portal = await requirePortal(slug);
  const now = new Date();
  const page = await loadPortalPage(portal, now);
  if (!page) notFound();
  const shell = shellProps(portal, page, "settings");

  if (page.state.clinic.offboardingStartedAt) {
    return (
      <PortalShell {...shell}>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="border-line mt-6 rounded-xl border bg-white px-4 py-3">
          This account has closed, so there is nothing left to change.
        </p>
      </PortalShell>
    );
  }

  const view = await readSettingsView({
    slug: portal.clinicSlug,
    state: page.state,
    actor: page.actorContext,
    now,
  });
  const { connect, calendar } = await searchParams;
  const calendarCard = await readCalendarCard({
    slug: portal.clinicSlug,
    clinicId: portal.clinicId,
    clinicName: page.state.clinic.name,
    settings: page.state.settings,
    actor: page.actorContext,
    outcome: calendar,
  });
  const factors = await readSignInFactors(portal.userId, await sessionBinding(portal));
  const tz = page.state.clinic.timezone;
  const settingsPath = `/c/${portal.clinicSlug}/settings`;

  return (
    <PortalShell {...shell}>
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="text-muted mt-2">Every switch saves the moment you change it.</p>
      <FeedbackProvider>
        <div className="mt-6 grid gap-6">
          <ChannelsCard view={view} />
          <TalkCard view={view} />
          <CalendarCard card={calendarCard} timeZone={page.state.clinic.timezone} now={now} />
          <PaymentsCard view={view} connectOutcome={typeof connect === "string" ? connect : null} />
          <SafetyNetCard view={view} />
          <AlertsCard view={view} />
          <SignInCard
            slug={portal.clinicSlug}
            address={page.state.address}
            devices={factors.devices.map((d) => ({
              id: d.id,
              label: d.label,
              added: `Added ${portalDay(d.addedAt, tz, now)}`,
              lastUsed: d.lastUsedAt ? `last used ${portalMoment(d.lastUsedAt, tz, now)}` : null,
              isThisSession: d.isThisSession,
            }))}
            hasBackup={factors.hasBackup}
            backupCodesLeft={factors.backupCodesLeft}
            addDeviceHref={`/c/${portal.clinicSlug}/protect?next=${encodeURIComponent(settingsPath)}`}
            addBackupHref={`/c/${portal.clinicSlug}/setup?s=backup`}
          />
        </div>
      </FeedbackProvider>
    </PortalShell>
  );
}
