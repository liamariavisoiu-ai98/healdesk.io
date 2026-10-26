"use client";

import { useEffect } from "react";

import type { DemoEventName } from "@/lib/demo/events";

/**
 * The demo page's one way to say something happened (lib/demo/events.ts):
 * to our own route, never a vendor, with a name and at most one word.
 */
export function sendDemoEvent(slug: string, name: DemoEventName, detail?: string): void {
  try {
    void fetch(`/api/demo/${slug}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(detail ? { name, detail } : { name }),
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    // Never break the page over measurement.
  }
}

/** The control close's "demo viewed", once per page view; the redesign sends its own. */
export function DemoViewed({ slug }: { slug: string }) {
  useEffect(() => {
    sendDemoEvent(slug, "demo_viewed");
  }, [slug]);
  return null;
}
