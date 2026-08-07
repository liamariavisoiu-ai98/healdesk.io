"use client";

import { useState } from "react";

import { ChatDemo } from "@/components/ChatDemo";
import { SpecialtyStrip } from "@/components/SpecialtyStrip";
import { VoiceDemo } from "@/components/VoiceDemo";
import { specialties } from "@/lib/specialties";

/**
 * Owns the selected specialty and drives the strip, both demo panes, and the
 * leak calculator's default from one piece of state.
 */
export function SpecialtyExperience() {
  const [selectedId, setSelectedId] = useState(specialties[0]!.id);
  const selected = specialties.find((s) => s.id === selectedId) ?? specialties[0]!;

  return (
    <>
      <section id="specialties" className="scroll-mt-24">
        <SpecialtyStrip
          specialties={specialties}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </section>

      <section id="demo" className="scroll-mt-24 pt-8">
        <div className="mx-0.5 mb-[18px] flex flex-wrap items-baseline gap-3.5">
          <span className="text-muted text-xs font-bold tracking-[0.14em] uppercase">
            Live demo
          </span>
          <span className="font-display text-[clamp(20px,2.2vw,26px)] font-medium tracking-[-0.02em]">
            {selected.name}
          </span>
        </div>

        <div id="specialty-demo" className="grid gap-[18px] lg:grid-cols-2">
          <ChatDemo specialty={selected} />
          <VoiceDemo specialty={selected} />
        </div>
      </section>
    </>
  );
}
