/**
 * List Anthropic batches, newest first.
 *
 * Exists because messages.batches.create has no idempotency key. If the ~33 MB
 * submit for a full run drops after the server accepts it, a retrying client
 * creates a second batch: both are billed, only one id reaches disk, and the
 * orphan runs to completion with nothing reading its results.
 *
 * label.ts now submits with maxRetries: 0 so that cannot happen going forward.
 * This is how you check when it might already have, or when a run was
 * interrupted and you need to know what is still processing before resubmitting.
 *
 * Run from packages/leadgen:  npx tsx src/ops/batches.mts
 * Cancel an orphan:           npx tsx src/ops/batches.mts cancel <batch_id>
 */
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const [cmd, id] = process.argv.slice(2);

if (cmd === "cancel") {
  if (!id) { console.error("usage: batches.mts cancel <batch_id>"); process.exit(1); }
  const b = await client.messages.batches.cancel(id);
  console.log(`${b.id} -> ${b.processing_status}`);
} else {
  const { data } = await client.messages.batches.list({ limit: 20 });
  if (!data.length) { console.log("no batches"); }
  for (const b of data) {
    const n = b.request_counts;
    const total = n.processing + n.succeeded + n.errored + n.canceled + n.expired;
    console.log(
      `${b.id}  ${b.processing_status.padEnd(10)}  ${b.created_at.slice(0, 19)}  ` +
        `${String(total).padStart(5)} reqs  ok=${n.succeeded} err=${n.errored} proc=${n.processing}`,
    );
  }
}
