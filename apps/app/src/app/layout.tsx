import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "healdesk — console",
  description: "Clinic console for healdesk.",
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
