import type { ConnectionRow, ConnectionState } from "@/lib/portal/settings-overview";

/**
 * The top of Settings (portal redesign, second slice, owner, 1 November
 * 2026): a row of shortcuts to every card, then each connection with where
 * it stands and one button to the card that makes it
 * (lib/portal/settings-overview.ts). Static markup: no state, no script.
 */

const DOT: Readonly<Record<ConnectionState, string>> = {
  connected: "bg-mint",
  attention: "bg-orange",
  not_connected: "bg-line-strong",
  unavailable: "bg-line-strong",
};

const MARK: Readonly<Record<ConnectionRow["key"], { letter: string; className: string }>> = {
  calendar: { letter: "G", className: "bg-ink" },
  payments: { letter: "S", className: "bg-ink" },
  facebook: { letter: "f", className: "bg-ink" },
};

export function SectionLinks({ sections }: { sections: readonly { id: string; label: string }[] }) {
  return (
    <nav aria-label="Settings sections" className="mt-4">
      <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
        {sections.map((s) => (
          <li key={s.id} className="shrink-0">
            <a
              href={`#${s.id}`}
              className="border-line inline-flex min-h-11 items-center rounded-full border bg-white px-4 text-sm font-semibold whitespace-nowrap"
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function ConnectionsOverview({ rows }: { rows: readonly ConnectionRow[] }) {
  return (
    <section
      id="connections"
      aria-labelledby="connections-heading"
      className="border-line scroll-mt-6 rounded-lg border bg-white px-4 py-4 shadow-sm sm:px-6 sm:py-5"
    >
      <h2 id="connections-heading" className="text-lg font-semibold">
        Connections
      </h2>
      <p className="text-muted mt-1 text-sm">Everything AYA connects to, in one place.</p>
      <ul className="divide-line mt-2 divide-y">
        {rows.map((r) => (
          <li key={r.key} data-connection={r.key} data-state={r.state} className="flex items-center gap-4 py-3">
            <span
              aria-hidden="true"
              className={`${MARK[r.key].className} flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-sm font-bold text-white`}
            >
              {MARK[r.key].letter}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{r.name}</span>
              <span className="text-muted flex items-center gap-1.5 text-sm">
                <span aria-hidden="true" className={`${DOT[r.state]} inline-block h-2 w-2 shrink-0 rounded-full`} />
                {/* An unavailable connection's line already says so: no label before it. */}
                <span>{r.state === "unavailable" ? r.line : `${r.stateLabel}. ${r.line}`}</span>
              </span>
            </span>
            {r.action ? (
              <a
                href={r.action.href}
                className={`inline-flex min-h-11 shrink-0 items-center rounded-full px-5 text-sm font-bold ${
                  r.state === "connected" ? "border-line border bg-white" : "bg-ink text-white"
                }`}
              >
                {r.action.label}
                <span className="sr-only"> {r.name}</span>
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
