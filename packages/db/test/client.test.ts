import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "@mon22r/db";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "mon22r-open-"));
  directories.push(directory);
  return join(directory, "mon22r.sqlite");
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
});

describe("database startup after an interrupted restore", () => {
  it.each([".restoring", ".before-restore-20261112T120000000Z"])(
    "refuses to create an empty ledger when %s is present",
    (suffix) => {
      const filename = databasePath();
      writeFileSync(`${filename}${suffix}`, "recovery material");
      expect(() => openDatabase(filename)).toThrow("interrupted restore");
      expect(existsSync(filename)).toBe(false);
    },
  );

  it("creates a new ledger when no recovery material exists", () => {
    const filename = databasePath();
    const db = openDatabase(filename);
    db.close();
    expect(existsSync(filename)).toBe(true);
  });

  it("opens an existing ledger while keeping recovery files available", () => {
    const filename = databasePath();
    const db = openDatabase(filename);
    db.sqlite.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('kept')");
    db.close();
    writeFileSync(`${filename}.before-restore-20261112T120000000Z`, "older ledger");
    const reopened = openDatabase(filename);
    try {
      expect(reopened.sqlite.prepare("SELECT value FROM retained").get()).toEqual({ value: "kept" });
    } finally {
      reopened.close();
    }
  });
});
