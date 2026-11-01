import type { ReactNode } from "react";

import wordmark from "@/brand/healdesk-wordmark.webp";

/**
 * The frame of the pages a clinic signs in through: /sign-in, /sign-in/help
 * and /link/<token>, where every emailed sign-in link lands (owner,
 * 1 November 2026: "this needs to be branded healdesk. make it look pretty,
 * apple-like but healdesk").
 *
 * The healdesk wordmark, one white card on a soft glow in the logo's red and
 * orange and the site's Tuscan Sun (the site's "soul" orb), and an optional
 * line under the card. A server component with no state of its own: each page
 * puts its own words and form in the card (ui.tsx has the pieces).
 *
 * The wordmark is a static import, the site's own logo resized to 96px tall
 * (three times the 32px it is drawn at; 28px on a phone), so it is served
 * from this app's /_next/static, which the Content-Security-Policy's
 * `img-src 'self'` allows and the Dockerfile already copies, and the page
 * never waits on healdesk.io, which is Vercel. Every style is a class
 * (globals.css, "Sign-in pages"): the policy refuses inline styles.
 */
export function SignInShell({ children, below }: { children: ReactNode; below?: ReactNode }) {
  return (
    <div className="si-page">
      <div className="si-column">
        <header className="si-rise">
          <img
            src={wordmark.src}
            width={wordmark.width}
            height={wordmark.height}
            alt="healdesk"
            draggable={false}
            className="si-wordmark"
          />
        </header>
        <main className="si-rise si-rise-late mt-8 w-full sm:mt-10">
          <div className="si-card">{children}</div>
          {below ? <div className="si-below">{below}</div> : null}
        </main>
      </div>
    </div>
  );
}
