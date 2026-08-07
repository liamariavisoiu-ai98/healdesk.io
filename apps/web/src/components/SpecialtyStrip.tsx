"use client";

import { useState } from "react";

import type { Specialty } from "@/lib/specialties";

/**
 * The signature interaction: six panels that trade width as you move across
 * them. Collapsed panels show a vertical spine; the hovered or selected one
 * expands and reveals its copy.
 *
 * Below the `md` breakpoint the whole metaphor breaks (there is no horizontal
 * room and no hover), so it becomes a plain vertical list of buttons.
 */
export function SpecialtyStrip({
  specialties,
  selectedId,
  onSelect,
}: {
  specialties: readonly Specialty[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Hover wins while the pointer is down the strip; otherwise the selection
  // stays open, so the panel never collapses to nothing.
  const openId = hoveredId ?? selectedId;

  return (
    <div
      className="border-line bg-paper-2 flex flex-col overflow-hidden rounded-[20px] border md:h-[clamp(300px,42vw,380px)] md:flex-row"
      role="tablist"
      aria-label="Specialties"
      onMouseLeave={() => setHoveredId(null)}
    >
      {specialties.map((specialty, index) => {
        const isOpen = openId === specialty.id;
        const isSelected = selectedId === specialty.id;

        return (
          <button
            key={specialty.id}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-controls="specialty-demo"
            onMouseEnter={() => setHoveredId(specialty.id)}
            onFocus={() => setHoveredId(specialty.id)}
            onClick={() => onSelect(specialty.id)}
            style={{ flexGrow: isOpen ? 3.2 : 1 }}
            className={[
              "group border-line relative min-w-0 flex-1 basis-0 cursor-pointer overflow-hidden text-left",
              "border-t first:border-t-0 md:border-t-0 md:border-l md:first:border-l-0",
              "transition-[flex-grow,background-color] duration-500 ease-panel",
              isOpen ? "bg-orange/[0.07]" : "bg-transparent",
              "md:py-[22px]",
            ].join(" ")}
          >
            {/* Gradient rule that draws in from the left as the panel opens. */}
            <span
              aria-hidden
              className={[
                "bg-brand-gradient absolute inset-x-0 top-0 h-1 origin-left transition-transform duration-[450ms]",
                isOpen ? "scale-x-100" : "scale-x-0",
              ].join(" ")}
            />

            {/* Collapsed state — vertical spine. Desktop only. */}
            <span
              aria-hidden
              className={[
                "absolute inset-0 hidden flex-col items-center justify-between py-5 transition-opacity duration-300 md:flex",
                isOpen ? "opacity-0" : "opacity-100",
              ].join(" ")}
            >
              <span className="text-muted text-[13px] font-bold tracking-[0.05em]">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span
                className="font-display text-ink text-[clamp(16px,1.6vw,20px)] font-medium whitespace-nowrap"
                style={{ writingMode: "vertical-rl", rotate: "180deg" }}
              >
                {specialty.name}
              </span>
              <span aria-hidden className="h-4" />
            </span>

            {/* Expanded state. Static and always visible on mobile. */}
            <span
              className={[
                "flex items-center gap-3.5 px-[22px] py-[18px]",
                "md:absolute md:inset-0 md:flex-col md:items-stretch md:justify-between md:px-[26px] md:py-6",
                "md:transition-opacity md:duration-[400ms] md:delay-[80ms]",
                isOpen
                  ? "md:pointer-events-auto md:opacity-100"
                  : "md:pointer-events-none md:opacity-0",
              ].join(" ")}
            >
              <span
                className={[
                  "text-[13px] font-bold tracking-[0.05em]",
                  isSelected ? "text-red" : "text-muted md:text-red",
                ].join(" ")}
              >
                {String(index + 1).padStart(2, "0")}
              </span>

              <span className="md:self-start">
                <span className="font-display block text-[19px] leading-[1.05] font-medium tracking-[-0.02em] md:text-[clamp(22px,2.4vw,30px)]">
                  {specialty.name}
                </span>
                <span className="text-muted mt-3 hidden max-w-[22ch] text-sm font-medium md:block">
                  {specialty.hint}
                </span>
              </span>

              <span
                className={[
                  "hidden items-center gap-1.5 text-[13px] font-bold md:inline-flex",
                  isSelected ? "text-red" : "text-ink",
                ].join(" ")}
              >
                {isSelected ? "Showing below" : "See the demo"}
                <span aria-hidden>→</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
