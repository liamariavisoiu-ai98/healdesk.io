/**
 * The closed list of operations a Home row's button may name (`InboxButton`,
 * kind "op", lib/admin/strip-types.ts). apps/web runs each through the typed
 * ops-client call of the same name (lib/admin/inbox-ops.ts), with every
 * argument checked first; apps/app's inbox builder (lane A2) should import
 * this list so it never emits a button this console cannot run.
 *
 * Pure data: client components import it.
 */
export const INBOX_BUTTON_OPS = [
  "resendTranscript",
  "goLive",
  "extendSetupDeadline",
  "rerunPracticeQuestions",
  "requestSiteReread",
  "deleteRecordedCall",
  "markSupportReplied",
  "setUsageAlerts",
] as const;

export type InboxButtonOp = (typeof INBOX_BUTTON_OPS)[number];

/** The most days one press may add to a setup deadline: the Billing tab's form and apps/app cap it there too. */
export const EXTEND_DEADLINE_MAX_DAYS = 30;

export function isInboxButtonOp(value: unknown): value is InboxButtonOp {
  return typeof value === "string" && (INBOX_BUTTON_OPS as readonly string[]).includes(value);
}
