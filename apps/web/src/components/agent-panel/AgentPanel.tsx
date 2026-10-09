import type { ReactNode } from "react";

/**
 * The frame of one assistant card: the white card, and the row along its top
 * with the mark, what kind of assistant it is, and what it answers.
 *
 * It was the personalised demo's (app/demo/[slug]/page.tsx) until 9 October
 * 2026, when the owner asked for the homepage's two cards to look exactly
 * like that page's. Both now draw this, with VoicePanel and ChatView inside
 * it, so the two cannot drift apart: the demo page in the clinic's colour and
 * logo, the homepage in healdesk's. The colour arrives as `--clinic` (and
 * `--clinic-ink`, the text on it) from whatever wraps the cards.
 */

export function AgentMark({
  name,
  logoUrl,
  size = 40,
}: {
  name: string;
  logoUrl: string | null;
  size?: number;
}) {
  return logoUrl ? (
    // On the demo page, a third-party image by design: the clinic's own logo,
    // from its own site.
    <img
      src={logoUrl}
      alt={`${name} logo`}
      referrerPolicy="no-referrer"
      className="shrink-0 rounded-lg bg-white object-contain"
      style={{ height: size, maxWidth: size * 3.5 }}
    />
  ) : (
    <span
      className="font-display grid shrink-0 place-items-center rounded-lg font-semibold"
      style={{ width: size, height: size, background: "var(--clinic)", color: "var(--clinic-ink)", fontSize: size * 0.45 }}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function AgentPanel({
  label,
  title,
  name,
  logoUrl,
  overlay,
  children,
}: {
  /** What kind of assistant, in small capitals: "AI voice agent". */
  label: string;
  /** What it answers: "Your phone line". */
  title: string;
  /** Whose assistant it is, for the mark. */
  name: string;
  logoUrl: string | null;
  /** Laid over the whole card, e.g. the demo page's "Archived". */
  overlay?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-line relative flex flex-col overflow-hidden rounded-3xl border bg-white shadow-[0_1px_2px_rgb(23_42_58/0.06),0_12px_40px_-12px_rgb(23_42_58/0.18)]">
      <div className="border-line flex items-center gap-3 border-b px-5 py-3.5">
        <AgentMark name={name} logoUrl={logoUrl} size={28} />
        <div className="min-w-0">
          <p className="text-muted text-[12px] font-bold tracking-[0.1em] uppercase">{label}</p>
          <p className="truncate text-[15.6px] font-semibold">{title}</p>
        </div>
      </div>
      {children}
      {overlay}
    </section>
  );
}
