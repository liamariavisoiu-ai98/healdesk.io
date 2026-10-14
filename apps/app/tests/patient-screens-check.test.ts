import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { checkPatientScreens, type Finding } from "./setup/patient-screens-check";

/**
 * The patient-screen source check (tests/setup/patient-screens-check.ts)
 * against files written to bite it: each way past the earlier regular
 * expressions, and the others a hurried page would try, must be a finding,
 * and a page written the way packages E and G should write one must not.
 * The files live outside the app, so nothing builds them, and import the app
 * by its `@/` paths, which the checker resolves as tsc does.
 */

let root: string;
let findings: Finding[];

/** Each case is a little tree of its own; `lib/` files are helpers outside the screens. */
const CASES: Record<string, Record<string, string>> = {
  // The reviewer's: the guard only in a comment, and withTenant.
  commented: {
    "c/[slug]/conversations/page.tsx": `import { withTenant } from "@/lib/tenant";
// TODO requirePatientPage( later
export const dynamic = "force-dynamic";
export default async function Page() {
  return withTenant({ clinicId: "x", actor: { type: "system" } }, async () => null);
}`,
  },
  // The reviewer's: an exported arrow in a "use server" file.
  arrowAction: {
    "lib/transcripts.ts": `import { withTenant } from "@/lib/tenant";
export async function readTranscript(id: string) {
  return withTenant({ clinicId: id, actor: { type: "system" } }, async (tx) => tx.db.execute("select 1" as never));
}`,
    "c/[slug]/conversations/actions.ts": `"use server";
import { requirePatientPage } from "@/lib/portal/patient-page";
import { readTranscript } from "../../../lib/transcripts";
export async function ok(slug: string) {
  await requirePatientPage(slug);
}
export const resend = async (slug: string, id: string) => {
  return readTranscript(id);
};`,
  },
  // The reviewer's: a "use server" file with no semicolon.
  noSemicolon: {
    "c/[slug]/bookings/actions.ts": `"use server"
export async function decide(slug: string, id: string) {
  return { slug, id };
}`,
  },
  // The reviewer's: a layout that reads data directly, and a component.
  layoutReads: {
    "lib/bookings.ts": `import { withTenant } from "@/lib/tenant";
export async function loadBookings() {
  return withTenant({ clinicId: "x", actor: { type: "system" } }, async () => []);
}`,
    "c/[slug]/bookings/layout.tsx": `import { loadBookings } from "../../../lib/bookings";
export default async function Layout({ children }: { children: unknown }) {
  await loadBookings();
  return children;
}`,
    "c/[slug]/bookings/List.tsx": `import { loadBookings } from "../../../lib/bookings";
export async function List() {
  const rows = await loadBookings();
  return rows.length;
}`,
  },
  // The reviewer's bigger gap: the guard, then a plain withTenant, with no row.
  guardThenTenant: {
    "c/[slug]/conversations/[id]/page.tsx": `import { requirePatientPage } from "@/lib/portal/patient-page";
import { withTenant } from "@/lib/tenant";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const page = await requirePatientPage((await params).slug);
  return withTenant({ clinicId: page.portal.clinicId, actor: { type: "system" } }, async () => null);
}`,
  },
  // Raw queries: the pool, the driver, the driver loaded late, requirePortal's own reads.
  raw: {
    "lib/raw.ts": `import { Pool } from "pg";
export async function rawRows() {
  return new Pool().query("select 1");
}`,
    "c/[slug]/bookings/page.tsx": `import { pool } from "@/db";
import { requirePatientPage } from "@/lib/portal/patient-page";
import { requirePortal } from "@/lib/portal/access";
import { rawRows } from "../../../lib/raw";
export const dynamic = "force-dynamic";
export default async function Page() {
  await requirePatientPage("x");
  await requirePortal("x");
  await rawRows();
  const { Client } = await import("pg");
  return pool.query("select 1").then(() => Client);
}`,
  },
  // A helper in the screen's own folder that reads, called inside withPatientPage.
  insideCallback: {
    "lib/readers.ts": `import { withTenant } from "@/lib/tenant";
export async function loadElsewhere() {
  return withTenant({ clinicId: "x", actor: { type: "system" } }, async () => []);
}`,
    "c/[slug]/conversations/page.tsx": `import { requirePatientPage, withPatientPage, logPatientAccess } from "@/lib/portal/patient-page";
import { loadElsewhere } from "../../../lib/readers";
export const dynamic = "force-dynamic";
export default async function Page() {
  const page = await requirePatientPage("x");
  return withPatientPage(page, async (tx) => {
    await logPatientAccess(tx, { action: "read", resourceType: "conversation", resourceIds: [] });
    return loadElsewhere();
  });
}`,
  },
  // Cached or prefetched: no dynamic export, a prefetching link, a reading layout.
  cached: {
    "c/[slug]/bookings/page.tsx": `import { requirePatientPage } from "@/lib/portal/patient-page";
export default async function Page() {
  await requirePatientPage("x");
  return <a href="/c/x/bookings/1" prefetch>Open</a>;
}`,
    "c/[slug]/bookings/template.tsx": `import { requirePatientPage, withPatientPage, logPatientAccess } from "@/lib/portal/patient-page";
export default async function Template() {
  const page = await requirePatientPage("x");
  return withPatientPage(page, (tx) => logPatientAccess(tx, { action: "read", resourceType: "booking_request", resourceIds: [] }));
}`,
  },
  // The pattern to copy: no findings.
  good: {
    "lib/good-readers.ts": `import type { PatientTx } from "@/lib/portal/patient-page";
import { conversations } from "@/db/schema";
export async function listConversations(tx: PatientTx) {
  return tx.db.select({ id: conversations.id }).from(conversations);
}`,
    "c/[slug]/conversations/page.tsx": `import { PatientPageGuard } from "@/app/c/[slug]/PatientPageGuard";
import { PortalShell } from "@/app/c/[slug]/PortalShell";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { logPatientAccess, patientGuardProps, requirePatientPage, withPatientPage } from "@/lib/portal/patient-page";
import { listConversations } from "../../../lib/good-readers";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const page = await requirePatientPage((await params).slug);
  const shell = await loadPortalPage(page.portal);
  if (!shell) return null;
  const rows = await withPatientPage(page, async (tx) => {
    const found = await listConversations(tx);
    await logPatientAccess(tx, { action: "read", resourceType: "conversation", resourceIds: found.map((r) => r.id) });
    return found;
  });
  return (
    <PortalShell {...shellProps(page.portal, shell, "conversations")}>
      <PatientPageGuard {...patientGuardProps(page)}>
        <a href="/c/x/conversations/1" prefetch={false}>{rows.length}</a>
      </PatientPageGuard>
    </PortalShell>
  );
}`,
    "c/[slug]/conversations/actions.ts": `"use server"
import { logPatientAccess, requirePatientPage, withPatientPage } from "@/lib/portal/patient-page";
export const resend = async (slug: string, id: string) => {
  const page = await requirePatientPage(slug);
  return withPatientPage(page, (tx) => logPatientAccess(tx, { action: "read", resourceType: "transcript_email", resourceId: id }));
};`,
  },
};

