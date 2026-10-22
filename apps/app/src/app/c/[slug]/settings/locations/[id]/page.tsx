import type { Metadata } from "next";
import { notFound } from "next/navigation";

import type { OpeningHours } from "@/lib/clinic/opening-hours";
import { requirePortal } from "@/lib/portal/access";
import { locationName, readLocationForPage } from "@/lib/portal/location-details";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { sectionPath } from "@/lib/portal/nav";
import { formatPhone } from "@/lib/setup/help";
import { withTenant } from "@/lib/tenant";

import { FeedbackProvider } from "../../../feedback";
import type { HoursInitial } from "../../../editors";
import { PortalShell } from "../../../PortalShell";

import { LocationDetailsForm } from "./LocationDetailsForm";

export const metadata: Metadata = { title: "Location · healdesk", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * A later location's details, one level under Settings (spec: "nothing
 * nested more than one level deep"): the page the toast after adding a
 * location, and the location_added email, send the practice to, "confirm its
 * address, hours and phone numbers". Each field saves as it goes; "Confirm
 * these details" marks them confirmed (lib/portal/location-details.ts).
 *
 * No step-up to open it: it shows the practice's own business details, no
 * patient. Changing the address, the direct line or the transfer number asks
 * for one when it is made. The location is read inside the signed-in
 * clinic's tenant, so an id from another account, the main location, a
 * retired one or anything else is a 404.
 */
export default async function LocationDetailsPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const portal = await requirePortal(slug);
  const now = new Date();
  const page = await loadPortalPage(portal, now);
  if (!page) notFound();
  if (page.state.clinic.offboardingStartedAt) notFound();
  const found = await withTenant({ clinicId: portal.clinicId, actor: page.actorContext }, (tx) =>
    readLocationForPage(tx, id),
  );
  if (!found) notFound();
  const { location, needsDirectLine } = found;
  const name = locationName(location);
  const shell = shellProps(portal, page, "settings");

  return (
    <PortalShell {...shell}>
      <p className="text-sm">
        <a href={sectionPath(portal.clinicSlug, "settings")} className="text-muted underline">
          Settings
        </a>
      </p>
      <h1 className="mt-2 text-2xl font-semibold">{name}</h1>
      <p className="text-muted mt-2">
        {location.detailsConfirmedAt
          ? "Its details are confirmed. Each change saves the moment you make it."
          : "Confirm its address, hours and phone numbers. Each one saves as you go."}
      </p>
      <FeedbackProvider>
        <LocationDetailsForm
          slug={portal.clinicSlug}
          locationId={location.id}
          name={name}
          address={location.address ?? ""}
          hours={location.openingHours ? asEditorHours(location.openingHours) : null}
          publishedPhone={
            location.publishedPhoneE164 ? formatPhone(location.publishedPhoneE164) : ""
          }
          directLine={location.directLineE164 ? formatPhone(location.directLineE164) : ""}
          transfer={location.transferE164 ? formatPhone(location.transferE164) : ""}
          needsDirectLine={needsDirectLine}
          confirmed={location.detailsConfirmedAt !== null}
        />
      </FeedbackProvider>
    </PortalShell>
  );
}

function asEditorHours(hours: OpeningHours): HoursInitial {
  return {
    mon: hours.mon.map(([a, b]) => [a, b]),
    tue: hours.tue.map(([a, b]) => [a, b]),
    wed: hours.wed.map(([a, b]) => [a, b]),
    thu: hours.thu.map(([a, b]) => [a, b]),
    fri: hours.fri.map(([a, b]) => [a, b]),
    sat: hours.sat.map(([a, b]) => [a, b]),
    sun: hours.sun.map(([a, b]) => [a, b]),
  };
}
