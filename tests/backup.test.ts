import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backupDatabase, verifyDatabase } from "../src/db/backup.js";
import { openDatabase } from "../src/db/connection.js";
import { createMemory } from "../src/domain/nodes.js";

describe("SQLite backup", () => {
  it("captures committed WAL data and passes integrity validation", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-backup-"));
    const source = path.join(directory, "source.sqlite");
    const backup = path.join(directory, "backup.sqlite");
    const db = openDatabase(source);
    createMemory(db, {
      type: "Fact",
      content: "Committed WAL backup probe.",
      scope: { kind: "global" }
    });

    await backupDatabase(source, backup);
    verifyDatabase(backup);
    const restored = openDatabase(backup);
    expect((restored.prepare("SELECT content FROM nodes").get() as { content: string }).content).toBe(
      "Committed WAL backup probe."
    );
    restored.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
