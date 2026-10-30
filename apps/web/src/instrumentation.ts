/**
 * Server start-up (Next.js instrumentation hook).
 *
 * A promise that rejects with no one listening would end the Node process,
 * and with it any demo build running after its response (`after()`): the row
 * stays "building" or "auditing" until the stall rule hands it to the team,
 * and nothing says why (Miami Skin & Vein, 30 October 2026, stalled in its
 * audit twice). Logged here instead, with its stack, so the build's own hard
 * stop and error path still run and the server log names the cause.
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  process.on("unhandledRejection", (reason) => {
    console.error("[healdesk] unhandled rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
