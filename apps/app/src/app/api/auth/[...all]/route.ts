import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth";

/**
 * Better Auth's endpoints.
 *
 * Node runtime, explicitly: the adapter needs `pg`, and docs/hipaa-compliance.md
 * forbids the edge runtime on anything in the PHI boundary.
 */
export const runtime = "nodejs";

export const { GET, POST } = toNextJsHandler(auth);
