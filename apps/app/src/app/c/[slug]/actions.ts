"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

/**
 * The portal header's "Sign out", on every screen. Better Auth ends the
 * session, and lib/auth.ts ends the step-ups made on it with it, so the next
 * patient page asks for a passkey again. Signing out needs no clinic: it ends
 * this browser's session whatever it was looking at.
 */
export async function signOut(): Promise<void> {
  await auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}
