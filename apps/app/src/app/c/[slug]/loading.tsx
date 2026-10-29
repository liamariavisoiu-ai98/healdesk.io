import { LoadingState } from "./states";

/** Shown while any portal screen's data is read. */
export default function PortalLoading() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="sr-only">Loading</h1>
      <LoadingState />
    </main>
  );
}
