import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { clientIp } from "@/lib/client-ip";
import {
  confirmAddressChange,
  lookUpAddressLink,
  type AddressLinkProblem,
} from "@/lib/sign-in/address-change";

export const metadata: Metadata = {
  title: "Confirm your address · healdesk",
  // The token is in the URL: no referrer leaves this page.
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * /address-change/<token>: where O5's confirmation link lands (plan Part D5).
 *
 * The GET only looks: it says which clinic and which address, and spends
 * nothing, so a mail scanner that follows every link in an inbox confirms
 * nothing. The POST confirms, once. No session is needed: the link itself
 * is the proof that this inbox is the new address. The change then takes
 * effect 72 hours later, and the current address is told and can stop it.
 */

const PROBLEMS: Record<Exclude<AddressLinkProblem, "used">, { title: string; body: string }> = {
  expired: {
    title: "This link has expired.",
    body: "Confirmation links work for 72 hours. Ask for the change again in Settings, under Sign-in.",
  },
  stopped: {
    title: "This change was stopped.",
    body: "Nothing changed. If you still want it, ask for it again in Settings, under Sign-in.",
  },
  unknown: {
    title: "This link isn't valid.",
    body: "It may have been copied incompletely. Open it again from the email, or ask for the change again in Settings.",
  },
};

async function confirm(formData: FormData): Promise<void> {
  "use server";
  const token = formData.get("token");
  const h = await headers();
  await confirmAddressChange(token, {
    ipAddress: clientIp(h) ?? undefined,
    userAgent: h.get("user-agent")?.slice(0, 512) ?? undefined,
  });
  // Back to the GET, which says what happened. Outside any try: redirect()
  // works by throwing.
  redirect(`/address-change/${encodeURIComponent(String(token ?? ""))}`);
}

function moment(value: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone ?? "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(value);
}

export default async function AddressChangePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const link = await lookUpAddressLink(token);

  if (!link.ok) {
    if (link.reason === "used") {
      return (
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
          <h1 className="text-2xl font-semibold">This address is confirmed.</h1>
          <p className="text-muted mt-3">
            {link.effectiveAt
              ? `The change takes effect at ${moment(link.effectiveAt, link.timeZone)}. Until then the current address can stop it, and sign-in links still go there.`
              : "The change has taken effect."}
          </p>
        </main>
      );
    }
    const problem = PROBLEMS[link.reason];
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
        <h1 className="text-2xl font-semibold">{problem.title}</h1>
        <p className="text-muted mt-3">{problem.body}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold">Confirm this address</h1>
      <p className="text-muted mt-3">
        {link.clinicName} asked to make <strong className="text-ink">{link.newEmailMasked}</strong>{" "}
        its healdesk address, in place of {link.oldEmailMasked}: its sign-in, its billing email and
        the address for notices under its agreement.
      </p>
      <p className="text-muted mt-3">
        Once you confirm, the change takes effect 72 hours later, and until then the current address
        can stop it.
      </p>
      <form action={confirm} className="mt-8">
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          className="bg-ink rounded-full px-6 py-3 text-sm font-bold text-white"
        >
          Confirm this address
        </button>
      </form>
    </main>
  );
}
