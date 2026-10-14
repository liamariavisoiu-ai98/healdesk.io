import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { recordRotation, type RecordOutcome } from "@/lib/admin/key-rotations";
import { requireOperator } from "@/lib/admin/operator";
import { assess } from "@/lib/admin/system-map";
import { gatherLive } from "@/lib/admin/system-map-live";

import { SystemMap } from "./SystemMap";

/**
 * /admin/map: the whole system at one look. Every tool healdesk runs on,
 * every bridge between them as a curved line pointing the way data travels,
 * and every key those bridges ride on, coloured by what was found live on
 * this request: in place, missing, waiting on purpose, can't check, broken,
 * due for rotation. What is left to build, add or rotate is listed under the
 * picture.
 *
 * The registry and the colouring are lib/admin/system-map.ts; what is found
 * live, and how, is lib/admin/system-map-live.ts. No key's value is read
 * into anything the browser gets: the page asks only whether each is there.
 *
 * Guarded like every page under /admin: `requireOperator()` here, and again
 * in the one action.
 */

export const metadata: Metadata = { title: "System map" };
export const dynamic = "force-dynamic";

const KEY_ID = /^[a-z-]+\.[A-Za-z0-9_]{1,64}$/;

async function recordRotationAction(keyId: string): Promise<RecordOutcome> {
  "use server";
  const operator = await requireOperator();
  if (!operator) return { ok: false, message: "Your session has ended. Sign in again to record it." };
  if (typeof keyId !== "string" || !KEY_ID.test(keyId)) return { ok: false, message: "That is not a key on the map." };
  return recordRotation(keyId, operator);
}

export default async function SystemMapPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");

  const view = assess(await gatherLive());

  return (
    <main className="mx-auto w-full max-w-[1400px] px-4 py-10 sm:px-8 lg:px-14">
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">System map</h1>
      <p className="text-muted mt-3 max-w-[80ch] text-[15.6px]">
        Every tool healdesk runs on, and every bridge between them. Each line is a key: the arrow shows which way the
        information travels, and the colour shows whether its key is in place right now. Checked live when this page
        loaded, {new Date(view.checkedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC.
      </p>
      <SystemMap view={view} recordRotation={recordRotationAction} />
    </main>
  );
}
