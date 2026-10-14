import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { recordRotation, type RecordOutcome } from "@/lib/admin/key-rotations";
import { requireOperator } from "@/lib/admin/operator";
import { assess } from "@/lib/admin/system-map";
import { gatherLive } from "@/lib/admin/system-map-live";

import { SystemMap } from "./SystemMap";

/**
 * /admin/map: the whole system at one look. Every tool healdesk runs on,
 * grouped into categories on the patient side, the shop side and what both
 * share; a line between each pair of things that talk, pointing the way the
 * information travels and coloured by what was found live on this request
 * (connected, needs a key, off on purpose, broken, can't check, still to
 * build, parked); and, one tap away, every single connection with the key it
 * rides on and when to rotate it. It can be narrowed to one purpose, or play
 * a journey step by step. What is left to build, add or rotate is listed
 * under the picture.
 *
 * The registry and the colouring are lib/admin/system-map.ts; where things
 * sit and how lines run, lib/admin/map-layout.ts; what is found live, and
 * how, lib/admin/system-map-live.ts. No key's value is read into anything
 * the browser gets: the page asks only whether each is there.
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
        Every tool healdesk runs on, grouped by what it does, and the connections between them. Arrows show which way
        information travels and colours show whether the keys are in place right now; tap anything to see each
        connection and its key. Checked live when this page loaded, {new Date(view.checkedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC.
      </p>
      <SystemMap view={view} recordRotation={recordRotationAction} />
    </main>
  );
}
