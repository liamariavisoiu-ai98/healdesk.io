/**
 * Placeholder console.
 *
 * Intentionally not built out. The schema in src/db/schema.ts is the real work
 * in this workspace — it fixes the data model for closed-loop attribution while
 * the UI is still cheap to change.
 *
 * Nothing here reads the database yet, and it must not until a BAA is in place.
 */

const NEXT_UP = [
  {
    title: "Auth + clinic tenancy",
    body: "Session, org scoping, and per-clinic row-level access before a single real row lands.",
  },
  {
    title: "Booking-system connectors",
    body: "Read/write against Mindbody, Vagaro, Boulevard, Zenoti, and GHL. The write half is table stakes; the read half is the product.",
  },
  {
    title: "POS reconciliation job",
    body: "Pull settled transactions, match to appointments, surface what could not be matched instead of silently dropping it.",
  },
  {
    title: "Attribution view",
    body: "clicks → booked → showed → spent, per campaign and per treatment, exportable back to the ad platforms.",
  },
  {
    title: "Audit logging middleware",
    body: "Every PHI read and write appended to audit_log. Required, and easier to add now than to retrofit.",
  },
];

export default function ConsolePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-20">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        healdesk console
      </p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">
        Scaffolded, not wired up.
      </h1>

      <div className="mt-6 rounded-xl border border-[color:var(--color-red)]/30 bg-[color:var(--color-red)]/[0.06] p-5">
        <p className="text-sm font-bold">PHI boundary — not yet covered</p>
        <p className="mt-1.5 text-sm text-[color:var(--color-muted)]">
          This workspace is the app that will handle intake, consent, clinical
          notes, and POS reconciliation. It must not receive real patient data
          until a BAA is in place with every vendor in the path. Seed and
          synthetic data only. See <code>docs/hipaa-compliance.md</code>.
        </p>
      </div>

      <h2 className="mt-12 text-sm font-bold tracking-[0.08em] uppercase">
        Next up
      </h2>
      <ol className="mt-4 space-y-5">
        {NEXT_UP.map((item, index) => (
          <li key={item.title} className="border-t border-[color:var(--color-line)] pt-4">
            <span className="text-[13px] font-bold text-[color:var(--color-red)]">
              {String(index + 1).padStart(2, "0")}
            </span>
            <h3 className="mt-1 text-lg font-semibold">{item.title}</h3>
            <p className="mt-1 text-sm text-[color:var(--color-muted)]">
              {item.body}
            </p>
          </li>
        ))}
      </ol>
    </main>
  );
}
