import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requirePortal } from "@/lib/portal/access";
import { sectionPath } from "@/lib/portal/nav";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { previewAccess } from "@/lib/preview/talk";
import { joinWords } from "@/lib/setup/tracker";

import { PortalShell } from "../PortalShell";

import { PreviewChat } from "./PreviewChat";

export const metadata: Metadata = { title: "Talk to your AYA · healdesk", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * Talk to your AYA (plan Part G; spec, Home: "Before go-live, the build
 * tracker, then Talk to your AYA: a preview of the clinic's own assistant,
 * where nothing reaches patients and nothing is booked"). Under Home, one
 * level deep.
 *
 * Open once every blocking stage of the build tracker is done; until then it
 * names what is left and links back to the tracker, as Home's locked button
 * does. Nothing here is about a patient, so no step-up; the conversation is
 * held by the browser (PreviewChat) and stored nowhere (lib/preview/talk.ts).
 */
export default async function PreviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const portal = await requirePortal(slug);
  const now = new Date();
  const page = await loadPortalPage(portal, now);
  if (!page) notFound();
  const shell = shellProps(portal, page, "home");
  const home = sectionPath(portal.clinicSlug, "home");
  const access = await previewAccess({
    clinicId: portal.clinicId,
    userId: portal.userId,
    actor: page.actorContext,
    now,
  });

  return (
    <PortalShell {...shell}>
      <h1 className="text-2xl font-semibold">Talk to your AYA</h1>
      {access.status === "closed" ? (
        <p className="border-line mt-6 rounded-md border bg-white px-4 py-3">
          This account has closed.
        </p>
      ) : access.status === "locked" ? (
        <section aria-labelledby="locked-heading" className="mt-6">
          <h2 id="locked-heading" className="sr-only">
            Not open yet
          </h2>
          <p className="border-line rounded-md border bg-white px-4 py-3">
            The preview opens when every stage of the build is done. Still to come:{" "}
            {joinWords(access.left.map((l) => l.toLowerCase()))}.
          </p>
          <ul className="mt-3 grid gap-2">
            {access.stages
              .filter((stage) => stage.blocks && stage.state !== "done")
              .map((stage) => (
                <li key={stage.id} className="border-line rounded-md border bg-white px-4 py-3">
                  <p className="font-semibold">{stage.label}</p>
                  <p className="text-muted mt-1 text-sm">{stage.detail}</p>
                </li>
              ))}
          </ul>
          <p className="mt-4 text-sm">
            <a href={`${home}#tracker`} className="font-semibold underline">
              See where the build is
            </a>
          </p>
        </section>
      ) : (
        <>
          <p
            id="preview-banner"
            className="border-ink bg-tint-butter mt-6 rounded-md border-2 px-4 py-3 font-semibold"
          >
            Preview: nothing here reaches {shell.audience}, and nothing is booked.
          </p>
          <p className="text-muted mt-4">
            Ask what your {shell.audience} ask. AYA answers from Your practice and Settings, with
            the line she opens every chat with. Please type made-up details, never a real{" "}
            {shell.audience === "clients" ? "client's" : "patient's"}. Nothing here is kept: leaving
            the page ends the conversation.
          </p>
          <PreviewChat slug={portal.clinicSlug} opening={access.opening} homeHref={home} />
        </>
      )}
    </PortalShell>
  );
}
