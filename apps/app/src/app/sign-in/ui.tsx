import type { ReactNode } from "react";

/**
 * The pieces inside the sign-in card (shell.tsx), shared by /sign-in,
 * /sign-in/help and /link/<token> so the three read as one place. No state
 * and no server imports, so the client forms use them as well.
 *
 * The type is the system's, as everywhere in the portal (globals.css), which
 * on an iPhone or a Mac is Apple's own: a large tight heading, a 17px lede,
 * 17px fields and buttons, a 14px hint.
 */

/** The full-width pill: the logo's red, deepened for white text (bg-brand-gradient-deep). */
export const PRIMARY_BUTTON = "si-primary";

/** The quieter full-width pill, for a second action such as "Send again". */
export const SECONDARY_BUTTON = "si-secondary";

/** An inline link: ink, underlined, so it is never told apart by colour alone. */
export const TEXT_LINK = "si-link";

/** The card's heading; `small` for a heading that runs to a sentence. */
export function CardTitle({ children, small = false }: { children: ReactNode; small?: boolean }) {
  return (
    <h1
      className={`text-center leading-[1.15] font-semibold tracking-[-0.022em] text-balance ${
        small ? "text-[24px] sm:text-[26px]" : "text-[28px] sm:text-[32px]"
      }`}
    >
      {children}
    </h1>
  );
}

/**
 * The card's lede. Lines break where they read best (`text-pretty`, which
 * keeps "...signs you in." on its first line); `balance` evens them out
 * instead, for a single sentence that would otherwise break at a hyphen.
 */
export function CardLede({ children, balance = false }: { children: ReactNode; balance?: boolean }) {
  return (
    <p className={`text-muted mt-3 text-center text-[17px] leading-[1.47] ${balance ? "text-balance" : "text-pretty"}`}>
      {children}
    </p>
  );
}

/** An address that breaks after its @ when it must, rather than anywhere in it. */
export function BreakableEmail({ email }: { email: string }) {
  const at = email.lastIndexOf("@");
  if (at < 0) return <>{email}</>;
  return (
    <>
      {email.slice(0, at + 1)}
      <wbr />
      {email.slice(at + 1)}
    </>
  );
}

/** The round badge above a state's heading: a sent link, a link that no longer works. */
export function CardBadge({ icon }: { icon: "mail" | "link" }) {
  return (
    <div className="si-badge" aria-hidden="true">
      {icon === "mail" ? <MailGlyph /> : <LinkGlyph />}
    </div>
  );
}

/** A line that says something went wrong, with the glyph only repeating it. */
export function ProblemLine({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-problem mt-2 flex gap-1.5 text-sm">
      <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true" className="mt-0.5 shrink-0">
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-11.25a.75.75 0 0 0-1.5 0v4.5a.75.75 0 0 0 1.5 0v-4.5ZM10 14.75a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
          clipRule="evenodd"
        />
      </svg>
      <span>{children}</span>
    </p>
  );
}

function MailGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="m3.8 7.2 7.1 5.3a1.8 1.8 0 0 0 2.2 0l7.1-5.3" />
    </svg>
  );
}

function LinkGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1" />
      <path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1" />
    </svg>
  );
}
