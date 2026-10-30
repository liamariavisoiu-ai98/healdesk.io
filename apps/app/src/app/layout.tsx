import type { Metadata } from "next";

import "./globals.css";

/**
 * The default title and description, for the few pages that set none (the
 * sign-in page, the one-time links). It said "healdesk — console" until
 * 30 October 2026, which is the operator console's name (apps/web's /admin)
 * and not what a clinic opens: this is its portal.
 */
export const metadata: Metadata = {
  title: "healdesk portal",
  description: "Your clinic's healdesk portal.",
  // This app is behind auth and handles PHI. Keep it out of every index.
  robots: { index: false, follow: false, nocache: true },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
