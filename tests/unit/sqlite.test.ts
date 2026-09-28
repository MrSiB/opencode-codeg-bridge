import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../src/sqlite.js";
import { createTestDatabase, type TestDbInstance } from "../helpers/test-db.js";
import fs from "node:fs/promises";
import path from "node:path";

describe("Robust Zero-Native SQLite Client", () => {
  let dbInstance: TestDbInstance;
  let client: SqliteClient;

  beforeEach(async () => {
    dbInstance = await createTestDatabase();
    client = new SqliteClient(dbInstance.dbPath, { maxBackups: 2, busyTimeoutMs: 1000 });
  });

  afterEach(async () => {
    await dbInstance.cleanup();
  });

  it("executes queries and returns parsed JSON results", async () => {
    await client.exec(
      "INSERT INTO folder (name, path, last_opened_at, created_at, updated_at) VALUES ('p1', '/p1', datetime('now'), datetime('now'), datetime('now'));"
    );

    const rows = await client.query<{ id: number; name: string }>(
      "SELECT id, name FROM folder WHERE name = 'p1';"
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("p1");
  });

  it("executes atomic commands inside an immediate transaction", async () => {
    const commands = [
      "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at) VALUES (10, 'f10', '/f10', datetime('now'), datetime('now'), datetime('now'));",
      "INSERT INTO work_task (folder_id, title, config, status, created_at, updated_at) VALUES (10, 'Task inside tx', '{}', 'todo', datetime('now'), datetime('now'));"
    ];

    await client.executeInTransaction(commands);

    const tasks = await client.query<{ title: string }>(
      "SELECT title FROM work_task WHERE folder_id = 10;"
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Task inside tx");
  });

  it("creates hot backups and rotates older files according to maxBackups", async () => {
    await client.exec(
      "INSERT INTO folder (name, path, last_opened_at, created_at, updated_at) VALUES ('p', '/p', datetime('now'), datetime('now'), datetime('now'));"
    );

    const b1 = await client.createBackup();
    await new Promise((r) => setTimeout(r, 20));
    const b2 = await client.createBackup();
    await new Promise((r) => setTimeout(r, 20));
    const b3 = await client.createBackup();

    expect(await fs.stat(b3)).toBeDefined();

    const parentDir = path.dirname(dbInstance.dbPath);
    const files = await fs.readdir(parentDir);
    const backups = files.filter((f) => f.includes(".bak."));

    expect(backups.length).toBeLessThanOrEqual(2);
  });
});
