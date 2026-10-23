import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * db-apply's two post-statement checks (scripts/db-apply-lib.ts runParsed),
 * each on its own. A run is refused and rolled back when the transaction is
 * no longer the named clinic's (app.clinic_id moved) OR when the database's
 * safety net wrote a change row for another clinic in it
 * (app_clinics_changed_in_transaction). The real-database tests in
 * clinic-change-direct.test.ts move app.clinic_id too, so they cannot show
 * that the second check stands alone; here pg's Client is a stub that
 * answers each check as the case needs, and the statement is an ordinary
 * one the fence passes. No bypass payload is built.
 */

const A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const B = "7d1e2f3a-2222-4c2a-9a8b-1f2e3d4c5b6b";

const db = vi.hoisted(() => ({
  setting: "" as string,
  touched: [] as string[],
  calls: [] as string[],
}));

vi.mock("pg", () => ({
  Client: class {
    async connect() {}
    async end() {}
    async query(text: string) {
      db.calls.push(text.trim().split(/\s+/)[0]!.toUpperCase());
      if (text.includes("current_setting('app.clinic_id'")) return { rows: [{ clinic: db.setting }], rowCount: 1 };
      if (text.includes("app_clinics_changed_in_transaction")) {
        return { rows: db.touched.map((id) => ({ id })), rowCount: db.touched.length };
      }
      if (/^\s*insert/i.test(text)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  },
}));

const { runParsed } = await import("../scripts/db-apply-lib");

const STATEMENT = {
  statement: `insert into clinic_closures (clinic_id, closed_on, label) values ('${A}', '2027-09-01', 'Closed')`,
  verb: "insert" as const,
  table: "clinic_closures",
};

const run = (mode: "dry-run" | "apply") =>
  runParsed(
    { change: "guard", clinic: A, mode, expectRows: mode === "apply" ? 1 : null, connectionString: "postgres://stub" },
    STATEMENT,
  );

beforeEach(() => {
  db.calls = [];
});

describe("db-apply's post-statement checks, each alone", () => {
  test("a change row written for another clinic is refused and rolled back, though app.clinic_id never moved", async () => {
    db.setting = A;
    db.touched = [A, B];
    for (const mode of ["dry-run", "apply"] as const) {
      db.calls = [];
      const out = await run(mode);
      expect(out, mode).toMatchObject({ committed: false, rowCount: 1 });
      expect(out.verdict).toBe("refused: the statement reached outside the clinic the run names; rolled back");
      expect(db.calls).toContain("ROLLBACK");
      expect(db.calls).not.toContain("COMMIT");
    }
  });

  test("app.clinic_id moved to another clinic is refused and rolled back, though no change row names one", async () => {
    db.setting = B;
    db.touched = [];
    for (const mode of ["dry-run", "apply"] as const) {
      db.calls = [];
      const out = await run(mode);
      expect(out, mode).toMatchObject({ committed: false });
      expect(out.verdict).toBe("refused: the statement reached outside the clinic the run names; rolled back");
      expect(db.calls).toContain("ROLLBACK");
      expect(db.calls).not.toContain("COMMIT");
    }
  });

  test("the named clinic alone: an apply commits", async () => {
    db.setting = A;
    db.touched = [A];
    const out = await run("apply");
    expect(out).toMatchObject({ committed: true, verdict: "applied: committed" });
    expect(db.calls).toContain("COMMIT");
  });
});
