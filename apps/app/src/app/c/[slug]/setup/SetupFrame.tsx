import type { ReactNode } from "react";

import wordmark from "@/brand/healdesk-wordmark.webp";

/**
 * The setup wizard's frame (owner, 1 November 2026: "now do the same for the
 * onboarding wizard", after the sign-in pages): the healdesk wordmark on the
 * sign-in pages' glow, the clinic's name under it, and one white card holding
 * the step's progress and the screen, with Help and the line about saving
 * under it. Wider than the sign-in card, since a screen is a form. A server
 * component with no state of its own; every style is a class (globals.css,
 * "The setup wizard"), as the Content-Security-Policy refuses inline styles.
 * The wordmark is the sign-in pages' own asset, served from this app.
 */
export function SetupFrame({
  crumb,
  progress,
  children,
  below,
}: {
  /** "<clinic> · Setup", the clinic's name a link to its page. */
  crumb: ReactNode;
  progress: ReactNode;
  children: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className="wz-page">
      <div className="wz-column">
        <header className="flex flex-col items-center gap-3">
          <img
            src={wordmark.src}
            width={wordmark.width}
            height={wordmark.height}
            alt="healdesk"
            draggable={false}
            className="si-wordmark"
          />
          <p className="wz-crumb">{crumb}</p>
        </header>
        <main className="mt-6 sm:mt-8">
          <div className="wz-card">
            {progress}
            <section className="wz-enter mt-7">{children}</section>
          </div>
          {below}
        </main>
      </div>
    </div>
  );
}
