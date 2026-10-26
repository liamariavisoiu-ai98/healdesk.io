"use client";

import { createContext, useContext } from "react";

/**
 * Whether this deployment has the approval passcode
 * (HEALDESK_APPROVAL_PASSCODE_HASH; lib/admin/approval-passcode.ts), read on
 * the server by the admin layout and handed down, so every approval's code
 * box can say when only the authenticator code will work rather than let the
 * operator type a passcode that cannot be checked. A boolean only: the hash
 * never leaves the server. Absent a provider (a test rendering one panel),
 * the box says nothing either way.
 */
const ApprovalPasscodeContext = createContext<boolean | null>(null);

export function ApprovalPasscodeProvider({ set, children }: { set: boolean; children: React.ReactNode }) {
  return <ApprovalPasscodeContext.Provider value={set}>{children}</ApprovalPasscodeContext.Provider>;
}

export function useApprovalPasscodeSet(): boolean | null {
  return useContext(ApprovalPasscodeContext);
}
