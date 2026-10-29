import { EmptyState } from "./states";

/** A portal address that opens nothing: no clinic name, no detail about what exists. */
export default function PortalNotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <div className="mt-4">
        <EmptyState>
          This page doesn&rsquo;t exist, or you don&rsquo;t have access to it. Use the menu to go
          back to your portal.
        </EmptyState>
      </div>
    </div>
  );
}
