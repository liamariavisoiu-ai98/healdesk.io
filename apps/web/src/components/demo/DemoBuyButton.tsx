"use client";

import { useBuy } from "@/components/BuyModal";
import { sendDemoEvent } from "@/components/demo/DemoViewed";
import { site } from "@/lib/site";

/**
 * A homepage demo's "Get AYA": the purchase the homepage's own button opens
 * (components/BuyModal.tsx), opened over the demo, in the demo's colours
 * rather than the homepage's red. Outside a provider it falls back to the
 * standalone flow, like every other "Get AYA", so it is never dead.
 */
export function DemoBuyButton({
  className,
  style,
  children,
  pressed,
}: {
  className: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  /** Counted as a press on this demo (lib/demo/events.ts): which demo, and which button. */
  pressed?: { slug: string; placement: "header" | "closing" };
}) {
  const buy = useBuy();
  if (!buy) {
    return (
      <a href={site.cta.primary.href} className={className} style={style}>
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        if (pressed) sendDemoEvent(pressed.slug, "cta_clicked", pressed.placement);
        buy.open();
      }}
      className={className}
      style={style}
    >
      {children}
    </button>
  );
}