const of = (name: string) => findings.filter((f) => f.file.startsWith(join(root, name)));
const messages = (name: string) => of(name).map((f) => f.message);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "patient-screens-"));
  const files: string[] = [];
  for (const [name, tree] of Object.entries(CASES)) {
    for (const [path, source] of Object.entries(tree)) {
      const file = join(root, name, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
      if (path.startsWith("c/")) files.push(file);
    }
  }
  findings = checkPatientScreens(files);
  // One TypeScript program over the fixtures and what they import: seconds on
  // a quiet machine, much longer on a loaded one.
}, 600_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the patient-screen source check", () => {
  test("a guard named only in a comment is no guard, and withTenant there is a finding", () => {
    expect(messages("commented")).toEqual(
      expect.arrayContaining([
        "imports withTenant: read through withPatientPage",
        "default does not call requirePatientPage",
        expect.stringMatching(/^reaches the database outside withPatientPage: withTenant/),
      ]),
    );
  });

  test("an exported arrow in a server action file is checked like a function", () => {
    expect(messages("arrowAction")).toEqual(
      expect.arrayContaining([
        "resend does not call requirePatientPage",
        expect.stringMatching(/readTranscript → withTenant/),
      ]),
    );
    expect(messages("arrowAction")).not.toContain("ok does not call requirePatientPage");
  });

  test('"use server" without a semicolon is still a server action file', () => {
    expect(messages("noSemicolon")).toEqual(["decide does not call requirePatientPage"]);
  });

  test("a layout or a component that reads, through a helper in another file, is a finding", () => {
    const layout = of("layoutReads").filter((f) => f.file.endsWith("layout.tsx"));
    const list = of("layoutReads").filter((f) => f.file.endsWith("List.tsx"));
    expect(layout.map((f) => f.message)).toEqual([
      expect.stringMatching(/loadBookings → withTenant/),
    ]);
    expect(list.map((f) => f.message)).toEqual([
      expect.stringMatching(/loadBookings → withTenant/),
    ]);
  });

  test("the guard followed by a plain withTenant, which writes no access row, is a finding", () => {
    expect(messages("guardThenTenant")).toEqual(
      expect.arrayContaining([
        "imports withTenant: read through withPatientPage",
        expect.stringMatching(/outside withPatientPage: withTenant/),
      ]),
    );
    expect(messages("guardThenTenant")).not.toContain("default does not call requirePatientPage");
  });

  test("the pool, the driver, a driver loaded late and requirePortal's own reads are findings", () => {
    const found = messages("raw").join("\n");
    expect(found).toContain("imports pool: read through withPatientPage");
    expect(found).toMatch(/rawRows → Pool/);
    expect(found).toMatch(/import\("pg"\)/);
    expect(found).toMatch(/requirePortal → .*unsafeDb/);
  });

  test("inside withPatientPage, a helper that opens its own transaction is still a finding", () => {
    expect(messages("insideCallback")).toEqual([
      expect.stringMatching(/loadElsewhere → withTenant/),
    ]);
  });

  test("a page that could be cached or prefetched, and a reading template, are findings", () => {
    expect(messages("cached")).toEqual(
      expect.arrayContaining([
        'does not export const dynamic = "force-dynamic"',
        "prefetches a patient page: prefetch={false}",
        "a layout reads patient data: it does not run again on navigation; read in the page",
      ]),
    );
  });

  test("a page written the way packages E and G should write one has no findings", () => {
    expect(of("good")).toEqual([]);
  });
});
