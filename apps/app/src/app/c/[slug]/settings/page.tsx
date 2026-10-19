import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { COVERAGE_MODE_OPTIONS, type CoverageModeId } from "@healdesk/catalog";

import { readPhoneStepsNumber } from "@/lib/channels/state";
import { requirePortal } from "@/lib/portal/access";
import { readSignInFactors } from "@/lib/portal/devices";
import { portalDay, portalMoment } from "@/lib/portal/format";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { readCalendarCard } from "@/lib/portal/settings-calendar";
import { readSettingsView } from "@/lib/portal/settings-view";
import { sessionBinding } from "@/lib/portal/step-up";
import { loadOpenAddressChange } from "@/lib/sign-in/address-change";
import { forwardingView, type ForwardingView } from "@/lib/setup/forwarding";
import { readForwardingTest } from "@/lib/setup/forwarding-test-view";
import { formatPhone } from "@/lib/setup/help";
import { snippetOpen, widgetSnippet } from "@/lib/setup/snippet";
import { withTenant } from "@/lib/tenant";

import { PortalShell } from "../PortalShell";

import { AddressControl } from "./AddressControl";
import { FeedbackProvider } from "../feedback";
import { CalendarCard } from "./CalendarCard";
import {
  AlertsCard,
  ChannelsCard,
  PaymentsCard,
  SafetyNetCard,
  TalkCard,
  type SettingsForwarding,
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
  searchParams: Promise<{ connect?: string | string[]; calendar?: string | string[]; meta?: string | string[] }>;
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
  const { connect, calendar, meta } = await searchParams;
  const calendarCard = await readCalendarCard({
    slug: portal.clinicSlug,
    clinicId: portal.clinicId,
    clinicName: page.state.clinic.name,
    settings: page.state.settings,
    actor: page.actorContext,
    outcome: calendar,
  });
  const ayaNumber = await withTenant({ clinicId: portal.clinicId, actor: page.actorContext }, (tx) =>
    readPhoneStepsNumber(tx.db, tx.clinicId),
  );
  const forwarding = ayaNumber
    ? await settingsForwarding(portal.clinicId, page.actorContext, ayaNumber, page.state)
    : null;
  const webLine = snippetOpen(page.state.channels.find((c) => c.channel === "web"))
    ? widgetSnippet(page.state.clinic.slug)
    : null;
  const factors = await readSignInFactors(portal.userId, await sessionBinding(portal));
  const tz = page.state.clinic.timezone;
  const settingsPath = `/c/${portal.clinicSlug}/settings`;
  const change = await loadOpenAddressChange(portal.clinicId, page.actorContext);
  const openChange = change
    ? {
        newEmail: change.newEmail,
        state:
          change.status === "awaiting_confirmation"
            ? `We've emailed a link to it, and nothing changes until it's used. The link works until ${portalMoment(change.confirmExpiresAt!, tz, now)}.`
            : `It takes effect at ${portalMoment(change.effectiveAt!, tz, now)}. Until then, sign-in links still come to this address${change.source === "operator" ? ", and we entered it after a call with your practice" : ""}.`,
      }
    : null;

  return (
    <PortalShell {...shell}>
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="text-muted mt-2">Every switch saves the moment you change it.</p>
      <FeedbackProvider>
        <div className="mt-6 grid gap-6">
          <ChannelsCard
            view={view}
            phoneSteps={ayaNumber ? { numberLabel: formatPhone(ayaNumber) } : null}
            forwarding={forwarding}
            webLine={webLine}
            metaOutcome={typeof meta === "string" ? meta : null}
          />
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
            addressControl={<AddressControl slug={portal.clinicSlug} open={openChange} />}
          />
        </div>
      </FeedbackProvider>
    </PortalShell>
  );
}

/**
 * Phone's forwarding steps for Settings → Channels, for each coverage mode,
 * so changing the mode shows its steps at once (spec: "Shows the matching
 * forwarding instructions again whenever it is changed"), with "Test it now"
 * while phone waits on forwarding. Only once phone is ready for forwarding,
 * as in the wizard: AYA's number, and a direct line for the calls AYA cannot
 * take (lib/setup/forwarding.ts).
 */
async function settingsForwarding(
  clinicId: string,
  actor: Parameters<typeof withTenant>[0]["actor"],
  ayaNumber: string,
  state: { clinic: { carrier: string | null; phoneSystemType: string | null }; settings: { directLineE164: string | null } },
): Promise<SettingsForwarding | null> {
  if (!state.settings.directLineE164) return null;
  const views = Object.fromEntries(
    COVERAGE_MODE_OPTIONS.map((o) => [
      o.id,
      forwardingView({
        assistantNumberE164: ayaNumber,
        carrier: state.clinic.carrier,
        phoneSystemType: state.clinic.phoneSystemType,
        coverageMode: o.id,
      }),
    ]),
  ) as Record<CoverageModeId, ForwardingView>;
  const test = await withTenant({ clinicId, actor }, (tx) => readForwardingTest(tx));
  return { views, test };
}
