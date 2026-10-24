import type { ExtendDeadlineOutcome } from "@/lib/admin/ops-client";

/**
 * What an operator reads after extending a clinic's setup window (the Billing
 * tab, and the Setup tab's Setup window card): the new deadline, and, when
 * apps/app saved the extension but could not record the decision on the
 * setup watch (`lifecycle: "not_recorded"`), one plain line saying what that
 * leaves behind. Types only from ops-client, so a client component may import
 * this (lib/admin/client-imports.test.ts).
 */
export const EXTENSION_NOT_RECORDED_WORDS =
  "The extension is saved, but the decision could not be recorded on the setup watch; Home may still list a decision owed.";

export function extendedWords(data: ExtendDeadlineOutcome): string | null {
  if (data.status !== "extended") return null;
  const head = `Extended to ${data.setupDeadlineAt}.`;
  return data.lifecycle === "not_recorded" ? `${head} ${EXTENSION_NOT_RECORDED_WORDS}` : head;
}
