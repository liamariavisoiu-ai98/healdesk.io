import { describeError, log } from "@/lib/log";

import { actorFor, ok, opsProblem, type Operator, type OpsOutcome } from "./api";
import {
  QUEUE_WORDS,
  needsAttention,
  oldestAgeMinutes,
  queueHref,
  readMachineQueues,
  wordsFor,
  type MachineQueueRead,
} from "./inbox/queues";
import type { Tone } from "./inbox/types";

/**
 * `listMachineQueues` (lane P5d; the owner's decision of 24 October 2026):
 * the machine queues as a read-only section of the System page, the part
 * past its patience headed "Requires your attention" and the rest "Being
 * watched". The same queues Home's queue rows read (lib/ops/inbox/queues.ts,
 * readMachineQueues), judged by the same rule (needsAttention), so the two
 * can never disagree.
 *
 * Each queue is its key, its words, a count, the age of its oldest item in
 * minutes (null when the queue does not date it), whether it needs a person,
 * its tone and where it opens. A fixed queue whose part was read in full is
 * listed even when empty; a part that could not be read is named in
 * `partial` and its queues are absent, never zeros. pg-boss's queues are
 * listed only when something is in them (their names are pg-boss's).
 *
 * A read that writes nothing: no row, no access-log row (the queues hold no
 * patient, and the header of queues.ts says why Home must not write rows the
 * digest would). No argument; any is refused.
 */

export type MachineQueue = {
  key: string;
  words: string;
  count: number;
  oldestAgeMinutes: number | null;
  needsAttention: boolean;
  tone: Tone;
  href: string;
  /**
   * Some clinic could not be read, so this per-clinic count is "at least N".
   * needsAttention is still judged on what was read.
   */
  lowerBound: boolean;
};

export type MachineQueues = { queues: MachineQueue[]; partial: string[] };

/** The read, as the operation returns it: attention first, then QUEUE_WORDS' order, then pg-boss's by name. */
export function machineQueuesOf(read: MachineQueueRead, now: Date): MachineQueues {
  const order = Object.keys(QUEUE_WORDS);
  const keys = new Set<string>([...read.queues.keys()]);
  for (const kind of order) if (read.complete.has(kind)) keys.add(kind);
  const queues = [...keys].map((key): MachineQueue => {
    const q = read.queues.get(key) ?? { count: 0, oldest: null, clinics: new Set<string>() };
    const words = wordsFor(key);
    const minutes = oldestAgeMinutes(q, now);
    return {
      key,
      words: words.words,
      count: q.count,
      oldestAgeMinutes: minutes,
      needsAttention: needsAttention(key, q.count, minutes),
      tone: q.count > 0 ? words.tone : "ok",
      href: queueHref(key, q),
      lowerBound: read.lowerBound.has(key),
    };
  });
  const rank = (key: string) => {
    const i = order.indexOf(key);
    return i === -1 ? order.length : i;
  };
  queues.sort(
    (a, b) =>
      Number(b.needsAttention) - Number(a.needsAttention) ||
      rank(a.key) - rank(b.key) ||
      a.key.localeCompare(b.key),
  );
  return { queues, partial: [...read.unread] };
}

export async function opListMachineQueues(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  if (Object.keys(args).length > 0) {
    return opsProblem("listMachineQueues takes no arguments.", 400, "invalid_args");
  }
  try {
    const read = await readMachineQueues({ now, actor: actorFor(operator), request: operator.request });
    return ok(machineQueuesOf(read, now));
  } catch (error) {
    log.error("machine queues not read", { error: describeError(error) });
    return opsProblem("The machine queues could not be read.", 500, "failed");
  }
}
