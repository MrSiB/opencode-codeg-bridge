import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { createTestDatabase, type TestDbInstance } from "../helpers/test-db.js";
import { syncPlanToCodeg } from "../../src/sync.js";

describe("Idempotent Plan-to-Task Synchronizer", () => {
  let dbInstance: TestDbInstance;
  let samplePlanPath: string;

  beforeEach(async () => {
    dbInstance = await createTestDatabase();
    samplePlanPath = path.resolve(__dirname, "../fixtures/sample-plan.md");
  });

  afterEach(async () => {
    await dbInstance.cleanup();
  });

  it("syncs plan into empty database and creates tasks with correct statuses", async () => {
    const result = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: samplePlanPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    expect(result.created).toBe(4);
    expect(result.updated).toBe(0);
    expect(result.preserved).toBe(0);

    const tasks = await dbInstance.query<{ title: string; status: string; source_key: string }>(
      "SELECT title, status, source_key FROM work_task;"
    );

    expect(tasks).toHaveLength(4);
    expect(tasks.find((t) => t.title.includes("Initialize git"))?.status).toBe("done");
    expect(tasks.find((t) => t.title.includes("Setup core types"))?.status).toBe("todo");
  });

  it("preserves running, in_progress, and review statuses during re-sync", async () => {
    // Initial sync
    await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: samplePlanPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    // Simulate an agent picking up task 1 and moving it to running
    await dbInstance.exec(`
      UPDATE work_task
      SET status = 'running'
      WHERE title LIKE '%Setup core types%';
    `);

    // Re-sync
    const reSyncResult = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: samplePlanPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    expect(reSyncResult.created).toBe(0);
    expect(reSyncResult.preserved).toBe(4);

    const runningTask = await dbInstance.query<{ status: string }>(
      "SELECT status FROM work_task WHERE title LIKE '%Setup core types%';"
    );
    expect(runningTask[0].status).toBe("running");
  });

  it("supports dryRun preview without touching database records", async () => {
    const dryRunResult = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: samplePlanPath,
      workspacePath: "/workspace/sample",
      dryRun: true
    });

    expect(dryRunResult.dryRun).toBe(true);
    expect(dryRunResult.created).toBe(4);

    const count = await dbInstance.query<{ count: number }>(
      "SELECT count(*) as count FROM work_task;"
    );
    expect(count[0].count).toBe(0);
  });
});
