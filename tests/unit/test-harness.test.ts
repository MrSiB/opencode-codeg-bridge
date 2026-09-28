import { describe, it, expect, afterEach } from "vitest";
import {
  createTestDatabase,
  simulateExternalLock,
  validateSchema,
  REQUIRED_WORK_TASK_INDEXES,
  type TestDbInstance
} from "../helpers/test-db.js";
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

  it("provides WAL and SHM file path helpers and reports active WAL mode", async () => {
    db = await createTestDatabase();

    expect(db.getWalPath()).toBe(`${db.dbPath}-wal`);
    expect(db.getShmPath()).toBe(`${db.dbPath}-shm`);
    expect(await db.isWalActive()).toBe(true);

    const nonWalDb = await createTestDatabase({ wal: false });
    try {
      expect(await nonWalDb.isWalActive()).toBe(false);
    } finally {
      await nonWalDb.cleanup();
    }
  });

  it("spawns independent raw clients connected to the same database", async () => {
    db = await createTestDatabase();

    const client1 = db.spawnRawClient({ busyTimeoutMs: 2000 });
    const client2 = db.spawnRawClient({ busyTimeoutMs: 2000 });

    expect(client1.dbPath).toBe(db.dbPath);
    expect(client2.dbPath).toBe(db.dbPath);

    await client1.exec(
      "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at) VALUES (1, 'c1', '/c1', datetime('now'), datetime('now'), datetime('now'));"
    );

    const foldersFrom2 = await client2.query<{ id: number; name: string }>(
      "SELECT id, name FROM folder WHERE id = 1;"
    );
    expect(foldersFrom2).toHaveLength(1);
    expect(foldersFrom2[0].name).toBe("c1");
  });

  it("validates schema for required work_task indexes", async () => {
    db = await createTestDatabase();

    expect(REQUIRED_WORK_TASK_INDEXES).toEqual([
      "idx_work_task_source_key",
      "idx_work_task_folder",
      "idx_work_task_status"
    ]);

    const validation = await validateSchema(db.dbPath);
    expect(validation.valid).toBe(true);
    expect(validation.missingIndexes).toEqual([]);
    expect(validation.existingIndexes).toContain("idx_work_task_source_key");
    expect(validation.existingIndexes).toContain("idx_work_task_folder");
    expect(validation.existingIndexes).toContain("idx_work_task_status");

    const instanceValidation = await db.validateSchema();
    expect(instanceValidation.valid).toBe(true);

    await db.exec("DROP INDEX idx_work_task_status;");
    const afterDrop = await validateSchema(db.dbPath);
    expect(afterDrop.valid).toBe(false);
    expect(afterDrop.missingIndexes).toContain("idx_work_task_status");
  });

  it("simulates external exclusive lock with managed hold and release", async () => {
    db = await createTestDatabase();

    await db.exec(
      "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at) VALUES (1, 'lock-test', '/lock', datetime('now'), datetime('now'), datetime('now'));"
    );

    const releaseLock = await simulateExternalLock(db.dbPath, 10000);

    const blockedClient = db.spawnRawClient({ busyTimeoutMs: 150 });

    await expect(
      blockedClient.executeInTransaction([
        "UPDATE folder SET name = 'locked-change' WHERE id = 1;"
      ])
    ).rejects.toThrow();

    releaseLock();

    await blockedClient.executeInTransaction([
      "UPDATE folder SET name = 'unlocked-change' WHERE id = 1;"
    ]);

    const updated = await blockedClient.query<{ name: string }>(
      "SELECT name FROM folder WHERE id = 1;"
    );
    expect(updated[0].name).toBe("unlocked-change");
  });

  it("simulates external exclusive lock with automatic timeout expiration", async () => {
    db = await createTestDatabase();

    await db.exec(
      "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at) VALUES (1, 'expire-test', '/expire', datetime('now'), datetime('now'), datetime('now'));"
    );

    await simulateExternalLock(db.dbPath, 250);

    const client = db.spawnRawClient({ busyTimeoutMs: 80 });

    await expect(
      client.executeInTransaction([
        "UPDATE folder SET name = 'failed-change' WHERE id = 1;"
      ])
    ).rejects.toThrow();

    await new Promise((r) => setTimeout(r, 350));

    await client.executeInTransaction([
      "UPDATE folder SET name = 'auto-expired-change' WHERE id = 1;"
    ]);

    const rows = await client.query<{ name: string }>(
      "SELECT name FROM folder WHERE id = 1;"
    );
    expect(rows[0].name).toBe("auto-expired-change");
  });
});
