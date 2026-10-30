import { readableOn } from "@/lib/demo/colour";
import type { ClinicProfile } from "@/lib/demo/profile";

/**
 * The parts both demo closes share (app/demo/[slug], components/demo/
 * ClosePage.tsx): the page in the clinic's colour, the archive overlay, the
 * chat's suggested questions and the avatar's logo.
 */

export function chipsFor(profile: ClinicProfile): string[] {
  // A treatment with a real figure, not the free consultation: "How much is
  // Complimentary Consultation?" asks a question the name already answers.
  const priced = profile.services.find((s) => s.price && /\d/.test(s.price) && !/complimentary|free/i.test(`${s.name} ${s.price}`));
  const first = priced ?? profile.services[0];
  return [
    first ? `How much is ${first.name}?` : "What treatments do you offer?",
    profile.hours.length > 0 ? "Are you open on Saturdays?" : "What are your opening hours?",
    "Can I book a consultation for next week?",
  ];
}

/**
 * The logo, if it fits in a circle. A wide wordmark (Peachy's is six times
 * wider than tall) shrinks to an unreadable line in a 28-pixel chat avatar,
 * so the avatars show the clinic's initial instead and the wordmark stays in
 * the headers. Only an inline SVG says its shape; a linked image is assumed
 * to be an icon-shaped logo, which is what sites usually link.
 */
export function avatarLogo(logoUrl: string | null): string | null {
  if (!logoUrl?.startsWith("data:image/svg+xml;base64,")) return logoUrl;
  const svg = Buffer.from(logoUrl.slice("data:image/svg+xml;base64,".length), "base64").toString();
  const box = /viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg);
  if (!box) return null;
  const ratio = Number(box[1]) / Number(box[2]);
  return ratio > 0 && ratio <= 1.6 ? logoUrl : null;
}

export function Shell({
  colour,
  children,
}: {
  colour: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="bg-paper text-ink flex min-h-dvh flex-col"
      style={{ ["--clinic" as string]: colour, ["--clinic-ink" as string]: readableOn(colour) }}
    >
      {children}
    </div>
  );
}

/** Laid over each card once the demo's week is over. */
export function Archived() {
  return (
    <div className="bg-paper/80 absolute inset-0 grid place-items-center backdrop-blur-[2px]">
      <p className="bg-ink rounded-full px-4 py-2 text-xs font-semibold text-white">Archived</p>
    </div>
  );
}

