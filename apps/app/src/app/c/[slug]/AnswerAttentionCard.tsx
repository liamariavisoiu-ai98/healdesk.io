import { missedPath } from "@/lib/channels/answer-notices";
import type { AnswerAttention } from "@/lib/portal/missed-contacts";

/**
 * Home's "Needs your attention" card (owner, 29 October 2026): shown while
 * AYA is not answering (an open outage) or a missed call or chat is waiting
 * for a call back. Counts only; the list opens behind the passkey. A plain
 * link, which never prefetches the page (an open writes an access row).
 */
export function AnswerAttentionCard(props: { slug: string; attention: AnswerAttention }) {
  const { outageOpen, notCalledBack } = props.attention;
  if (!outageOpen && notCalledBack === 0) return null;
  return (
    <section aria-labelledby="answer-attention-heading" className="mt-6">
      <h2 id="answer-attention-heading" className="text-lg font-semibold">
        Needs your attention
      </h2>
      <div className="border-line mt-3 grid gap-2 rounded-xl border bg-white px-4 py-3">
        {outageOpen ? (
          <p>AYA isn&rsquo;t able to answer right now. We&rsquo;re working on it.</p>
        ) : null}
        {notCalledBack > 0 ? (
          <p>
            {notCalledBack === 1
              ? "1 call or chat AYA couldn’t answer is waiting for a call back."
              : `${notCalledBack} calls or chats AYA couldn’t answer are waiting for a call back.`}
          </p>
        ) : null}
        <p>
          <a
            href={missedPath(props.slug)}
            className="bg-ink inline-flex min-h-11 items-center rounded-full px-5 text-sm font-bold text-white"
          >
            See missed calls and chats
          </a>
        </p>
      </div>
      <p className="text-muted mt-2 text-sm">The list opens behind your passkey.</p>
    </section>
  );
}
