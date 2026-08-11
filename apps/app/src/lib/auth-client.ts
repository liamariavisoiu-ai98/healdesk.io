"use client";

import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Browser-side auth. Same-origin, so no baseURL is needed — the console is
 * served from the app that owns the auth routes.
 */
export const authClient = createAuthClient({
  plugins: [organizationClient()],
});

export const { signIn, signOut, useSession } = authClient;
