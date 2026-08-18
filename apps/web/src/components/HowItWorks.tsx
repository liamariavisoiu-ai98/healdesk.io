const CAPABILITIES = [
  {
    title: "Answers everything, everywhere",
    body: "Voice, SMS, web chat, Instagram DM, and WhatsApp — 24/7. Missed numbers get called back automatically, so an unanswered phone stops being a lost patient.",
  },
  {
    title: "Qualifies before it books",
    body: "Screens the price-shopper from the serious consult, handles treatment and pricing questions, and routes anything clinical to a human provider.",
  },
  {
    title: "Writes real bookings",
    body: "Into the booking system you already run — Mindbody, Vagaro, Boulevard, Zenoti, GHL — or your plain calendar, with a secure deposit link sent after the call to cut no-shows.",
  },
  {
    title: "Keeps clinical off the phone",
    body: "Intake, medical history and consent go to a secure link or your clinician — never collected on the call. Less of your patients' medical detail in fewer places, by design.",
  },
  {
    title: "Reactivates the dormant list",
    body: "The lever nobody pulls: the patients who got filler eight months ago and never rebooked. Sequenced, membership-aware, and every message carries STOP.",
  },
  {
    title: "Closes the revenue loop",
    body: "Reconciles recovered calls to booked to showed to collected, read back from your own point-of-sale. Your numbers, reported to you. No enterprise contract required.",
  },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-24 py-20 sm:py-28">
      <div className="max-w-[52ch]">
        <p className="text-muted text-xs font-bold tracking-[0.14em] uppercase">
          What it does
        </p>
        <h2 className="font-display mt-3 text-[clamp(30px,4.4vw,52px)] leading-[1.04] font-medium tracking-[-0.026em]">
          A front desk that never goes to voicemail.
        </h2>
      </div>

      <div className="mt-12 grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
        {CAPABILITIES.map((capability, index) => (
          <div key={capability.title} className="border-line border-t pt-5">
            <span className="text-red text-[13px] font-bold tracking-[0.05em]">
              {String(index + 1).padStart(2, "0")}
            </span>
            <h3 className="font-display mt-2 text-[21px] leading-tight font-medium tracking-[-0.015em]">
              {capability.title}
            </h3>
            <p className="text-muted mt-2.5 text-[15px] font-medium">
              {capability.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
