import { US_TIME_ZONES } from "@healdesk/catalog";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { clinicLocalDate } from "@/lib/clinic/closures";
import { requirePortal } from "@/lib/portal/access";
import { portalDay } from "@/lib/portal/format";
import { depositShown, hoursStatusLine, readClinicDefaultDeposit } from "@/lib/portal/knowledge";
import { isBuiltSection, sectionPath } from "@/lib/portal/nav";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { formatPhone } from "@/lib/setup/help";
import { serviceInputOf } from "@/lib/setup/knowledge";
import { loadWebsiteChanges, WEBSITE_ANCHOR } from "@/lib/website/store";
import { WEBSITE_CHANGE_SECTION_NAMES } from "@/lib/website/types";

import type { HoursInitial } from "../editors";
import { FeedbackProvider } from "../feedback";
import { PortalShell } from "../PortalShell";
import { EmptyState } from "../states";

import {
  HoursForm,
  NeverSayForm,
  PoliciesForm,
  PracticeForm,
  PricesForm,
  PromotionsForm,
  QuickAnswersForm,
  Section,
} from "./KnowledgeForms";
import { WebsiteChangesList } from "./WebsiteChanges";

export const metadata: Metadata = { title: "Knowledge · healdesk", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * Knowledge (plan Part F3; spec, "Knowledge: quick edits, no re-scrape
 * needed"): what AYA may say about the practice. The practice and its
 * policies; prices, with how each is priced, its length and its deposit;
 * promotions, under "AYA mentions these", which is Settings' switch; quick
 * answers; the never-say list, editable, with the clinical defaults one tap
 * away; and the hours with the days the practice is closed.
 *
 * Every text is screened before it is stored and a refusal names the phrase
 * (lib/portal/knowledge.ts). Nothing here is about a patient, so no step-up.
 * First, while there is any, "Changes on your website": what a read of the
 * practice's own website found that Knowledge does not say, to confirm into
 * the sections below or ignore (lib/website).
 */
export default async function KnowledgePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const portal = await requirePortal(slug);
  const now = new Date();
  const page = await loadPortalPage(portal, now);
  if (!page) notFound();
  const shell = shellProps(portal, page, "knowledge");
  const { clinic, knowledge, settings, closures } = page.state;

  if (clinic.offboardingStartedAt) {
    return (
      <PortalShell {...shell}>
        <h1 className="text-2xl font-semibold">Knowledge</h1>
        <div className="mt-6">
          <EmptyState>This account has closed, so there is nothing left to change.</EmptyState>
        </div>
      </PortalShell>
    );
  }

  const settingsHref = isBuiltSection("settings")
    ? `${sectionPath(portal.clinicSlug, "settings")}#how-aya-talks`
    : null;
  const promotionsSold = page.state.channels.some(
    (c) => c.channel === "voice" || c.channel === "web",
  );
  const clinicDefaultDeposit = await readClinicDefaultDeposit(
    portal.clinicId,
    page.actorContext,
  );
  const website = await loadWebsiteChanges(portal.clinicId, page.actorContext);
  const hoursStatus = await hoursStatusLine(portal.clinicId, page.actorContext, clinic.timezone, now);
  const lastRead = website.lastReadAt ?? (website.baseline ? website.baseline.readAt : null);

  return (
    <PortalShell {...shell}>
      <h1 className="text-2xl font-semibold">Knowledge</h1>
      <p className="text-muted mt-2">
        What AYA may say about your practice. Each part saves on its own, and AYA uses it at once.
        Leave out anything medical: AYA passes those questions to your team.
      </p>
      <FeedbackProvider>
        <div className="mt-6 grid gap-6">
          {website.changes.length > 0 ? (
            <Section
              id={WEBSITE_ANCHOR}
              title="Changes on your website"
              intro={`We read ${website.baseline?.website ?? "your website"}${lastRead ? ` on ${portalDay(lastRead, clinic.timezone, now)}` : ""} and found what AYA doesn't know yet. Confirm a change and AYA uses it; ignore it and we won't raise it again.`}
            >
              <WebsiteChangesList
                slug={portal.clinicSlug}
                changes={website.changes.map((change) => ({
                  id: change.id,
                  sectionName: WEBSITE_CHANGE_SECTION_NAMES[change.section],
                  text: change.text,
                  detail: change.detail,
                  canConfirm: change.canConfirm,
                }))}
                providersHref={
                  isBuiltSection("settings")
                    ? `${sectionPath(portal.clinicSlug, "settings")}#calendar`
                    : null
                }
              />
            </Section>
          ) : null}

          <Section id="practice" title="Your practice">
            <PracticeForm
              slug={portal.clinicSlug}
              initial={{
                name: clinic.name,
                address: clinic.address ?? "",
                phone: clinic.publishedPhoneE164 ? formatPhone(clinic.publishedPhoneE164) : "",
                website: clinic.website ?? "",
                timezone: clinic.timezone,
              }}
              zones={US_TIME_ZONES}
              audience={shell.audience}
            />
          </Section>

          <Section
            id="policies"
            title="Policies"
            intro="Cancellations, late arrivals, payment: one per line, in your own words."
          >
            <PoliciesForm slug={portal.clinicSlug} initial={knowledge.policies} />
          </Section>

          <Section
            id="prices"
            title="Prices"
            intro="AYA quotes only these prices; anything else becomes an offer to book a consultation. A deposit here is asked for when Take deposits is on in Settings."
          >
            <PricesForm
              slug={portal.clinicSlug}
              initial={knowledge.services.map((service) => {
                const input = serviceInputOf(service);
                return {
                  name: input.name,
                  priceKind: input.priceKind,
                  price: input.price === null ? "" : String(input.price),
                  maxPrice: input.maxPrice === null ? "" : String(input.maxPrice),
                  unit: input.unit ?? "",
                  duration: input.durationMinutes === null ? "" : String(input.durationMinutes),
                  deposit: depositShown(input.depositUsd, clinicDefaultDeposit),
                  depositUsd: input.depositUsd ?? null,
                };
              })}
            />
          </Section>

          <Section
            id="promotions"
            title="Promotions"
            intro={
              <>
                {promotionsSold ? (
                  <>
                    AYA mentions these: {settings.mentionPromotions ? "On" : "Off"}
                    {settingsHref ? (
                      <>
                        {" · "}
                        <a href={settingsHref} className="text-ink font-semibold underline">
                          change
                        </a>
                      </>
                    ) : null}
                    . On phone and website chat only.
                  </>
                ) : (
                  "AYA mentions promotions on phone and website chat only, so these wait until you have one of them."
                )}
              </>
            }
          >
            <PromotionsForm slug={portal.clinicSlug} initial={knowledge.promotions ?? ""} />
          </Section>

          <Section
            id="quick-answers"
            title="Quick answers"
            intro="Questions and your answers, for temporary things like parking during building work. A correction added with Flag this answer in Conversations lands here, marked as one."
          >
            <QuickAnswersForm
              slug={portal.clinicSlug}
              initial={knowledge.quickAnswers.map((a) => ({
                question: a.question,
                answer: a.answer,
                ...(a.flagId ? { flagId: a.flagId } : {}),
              }))}
            />
          </Section>

          <Section
            id="never-say"
            title="Never say"
            intro="Phrases AYA must never use, on every channel: calls, website chat, Instagram, Messenger and WhatsApp. It starts with the clinical defaults; add your own. The protections themselves stay in AYA, whatever this list holds."
          >
            <NeverSayForm slug={portal.clinicSlug} initial={knowledge.neverSay} />
          </Section>

          <Section
            id="hours"
            title="Hours"
            intro={
              <>
                When you&rsquo;re open, and the days you&rsquo;re closed. AYA tells people, offers no
                appointments on a closed day, and phone follows these hours.
                {hoursStatus ? <span className="mt-1 block">{hoursStatus}</span> : null}
              </>
            }
          >
            <HoursForm
              slug={portal.clinicSlug}
              initial={(clinic.openingHours as unknown as HoursInitial | null) ?? null}
              closures={closures.map((c) => ({ closedOn: c.closedOn, label: c.label ?? "" }))}
              today={clinicLocalDate(now, clinic.timezone)}
            />
          </Section>
        </div>
      </FeedbackProvider>
    </PortalShell>
  );
}
