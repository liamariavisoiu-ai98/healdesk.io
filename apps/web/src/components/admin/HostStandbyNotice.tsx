/**
 * What an /admin page that reads from apps/app shows when nothing answers
 * there, which is what the AWS host in standby looks like from here: the
 * database, the load balancer and the services are switched off, and the DNS
 * names with them, so every ops call fails as unreachable (lib/host/state.ts,
 * isHostUnreachable). One notice for every such page, so the operator reads
 * one sentence about one cause rather than a red "could not load" per
 * section, and finds the switch from it.
 *
 * A host that is down rather than in standby fails the same way, so the
 * notice says that too, in one line.
 */
export function HostStandbyNotice({ what }: { what?: string }) {
  return (
    <section role="status" className="border-line mt-6 rounded-md border bg-white p-5">
      <h2 className="text-lg font-bold">The AWS host is in standby.</h2>
      <p className="mt-2 max-w-[68ch] text-sm">
        {what ? `${what} lives` : "What this page shows lives"} on the AWS host, and in standby its database,
        load balancer and services are switched off to save their cost. Nothing here can be read or changed until it is
        on again.
      </p>
      <p className="text-muted mt-2 max-w-[68ch] text-sm">
        If Host says it is active, it is not answering instead: read its alarms and its last deploy.
      </p>
      <a
        href="/admin/host"
        className="border-line-strong hover:border-ink mt-4 inline-flex min-h-11 items-center rounded-full border px-4 py-2 text-sm font-bold transition-colors"
      >
        Host: turn it on
      </a>
    </section>
  );
}

/** The notice as a whole page, for the pages whose heading lives in their panel. */
export function HostStandbyPage({ title, back }: { title: string; back?: { href: string; label: string } }) {
  return (
    <main className="mx-auto w-full max-w-page px-4 py-10 sm:px-8 lg:px-14">
      {back ? (
        <a href={back.href} className="text-muted text-sm underline">
          {back.label}
        </a>
      ) : null}
      <h1 className="font-display mt-2 text-2xl leading-tight font-semibold tracking-[-0.02em]">{title}</h1>
      <HostStandbyNotice />
    </main>
  );
}
