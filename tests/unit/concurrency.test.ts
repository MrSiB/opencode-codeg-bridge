import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import {
  createTestDatabase,
  simulateExternalLock,
  validateSchema,
  type TestDbInstance
} from "../helpers/test-db.js";
import { SqliteClient } from "../../src/sqlite.js";
import { syncPlanToCodeg } from "../../src/sync.js";
import {
  retryAsync,
  isSqliteBusyError,
  calculateDelay,
  SqliteBusyError
} from "../../src/retry.js";

describe("SQLite Concurrency & WAL Stress Tests", () => {
  let dbInstance: TestDbInstance;
  let samplePlanPath: string;

  beforeEach(async () => {
    dbInstance = await createTestDatabase({ wal: true, validateSchema: true });
    samplePlanPath = path.resolve(__dirname, "../fixtures/sample-plan.md");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await dbInstance.cleanup();
  });

  describe("Requirement 1: Isolated WAL Mode Deployment & Properties", () => {
    it("deploys an isolated database in WAL mode with valid schema indexes", async () => {
      expect(dbInstance.dbPath).toBeDefined();

      const rows = await dbInstance.query<{ journal_mode: string }>("PRAGMA journal_mode;");
      expect(rows).toHaveLength(1);
      expect(rows[0].journal_mode.toLowerCase()).toBe("wal");

      const isWal = await dbInstance.isWalActive();
      expect(isWal).toBe(true);
      expect(dbInstance.getWalPath()).toBe(`${dbInstance.dbPath}-wal`);
      expect(dbInstance.getShmPath()).toBe(`${dbInstance.dbPath}-shm`);

      const schemaCheck = await validateSchema(dbInstance.dbPath);
      expect(schemaCheck.valid).toBe(true);
      expect(schemaCheck.missingIndexes).toHaveLength(0);
      expect(schemaCheck.existingIndexes).toContain("idx_work_task_source_key");
      expect(schemaCheck.existingIndexes).toContain("idx_work_task_folder");
      expect(schemaCheck.existingIndexes).toContain("idx_work_task_status");
    });

    it("allows concurrent reads while a writer transaction is in progress under WAL", async () => {
      const client = new SqliteClient(dbInstance.dbPath);

      await client.exec(
        "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at) VALUES (1, 'initial', '/workspace/initial', datetime('now'), datetime('now'), datetime('now'));"
      );

      const readerPromises = Array.from({ length: 5 }, async () => {
        const rows = await client.query<{ count: number }>("SELECT count(*) as count FROM folder;");
        return rows[0].count;
      });

      const writePromise = client.executeInTransaction([
        "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at) VALUES (2, 'wal-writer', '/workspace/wal-writer', datetime('now'), datetime('now'), datetime('now'));"
      ]);

      const [counts] = await Promise.all([Promise.all(readerPromises), writePromise]);
      for (const count of counts) {
        expect(count).toBeGreaterThanOrEqual(1);
      }

      const finalCount = await client.query<{ count: number }>("SELECT count(*) as count FROM folder;");
      expect(finalCount[0].count).toBe(2);
    });
  });

  describe("Requirement 2 & 4: 10 Parallel Async Operations Under Heavy Load", () => {
    it("runs 10 concurrent mixed operations (reads, transactional updates, syncPlanToCodeg) without crashes or deadlocks", async () => {
      const client = new SqliteClient(dbInstance.dbPath);

      const customPlanContent = `# Secondary Concurrent Plan

## Wave 1: Setup
- [ ] **[IMPL] Configure worker queue**
- [ ] **[IMPL] Implement telemetry probes**

## Wave 2: Execution
- [x] **[IMPL] Add rate limiter metrics**
`;
      const customPlanPath = path.join(dbInstance.tempDir, "secondary-plan.md");
      await fs.writeFile(customPlanPath, customPlanContent, "utf-8");

      await client.exec(`
        INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at)
        VALUES (1, 'pre-seeded', '/workspace/seed', datetime('now'), datetime('now'), datetime('now'));
        INSERT INTO work_task (id, folder_id, title, config, status, source_kind, source_key, source_meta, created_at, updated_at)
        VALUES (100, 1, 'Pre-seeded Task 1', '{}', 'todo', 'manual', 'seed:task:100', '{}', datetime('now'), datetime('now'));
      `);

      const op1 = syncPlanToCodeg({
        dbPath: dbInstance.dbPath,
        planPath: samplePlanPath,
        workspacePath: "/workspace/plan-a",
        dryRun: false
      });

      const op2 = syncPlanToCodeg({
        dbPath: dbInstance.dbPath,
        planPath: customPlanPath,
        workspacePath: "/workspace/plan-b",
        dryRun: false
      });

      const op3 = client.executeInTransaction([
        `INSERT INTO work_task (folder_id, title, config, status, source_kind, source_key, source_meta, created_at, updated_at)
         VALUES (1, 'Batch Task A1', '{"wave":1}', 'todo', 'omo_plan', 'batch:1:a1:1111', '{}', datetime('now'), datetime('now'));`,
        `INSERT INTO work_task (folder_id, title, config, status, source_kind, source_key, source_meta, created_at, updated_at)
         VALUES (1, 'Batch Task A2', '{"wave":1}', 'todo', 'omo_plan', 'batch:1:a2:2222', '{}', datetime('now'), datetime('now'));`
      ]);

      const op4 = client.query<{ count: number }>("SELECT count(*) as count FROM folder;");

      const op5 = syncPlanToCodeg({
        dbPath: dbInstance.dbPath,
        planPath: samplePlanPath,
        workspacePath: "/workspace/plan-a",
        dryRun: false
      });

      const op6 = client.executeInTransaction([
        "UPDATE work_task SET status = 'in_progress', updated_at = datetime('now') WHERE id = 100;"
      ]);

      const op7 = client.executeInTransaction([
        `INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at)
         VALUES (50, 'folder-50', '/workspace/f50', datetime('now'), datetime('now'), datetime('now'));`,
        `INSERT INTO work_task (folder_id, title, config, status, source_kind, source_key, source_meta, created_at, updated_at)
         VALUES (50, 'Task F50-1', '{}', 'todo', 'manual', 'manual:f50:1', '{}', datetime('now'), datetime('now'));`,
        `INSERT INTO work_task (folder_id, title, config, status, source_kind, source_key, source_meta, created_at, updated_at)
         VALUES (50, 'Task F50-2', '{}', 'done', 'manual', 'manual:f50:2', '{}', datetime('now'), datetime('now'));`
      ]);

      const op8 = client.query<{ id: number; title: string; folder_name: string }>(
        "SELECT w.id, w.title, f.name as folder_name FROM work_task w JOIN folder f ON w.folder_id = f.id;"
      );

      const op9 = client.executeInTransaction([
        `INSERT INTO work_task (folder_id, title, config, status, source_kind, source_key, source_meta, created_at, updated_at)
         VALUES (1, 'Batch Task B1', '{"wave":2}', 'todo', 'omo_plan', 'batch:1:b1:3333', '{}', datetime('now'), datetime('now'));`,
        `INSERT INTO work_task (folder_id, title, config, status, source_kind, source_key, source_meta, created_at, updated_at)
         VALUES (1, 'Batch Task B2', '{"wave":2}', 'todo', 'omo_plan', 'batch:1:b2:4444', '{}', datetime('now'), datetime('now'));`
      ]);

      const op10 = client.query<{ status: string; count: number }>(
        "SELECT status, count(*) as count FROM work_task GROUP BY status;"
      );

      const results = await Promise.all([op1, op2, op3, op4, op5, op6, op7, op8, op9, op10]);

      expect(results).toHaveLength(10);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[4].success).toBe(true);

      const integrityRows = await client.query<{ integrity_check: string }>("PRAGMA integrity_check;");
      expect(integrityRows).toHaveLength(1);
      expect(integrityRows[0].integrity_check).toBe("ok");

      const allTasks = await client.query<{ id: number; folder_id: number; title: string; source_key: string; status: string }>(
        "SELECT id, folder_id, title, source_key, status FROM work_task ORDER BY id ASC;"
      );
      expect(allTasks).toHaveLength(14);

      const duplicateRows = await client.query<{ folder_id: number; source_key: string; count: number }>(`
        SELECT folder_id, source_key, count(*) as count
        FROM work_task
        WHERE source_key IS NOT NULL AND source_key != ''
        GROUP BY folder_id, source_key
        HAVING count(*) > 1;
      `);
      expect(duplicateRows).toHaveLength(0);

      const updatedTask = allTasks.find((t) => t.id === 100);
      expect(updatedTask?.status).toBe("in_progress");
    }, 20000);

    it("runs 10 concurrent syncPlanToCodeg invocations against the exact same plan and workspace idempotently", async () => {
      const workspacePath = "/workspace/high-concurrency-idempotent-sync";

      const syncPromises = Array.from({ length: 10 }, () =>
        syncPlanToCodeg({
          dbPath: dbInstance.dbPath,
          planPath: samplePlanPath,
          workspacePath,
          dryRun: false
        })
      );

      const results = await Promise.all(syncPromises);

      expect(results).toHaveLength(10);
      for (const res of results) {
        expect(res.success).toBe(true);
        expect(res.total).toBe(4);
      }

      const folders = await dbInstance.query<{ id: number; path: string }>(
        `SELECT id, path FROM folder WHERE path = '${workspacePath}';`
      );
      expect(folders).toHaveLength(1);
      const folderId = folders[0].id;

      const tasks = await dbInstance.query<{ id: number; title: string; source_key: string; status: string }>(
        `SELECT id, title, source_key, status FROM work_task WHERE folder_id = ${folderId};`
      );
      expect(tasks).toHaveLength(4);

      const sourceKeys = tasks.map((t) => t.source_key);
      expect(new Set(sourceKeys).size).toBe(4);

      const integrity = await dbInstance.query<{ integrity_check: string }>("PRAGMA integrity_check;");
      expect(integrity[0].integrity_check).toBe("ok");
    }, 25000);
  });

  describe("Requirement 3: retryAsync SQLITE_BUSY Interception, Exponential Backoff & Randomized Jitter", () => {
    it("correctly identifies all SQLITE_BUSY and database locked variants via isSqliteBusyError", () => {
      expect(isSqliteBusyError(new SqliteBusyError())).toBe(true);
      expect(isSqliteBusyError("Error: database is locked")).toBe(true);
      expect(isSqliteBusyError("sqlite3: database is locked\nError: query failed")).toBe(true);
      expect(isSqliteBusyError("SQLITE_BUSY: database is locked")).toBe(true);
      expect(isSqliteBusyError("sqlite_busy")).toBe(true);
      expect(isSqliteBusyError({ code: "SQLITE_BUSY" })).toBe(true);
      expect(isSqliteBusyError({ code: 5 })).toBe(true);
      expect(isSqliteBusyError({ errno: 5 })).toBe(true);
      expect(isSqliteBusyError({ extendedCode: 261 })).toBe(true);
      expect(isSqliteBusyError({ stderr: "Error: database is locked" })).toBe(true);
      expect(isSqliteBusyError({ stdout: "SQLITE_BUSY timeout" })).toBe(true);

      expect(isSqliteBusyError(null)).toBe(false);
      expect(isSqliteBusyError(new Error("no such table: foo"))).toBe(false);
      expect(isSqliteBusyError({ code: "SQLITE_ERROR" })).toBe(false);
    });

    it("verifies calculateDelay computes exponential backoff with randomized jitter bounded within [0, minDelayMs / 2]", () => {
      const minDelayMs = 50;
      const maxDelayMs = 500;
      const halfMin = minDelayMs / 2;

      for (let attempt = 0; attempt < 5; attempt++) {
        const baseExponential = Math.min(maxDelayMs, minDelayMs * 2 ** attempt);

        const minDelay = calculateDelay(attempt, minDelayMs, maxDelayMs, () => 0);
        expect(minDelay).toBe(baseExponential);

        const maxDelay = calculateDelay(attempt, minDelayMs, maxDelayMs, () => 1);
        expect(maxDelay).toBe(baseExponential + halfMin);

        const midDelay = calculateDelay(attempt, minDelayMs, maxDelayMs, () => 0.5);
        expect(midDelay).toBe(baseExponential + 0.5 * halfMin);

        const actualDelay = calculateDelay(attempt, minDelayMs, maxDelayMs);
        expect(actualDelay).toBeGreaterThanOrEqual(baseExponential);
        expect(actualDelay).toBeLessThanOrEqual(baseExponential + halfMin);
      }
    });

    it("retryAsync intercepts SQLITE_BUSY, executes retries with backoff and jitter, and succeeds cleanly", async () => {
      let attempts = 0;
      const sleepDelays: number[] = [];
      const customSleep = async (ms: number): Promise<void> => {
        sleepDelays.push(ms);
      };

      const result = await retryAsync(
        async () => {
          attempts++;
          if (attempts < 3) {
            throw new SqliteBusyError("database is locked");
          }
          return "success after retry";
        },
        {
          maxAttempts: 5,
          minDelayMs: 40,
          maxDelayMs: 300,
          sleep: customSleep
        }
      );

      expect(result).toBe("success after retry");
      expect(attempts).toBe(3);
      expect(sleepDelays).toHaveLength(2);
      expect(sleepDelays[0]).toBeGreaterThanOrEqual(40);
      expect(sleepDelays[0]).toBeLessThanOrEqual(60);
      expect(sleepDelays[1]).toBeGreaterThanOrEqual(80);
      expect(sleepDelays[1]).toBeLessThanOrEqual(100);
    });

    it("intercepts SQLITE_BUSY under an external lock, applies exponential backoff with jitter, and finishes without failure", async () => {
      await simulateExternalLock(dbInstance.dbPath, 220);

      const capturedDelays: number[] = [];
      const customSleep = async (ms: number): Promise<void> => {
        capturedDelays.push(ms);
        await new Promise((resolve) => setTimeout(resolve, ms));
      };

      const retryClient = new SqliteClient(dbInstance.dbPath, {
        busyTimeoutMs: 60,
        retryOptions: {
          maxAttempts: 5,
          minDelayMs: 40,
          maxDelayMs: 250,
          sleep: customSleep
        }
      });

      await retryClient.executeInTransaction([
        "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at) VALUES (777, 'retry-success', '/workspace/retry-success', datetime('now'), datetime('now'), datetime('now'));"
      ]);

      expect(capturedDelays.length).toBeGreaterThanOrEqual(1);

      capturedDelays.forEach((delay, idx) => {
        const expectedBase = Math.min(250, 40 * 2 ** idx);
        expect(delay).toBeGreaterThanOrEqual(expectedBase);
        expect(delay).toBeLessThanOrEqual(expectedBase + 20);
      });

      const rows = await retryClient.query<{ name: string }>(
        "SELECT name FROM folder WHERE id = 777;"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("retry-success");
    });

    it("resolves lock contention between multiple competing concurrent clients using retry with jitter", async () => {
      const clients = Array.from(
        { length: 5 },
        () =>
          new SqliteClient(dbInstance.dbPath, {
            busyTimeoutMs: 70,
            retryOptions: {
              maxAttempts: 6,
              minDelayMs: 30,
              maxDelayMs: 200
            }
          })
      );

      await clients[0].exec(
        "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at) VALUES (1, 'contention-hub', '/workspace/hub', datetime('now'), datetime('now'), datetime('now'));"
      );

      const writerPromises = clients.map((client, idx) =>
        client.executeInTransaction([
          `INSERT INTO work_task (folder_id, title, config, status, source_kind, source_key, source_meta, created_at, updated_at)
           VALUES (1, 'Contention Task ${idx}', '{}', 'todo', 'contention', 'contention:task:${idx}', '{}', datetime('now'), datetime('now'));`
        ])
      );

      const writeResults = await Promise.allSettled(writerPromises);

      for (const res of writeResults) {
        expect(res.status).toBe("fulfilled");
      }

      const tasks = await clients[0].query<{ title: string; source_key: string }>(
        "SELECT title, source_key FROM work_task WHERE folder_id = 1 AND source_kind = 'contention';"
      );
      expect(tasks).toHaveLength(5);

      const integrity = await clients[0].query<{ integrity_check: string }>("PRAGMA integrity_check;");
      expect(integrity[0].integrity_check).toBe("ok");
    });

    it("proves retryAsync throws SqliteBusyError when maxAttempts is exhausted under persistent lock", async () => {
      const releaseLock = await simulateExternalLock(dbInstance.dbPath, 10000);

      const capturedDelays: number[] = [];
      const customSleep = async (ms: number): Promise<void> => {
        capturedDelays.push(ms);
        await new Promise((resolve) => setTimeout(resolve, ms));
      };

      const failingClient = new SqliteClient(dbInstance.dbPath, {
        busyTimeoutMs: 40,
        retryOptions: {
          maxAttempts: 3,
          minDelayMs: 20,
          maxDelayMs: 100,
          sleep: customSleep
        }
      });

      let thrownError: unknown;
      try {
        await failingClient.executeInTransaction([
          "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at) VALUES (999, 'never', '/never', datetime('now'), datetime('now'), datetime('now'));"
        ]);
      } catch (err) {
        thrownError = err;
      } finally {
        releaseLock();
      }

      expect(thrownError).toBeInstanceOf(SqliteBusyError);
      expect((thrownError as SqliteBusyError).code).toBe("ERR_SQLITE_BUSY");
      expect((thrownError as SqliteBusyError).message).toContain("after 3 attempts");
      expect(capturedDelays).toHaveLength(2);
    });
  });

  describe("Requirement 4: Database Integrity & Consistency Under Sustained Concurrency", () => {
    it("maintains PRAGMA integrity_check 'ok' and strict task count without duplicates under multi-wave stress", async () => {
      const client = new SqliteClient(dbInstance.dbPath);

      await client.exec(`
        INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at)
        VALUES (10, 'Alpha', '/workspace/alpha', datetime('now'), datetime('now'), datetime('now'));
        INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at)
        VALUES (20, 'Beta', '/workspace/beta', datetime('now'), datetime('now'), datetime('now'));
      `);

      const workers = Array.from({ length: 10 }, (_, workerIdx) => {
        const folderId = workerIdx % 2 === 0 ? 10 : 20;
        const commands = Array.from({ length: 3 }, (_, itemIdx) => {
          const sourceKey = `worker:${workerIdx}:item:${itemIdx}`;
          return `INSERT INTO work_task (folder_id, title, config, status, source_kind, source_key, source_meta, created_at, updated_at)
                  SELECT ${folderId}, 'Task W${workerIdx}-${itemIdx}', '{}', 'todo', 'stress', '${sourceKey}', '{}', datetime('now'), datetime('now')
                  WHERE NOT EXISTS (SELECT 1 FROM work_task WHERE folder_id = ${folderId} AND source_key = '${sourceKey}');`;
        });
        return client.executeInTransaction(commands);
      });

      await Promise.all(workers);

      const integrityCheck = await client.query<{ integrity_check: string }>("PRAGMA integrity_check;");
      expect(integrityCheck).toHaveLength(1);
      expect(integrityCheck[0].integrity_check).toBe("ok");

      const fkCheck = await client.query("PRAGMA foreign_key_check;");
      expect(fkCheck).toHaveLength(0);

      const countResult = await client.query<{ count: number }>("SELECT count(*) as count FROM work_task;");
      expect(countResult[0].count).toBe(30);

      const duplicates = await client.query<{ count: number }>(`
        SELECT folder_id, source_key, count(*) as count
        FROM work_task
        GROUP BY folder_id, source_key
        HAVING count(*) > 1;
      `);
      expect(duplicates).toHaveLength(0);
    }, 20000);
  });
});
