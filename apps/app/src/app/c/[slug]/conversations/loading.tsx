import { LoadingState } from "../states";

export default function ConversationsLoading() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Conversations</h1>
      <div className="mt-6">
        <LoadingState label="Loading conversations" />
      </div>
    </div>
  );
}
