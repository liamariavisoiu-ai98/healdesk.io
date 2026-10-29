import { LoadingState } from "./states";

/** Shown while any portal screen's data is read. */
export default function PortalLoading() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <LoadingState />
    </div>
  );
}
