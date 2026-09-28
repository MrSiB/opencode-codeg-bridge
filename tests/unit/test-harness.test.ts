import { describe, it, expect, afterEach } from "vitest";
import { createTestDatabase, type TestDbInstance } from "../helpers/test-db.js";
import fs from "node:fs/promises";
import path from "node:path";

describe("Test Harness & SQLite Fixtures", () => {
  let db: TestDbInstance | null = null;

  afterEach(async () => {
    if (db) {
      await db.cleanup();
      db = null;
    }
  });

  it("successfully creates and provisions in-memory/temp SQLite schema", async () => {
    db = await createTestDatabase();
    expect(db.dbPath).toBeDefined();

    // Verify folder table exists and allows insertion
    await db.exec(
      "INSERT INTO folder (name, path, last_opened_at, created_at, updated_at) VALUES ('test-proj', '/workspace/test', datetime('now'), datetime('now'), datetime('now'));"
    );

    const folders = await db.query<{ id: number; name: string; path: string }>(
      "SELECT id, name, path FROM folder;"
    );

    expect(folders.length).toBe(1);
    expect(folders[0].name).toBe("test-proj");
    expect(folders[0].path).toBe("/workspace/test");
  });

  it("supports work_task CRUD with JSON queries", async () => {
    db = await createTestDatabase();

    await db.exec(
      "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at) VALUES (1, 'p', '/w/p', datetime('now'), datetime('now'), datetime('now'));"
    );

    await db.exec(`
      INSERT INTO work_task (folder_id, title, config, status, source_key, created_at, updated_at)
      VALUES (1, '[IMPL] Test Task', '{}', 'todo', 'plan-slug-1-abc123', datetime('now'), datetime('now'));
    `);

    const tasks = await db.query<{ id: number; title: string; status: string; source_key: string }>(
      "SELECT id, title, status, source_key FROM work_task WHERE folder_id = 1;"
    );

    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe("[IMPL] Test Task");
    expect(tasks[0].status).toBe("todo");
    expect(tasks[0].source_key).toBe("plan-slug-1-abc123");
  });

  it("fixtures directory contains readable schema and sample plan", async () => {
    const fixtureDir = path.resolve(__dirname, "../fixtures");
    const schemaContent = await fs.readFile(path.join(fixtureDir, "schema.sql"), "utf-8");
    const planContent = await fs.readFile(path.join(fixtureDir, "sample-plan.md"), "utf-8");

    expect(schemaContent).toContain("CREATE TABLE IF NOT EXISTS work_task");
    expect(planContent).toContain("## Wave 1: Foundation");
    expect(planContent).toContain("- [ ] **[IMPL] Setup core types and interfaces**");
  });
});
