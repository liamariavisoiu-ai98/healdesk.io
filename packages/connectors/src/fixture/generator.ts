import type {
  ArrivalState,
  CanonicalAppointment,
  CanonicalContact,
  CanonicalSale,
} from "../types";

/**
 * Synthetic clinic data.
 *
 * Deterministic from a seed, so a test that fails can be re-run and a demo
 * shows the same numbers twice. Every name is invented; none of this resembles
 * a real person, which is the point — it lets the entire attribution pipeline
 * be exercised end to end while `data_classification` stays 'synthetic' and the
 * BAA gate stays shut.
 *
 * The generator's job is not to produce *plausible* data so much as *awkward*
 * data: no-shows, deposits paid weeks early, sales that never tie to a visit,
 * walk-ins with no appointment. A fixture that only emits the happy path lets a
 * broken reconciler look correct.
 */

/** mulberry32 — small, fast, good enough, and reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const FIRST = [
  "Avery", "Rowan", "Sasha", "Imani", "Dario", "Noor", "Kit", "Marek",
  "Tamsin", "Elio", "Zuri", "Bo", "Ines", "Otis", "Lark", "Rafa",
];
const LAST = [
  "Okonkwo", "Vasquez", "Lindqvist", "Haddad", "Moreau", "Bianchi", "Osei",
  "Nakamura", "Delgado", "Petrova", "Farrow", "Adeyemi",
];

const TREATMENTS = [
  { name: "Botox", value: 480 },
  { name: "Lip filler", value: 720 },
  { name: "Consultation", value: 0 },
  { name: "Laser resurfacing", value: 1_150 },
  { name: "Morpheus8", value: 1_400 },
  { name: "Skin check", value: 220 },
];

const PROVIDERS = ["Dr Chen", "Nurse Adeyemi", "Dr Halloran"];

export type FixtureOptions = {
  seed?: number;
  /**
   * Total appointments across the window. Omit and it scales with the window
   * at APPOINTMENTS_PER_MONTH — see the note there.
   */
  appointments?: number;
  from: Date;
  to: Date;
  /** Share that never turn up. Real clinics run 10–20%. */
  noShowRate?: number;
  /** Share whose arrival the platform cannot report. */
  unknownArrivalRate?: number;
  /** Share of sales that cannot be tied to an appointment. */
  orphanSaleRate?: number;
};

export type FixtureData = {
  contacts: CanonicalContact[];
  appointments: CanonicalAppointment[];
  sales: CanonicalSale[];
};

/**
 * Roughly what a single-location med spa books in a month.
 *
 * The count scales with the window rather than being a flat 60, because a flat
 * count spread over a 120-day first sync leaves any single month nearly empty —
 * and then a month-scoped assertion (or a demo of last month's report) passes
 * or fails depending on where the random numbers landed. Density has to be a
 * property of the clinic, not of how far back we happened to look.
 */
const APPOINTMENTS_PER_MONTH = 60;

