"use client";

import { useEffect } from "react";

import { track, type EventName } from "@/lib/analytics";

/**
 * Fire one funnel event when a page mounts. Renders nothing.
 *
 * Exists so server components (the pricing page, the contact page) can emit
 * a view event without becoming client components themselves.
 */
export function TrackView({
  event,
  props,
}: {
  event: EventName;
  props?: Record<string, string | number | boolean>;
}) {
  useEffect(() => {
    track(event, props);
    // A view event fires once per mount; props changing later is not a new view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);
  return null;
}
