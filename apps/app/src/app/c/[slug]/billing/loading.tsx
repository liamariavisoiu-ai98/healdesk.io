import { LoadingState } from "../states";

export default function BillingLoading() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Billing</h1>
      <div className="mt-6">
        <LoadingState label="Loading billing" />
      </div>
    </div>
  );
}
