import { Section } from "@/components/admin/ui";
import { LAUNCH_PROMISES, STATUS_LABEL, type LaunchStatus } from "@/lib/admin/seo/launch";

/**
 * Compliance › Launch: what the public copy promises that is not on in
 * production yet (lib/admin/seo/launch.ts), and what is left to turn each
 * on. Its one home since the admin redesign (23 October 2026); until then it
 * was drawn here and on /admin/seo, and the `launch_promises` attestation
 * above refuses while an item that blocks go-live is open.
 *
 * The colours are the roadmap board's validated four
 * (components/admin/RoadmapBoard.tsx), each with its word, so no status is
 * colour alone.
 */

const COLOUR: Record<LaunchStatus, string> = { on: "#5A9A16", building: "#14539E", off: "#B42318", owner: "#8A4A0C" };

export function LaunchPromises() {
  const open = LAUNCH_PROMISES.filter((item) => item.status !== "on");
  const blocking = open.filter((item) => item.blocksGoLive).length;
  return (
    <Section id="launch" title={`Launch: ${open.length} ${open.length === 1 ? "promise" : "promises"} not on yet, ${blocking} blocking go-live`}>
      <p className="text-muted text-sm">Stated as on in the public copy (the owner&apos;s rule of 19 October 2026); what is left is under each.</p>
      <ul className="mt-4 grid gap-2">
        {LAUNCH_PROMISES.map((item) => (
          <li key={item.id} id={`launch-${item.id}`} className="border-line rounded-md border px-4 py-3 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold" style={{ color: COLOUR[item.status] }}>
                <span aria-hidden="true" className="inline-block size-2 rounded-full" style={{ background: COLOUR[item.status] }} />
                {STATUS_LABEL[item.status]}
              </span>
              <span className="font-semibold">{item.promise}</span>
              {item.blocksGoLive && item.status !== "on" ? <span className="text-red-deep text-xs font-bold">blocks go-live</span> : null}
            </div>
            <p className="mt-1">{item.left}</p>
            <p className="text-muted mt-1 text-xs">
              Stated on: {item.where}. In the repo: <code className="font-mono">{item.evidence}</code>
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
