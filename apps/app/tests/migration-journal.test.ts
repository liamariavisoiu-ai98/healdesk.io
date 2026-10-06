import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * The migration journal (build spec R27).
 *
 * drizzle's migrator applies a migration only when its journal `when` is later
 * than the newest one already applied, so a migration whose `when` is earlier
 * than its predecessor's is skipped, silently, on every database that has
 * applied the predecessor: the schema the code expects never arrives. That is
 * the failure a merge invites when two branches each generate the next
 * migration and one is renumbered by hand. These checks read the journal
 * itself, so they run without a database.
 */

type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Snapshot = { id: string; prevId: string };

const drizzleDir = fileURLToPath(new URL("../drizzle/", import.meta.url));
const journal = JSON.parse(readFileSync(`${drizzleDir}meta/_journal.json`, "utf8")) as {
  entries: Entry[];
};
const entries = journal.entries;

describe("the migration journal", () => {
  test("numbers its entries from 0 with no gap, each tag starting with its number", () => {
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((entry, position) => {
      expect(entry.idx, entry.tag).toBe(position);
      expect(entry.tag.startsWith(`${String(entry.idx).padStart(4, "0")}_`), entry.tag).toBe(true);
    });
  });

  test("has `when` strictly increasing with idx, so drizzle never skips one", () => {
    for (let i = 1; i < entries.length; i += 1) {
      expect(
        entries[i]!.when,
        `${entries[i]!.tag} must be later than ${entries[i - 1]!.tag}`,
      ).toBeGreaterThan(entries[i - 1]!.when);
    }
  });

  test("names exactly the SQL files on disk, each with its snapshot", () => {
    const files = readdirSync(drizzleDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(files).toEqual(entries.map((entry) => `${entry.tag}.sql`));
    for (const entry of entries) {
      const snapshot = `${drizzleDir}meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`;
      expect(existsSync(snapshot), entry.tag).toBe(true);
    }
  });

  test("chains every snapshot to the one before it", () => {
    const snapshots = entries.map(
      (entry) =>
        JSON.parse(
          readFileSync(
            `${drizzleDir}meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`,
            "utf8",
          ),
        ) as Snapshot,
    );
    for (let i = 1; i < snapshots.length; i += 1) {
      expect(snapshots[i]!.prevId, entries[i]!.tag).toBe(snapshots[i - 1]!.id);
    }
  });
});
