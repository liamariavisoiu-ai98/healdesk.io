export function ClinicNav({
  slug,
  active,
}: {
  slug: string;
  active: "overview" | "hours" | "sync" | "consent" | "audit" | "report";
}) {
  const tabs = [
    { id: "overview", label: "Overview", href: `/c/${slug}` },
    { id: "hours", label: "Opening hours", href: `/c/${slug}/hours` },
    { id: "sync", label: "Sync & reconciliation", href: `/c/${slug}/sync` },
    { id: "consent", label: "Consent & suppression", href: `/c/${slug}/consent` },
    { id: "audit", label: "Audit", href: `/c/${slug}/audit` },
    { id: "report", label: "Report preview", href: `/c/${slug}/report` },
  ] as const;

  return (
    <nav className="mt-6 flex flex-wrap gap-1 border-b border-[color:var(--color-line)]">
      {tabs.map((tab) => (
        <a
          key={tab.id}
          href={tab.href}
          className={[
            "-mb-px border-b-2 px-3 py-2.5 text-sm font-semibold transition-colors",
            tab.id === active
              ? "border-[color:var(--color-red)] text-[color:var(--color-ink)]"
              : "border-transparent text-[color:var(--color-muted)] hover:text-[color:var(--color-ink)]",
          ].join(" ")}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}
