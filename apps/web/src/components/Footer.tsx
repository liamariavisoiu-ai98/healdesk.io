import { Brand } from "@/components/Nav";
import { site } from "@/lib/site";

export function Footer() {
  return (
    <footer className="border-line border-t">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-8 px-5 py-12 sm:px-8 md:flex-row md:items-start md:justify-between lg:px-14">
        <div className="max-w-[34ch]">
          <Brand />
          <p className="text-muted mt-3 text-sm font-medium">
            An AI front desk for high-ticket elective clinics — and the only one
            that tells you which recovered call actually collected.
          </p>
        </div>

        <nav className="flex flex-wrap gap-x-10 gap-y-3" aria-label="Footer">
          {site.nav.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-muted hover:text-ink text-sm font-semibold transition-colors"
            >
              {item.label}
            </a>
          ))}
          <a
            href="mailto:hello@healdesk.io"
            className="text-muted hover:text-ink text-sm font-semibold transition-colors"
          >
            Contact
          </a>
        </nav>
      </div>

      <div className="border-line mx-auto max-w-[1240px] border-t px-5 py-6 sm:px-8 lg:px-14">
        <p className="text-muted text-xs">
          © {new Date().getFullYear()} {site.name}. Pricing figures shown in demos
          are approximate industry ranges, not quotes.
        </p>
      </div>
    </footer>
  );
}
