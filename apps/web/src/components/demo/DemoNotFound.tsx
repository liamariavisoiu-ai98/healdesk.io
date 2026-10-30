import type { Audience } from "@healdesk/catalog";

import { demoGaps, gapLabel, listInWords } from "@/lib/demo/gaps";
import type { ClinicProfile } from "@/lib/demo/profile";
import { site } from "@/lib/site";

/**
 * The little note under the demo's two panels: what the demo could not find
 * on the clinic's website or Google listing (owner, 29 October 2026), so the
 * owner trying it knows this is a first draft built from public pages, not
 * the finished product. Only what is missing, never what was found. Nothing
 * when nothing is missing. lib/demo/gaps.ts decides the list.
 */
export function DemoNotFound({ profile, audience }: { profile: ClinicProfile; audience: Audience }) {
  const gaps = demoGaps(profile);
  if (gaps.length === 0) return null;
  return (
    <aside className="border-line mt-6 flex gap-3 rounded-md border border-dashed bg-white px-5 py-4 text-left">
      <span aria-hidden className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold" style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}>
        i
      </span>
      <div>
        <p className="text-xs font-semibold">What your demo couldn&rsquo;t find</p>
        <p className="text-muted mt-1 text-xs leading-[1.5] font-medium">
          It was built only from your public website and Google listing, and couldn&rsquo;t find{" "}
          {listInWords(gaps.map((g) => gapLabel(g, audience)))}. You add these at setup, and {site.agent} uses them from then on.
        </p>
      </div>
    </aside>
  );
}
