import { site } from "@/lib/site";

export function Brand({ className = "" }: { className?: string }) {
  return (
    <a
      href="#top"
      className={`font-display text-[28px] leading-none font-semibold tracking-[-0.02em] ${className}`}
      aria-label={`${site.name} home`}
    >
      <span className="text-red">heal</span>
      <span className="text-orange">desk</span>
      <span className="text-muted text-[0.6em] font-medium">.io</span>
    </a>
  );
}

export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-line/60 bg-paper/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1240px] items-center gap-8 px-5 py-4 sm:px-8 lg:px-14">
        <Brand />

        <nav
          className="ml-auto hidden items-center gap-7 md:flex"
          aria-label="Main"
        >
          {site.nav.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-muted hover:text-ink text-[14.5px] font-semibold transition-colors"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <a
          href={site.cta.primary.href}
          className="bg-brand-gradient shadow-brand ml-auto inline-flex items-center rounded-full px-5 py-2.5 text-sm font-bold text-white transition-transform duration-200 hover:-translate-y-0.5 md:ml-0"
        >
          {site.cta.primary.label}
        </a>
      </div>
    </header>
  );
}