export function generate(options: FixtureOptions): FixtureData {
  const random = rng(options.seed ?? 42);
  const months = Math.max(
    1,
    (options.to.getTime() - options.from.getTime()) / (30 * 86_400_000),
  );
  const count =
    options.appointments ?? Math.round(APPOINTMENTS_PER_MONTH * months);
  const noShowRate = options.noShowRate ?? 0.15;
  const unknownRate = options.unknownArrivalRate ?? 0.08;
  const orphanRate = options.orphanSaleRate ?? 0.1;

  // Ids are prefixed with the seed so two clinics' fixtures never share one.
  // Without this they'd all be `fx-appt-0`, and a cross-tenant bug — the exact
  // thing the isolation tests exist to catch — would produce plausible-looking
  // data instead of an obvious collision.
  const tag = (options.seed ?? 42).toString(36);

  const span = options.to.getTime() - options.from.getTime();
  const pick = <T,>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)]!;

  const contacts: CanonicalContact[] = [];
  const appointments: CanonicalAppointment[] = [];
  const sales: CanonicalSale[] = [];

  for (let i = 0; i < count; i += 1) {
    const contactId = `fx-${tag}-contact-${i}`;
    const first = pick(FIRST);
    const last = pick(LAST);

    contacts.push({
      externalId: contactId,
      // 555-01xx is reserved for fiction, so these can never dial a real person.
      phone: `+1555010${String(1000 + i).slice(-4)}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.test`,
      fullName: `${first} ${last}`,
    });

    const scheduledFor = new Date(options.from.getTime() + random() * span);
    const treatment = pick(TREATMENTS);

    const roll = random();
    const arrival: ArrivalState =
      roll < noShowRate
        ? "no_show"
        : roll < noShowRate + unknownRate
          ? "unknown"
          : "arrived";

    const appointmentId = `fx-${tag}-appt-${i}`;

    appointments.push({
      externalId: appointmentId,
      contactExternalId: contactId,
      scheduledFor,
      arrival,
      checkedInAt:
        arrival === "arrived"
          ? new Date(scheduledFor.getTime() + random() * 15 * 60_000)
          : undefined,
      treatment: treatment.name,
      providerName: pick(PROVIDERS),
      // A deposit taken at BOOKING, days before the visit. This is the case
      // that breaks a naive "they paid, so they showed" inference, so the
      // fixture emits it deliberately.
      depositUsd:
        treatment.value > 500 && random() < 0.4 ? "100.00" : undefined,
      updatedAt: scheduledFor,
    });

    // Deposits are their own sale, collected well before the appointment.
    if (treatment.value > 500 && random() < 0.4) {
      sales.push({
        externalId: `fx-${tag}-sale-deposit-${i}`,
        contactExternalId: contactId,
        appointmentExternalId: appointmentId,
        amountUsd: "100.00",
        collectedAt: new Date(
          scheduledFor.getTime() - (2 + random() * 12) * 86_400_000,
        ),
        lineItems: [{ description: "Deposit", amountUsd: "100.00" }],
      });
    }

    // The balance, taken at the visit — only if they actually turned up.
    if (arrival === "arrived" && treatment.value > 0) {
      const jitter = 0.85 + random() * 0.3;
      const amount = (treatment.value * jitter).toFixed(2);

      sales.push({
        externalId: `fx-${tag}-sale-${i}`,
        contactExternalId: contactId,
        // Some platforms don't tie the sale to the visit. Emitting that gap
        // is what exercises the reconciler's matching rather than its shortcut.
        appointmentExternalId:
          random() < orphanRate ? undefined : appointmentId,
        amountUsd: amount,
        collectedAt: new Date(scheduledFor.getTime() + random() * 90 * 60_000),
        lineItems: [{ description: treatment.name, amountUsd: amount }],
      });
    }
  }

  // A few walk-ins: money with no appointment at all. These must surface in
  // the exception queue rather than being silently dropped from the total.
  //
  // Spaced evenly rather than placed at random. Uniform-random over a 120-day
  // first sync leaves whole months with no walk-in at all, so "does the
  // exception queue catch unattributable money?" becomes a question the fixture
  // answers differently depending on the seed — and a test of that is flaky
  // roughly one run in six. Even spacing makes the property hold for any
  // sub-window, which is what the property is actually claiming.
  const walkIns = Math.max(1, Math.round(count * 0.05));
  for (let i = 0; i < walkIns; i += 1) {
    const treatment = pick(TREATMENTS.filter((t) => t.value > 0));
    sales.push({
      externalId: `fx-${tag}-sale-walkin-${i}`,
      amountUsd: treatment.value.toFixed(2),
      collectedAt: new Date(
        options.from.getTime() + ((i + 0.5) / walkIns) * span,
      ),
      lineItems: [
        { description: `${treatment.name} (walk-in)`, amountUsd: treatment.value.toFixed(2) },
      ],
    });
  }

  return { contacts, appointments, sales };
}
