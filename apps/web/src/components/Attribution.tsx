"use client";

import { motion, useReducedMotion } from "motion/react";

const STAGES = [
  {
    id: "click",
    label: "Ad click",
    detail: "Meta / Google",
    value: "$42 spend",
    covered: true,
  },
  {
    id: "call",
    label: "Call answered",
    detail: "24/7, in 2 rings",
    value: "0 missed",
    covered: true,
  },
  {
    id: "booked",
    label: "Booking created",
    detail: "Written to the calendar",
    value: "Tue 4:00pm",
    covered: true,
  },
  {
    id: "showed",
    label: "Patient showed",
    detail: "Read from check-in",
    value: "Arrived",
    covered: false,
  },
  {
    id: "spent",
    label: "Money collected",
    detail: "Read back from the POS",
    value: "$1,400",
    covered: false,
  },
] as const;

/**
 * The differentiator, made visual.
 *
 * Incumbents write *into* the booking system and stop. The last two stages —
 * showed and spent — require reading back *out* of check-in and the POS, which
 * is the whole argument for the product. See docs/prd.md.
 */
export function Attribution() {
  const reduceMotion = useReducedMotion();

  return (
    <section id="attribution" className="scroll-mt-24 py-20 sm:py-28">
      <div className="max-w-[54ch]">
        <p className="text-muted text-xs font-bold tracking-[0.14em] uppercase">
          The part nobody else does
        </p>
        <h2 className="font-display mt-3 text-[clamp(30px,4.4vw,52px)] leading-[1.04] font-medium tracking-[-0.026em]">
          Every other AI receptionist stops at{" "}
          <span className="text-muted italic">&ldquo;booked&rdquo;</span>.
        </h2>
        <p className="text-muted mt-4 text-[17px] font-medium">
          They write into your calendar and never read the money back out of your
          point-of-sale. So they can tell you a call was recovered — never that it
          became <span className="text-ink font-semibold">$1,400 collected</span>.
        </p>
      </div>

      <ol className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {STAGES.map((stage, index) => (
          <motion.li
            key={stage.id}
            initial={reduceMotion ? false : { opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.45, delay: index * 0.08 }}
            className={[
              "relative flex flex-col justify-between gap-6 rounded-2xl border p-5",
              stage.covered
                ? "border-line bg-white"
                : "border-red/30 bg-brand-gradient text-white",
            ].join(" ")}
          >
            <div>
              <span
                className={[
                  "text-[11px] font-bold tracking-[0.1em] uppercase",
                  stage.covered ? "text-muted" : "text-white/70",
                ].join(" ")}
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <p className="font-display mt-2 text-[19px] leading-tight font-medium">
                {stage.label}
              </p>
              <p
                className={[
                  "mt-1.5 text-[13px] font-medium",
                  stage.covered ? "text-muted" : "text-white/80",
                ].join(" ")}
              >
                {stage.detail}
              </p>
            </div>

            <div>
              <p
                className={[
                  "text-[15px] font-bold tabular-nums",
                  stage.covered ? "text-ink" : "text-white",
                ].join(" ")}
              >
                {stage.value}
              </p>
              <p
                className={[
                  "mt-2 text-[11px] font-bold tracking-[0.06em] uppercase",
                  stage.covered ? "text-muted" : "text-white/85",
                ].join(" ")}
              >
                {stage.covered ? "Incumbents see this" : "Only healdesk"}
              </p>
            </div>
          </motion.li>
        ))}
      </ol>

      <p className="text-muted mt-8 max-w-[62ch] text-[15px] font-medium">
        Closing that loop means a clinic can finally answer the only question that
        matters — <span className="text-ink font-semibold">what did the front desk
        earn me?</span> — and push it back to the ad platforms. It&apos;s the
        capability enterprise suites charge enterprise prices for.
      </p>
    </section>
  );
}
