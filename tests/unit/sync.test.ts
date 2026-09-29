import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { createTestDatabase, type TestDbInstance } from "../helpers/test-db.js";
import {
  syncPlanToCodeg,
  computePlanDiff,
  findFolder,
  findOrCreateFolder,
  PRESERVED_STATUSES
} from "../../src/sync.js";
import { parseMarkdownPlan } from "../../src/parser.js";
import { SqliteClient } from "../../src/sqlite.js";
import {
  BridgeError,
  DatabaseNotFoundError,
  PlanNotFoundError,
  FolderNotFoundError
} from "../../src/errors.js";

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

  it("полный цикл синхронизации в пустую БД (full synchronization cycle into empty DB)", async () => {
    const workspacePath = "/workspace/full-cycle-sample";
    const result = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: samplePlanPath,
      workspacePath,
      dryRun: false
    });

    expect(result.success).toBe(true);
    expect(result.planSlug).toBe("sample-plan");
    expect(result.total).toBe(4);
    expect(result.created).toBe(4);
    expect(result.updated).toBe(0);
    expect(result.preserved).toBe(0);
    expect(result.dryRun).toBe(false);

    const parentDir = dbInstance.tempDir;
    const files = await fs.readdir(parentDir);
    const backups = files.filter((f) =>
      f.startsWith(`${path.basename(dbInstance.dbPath)}.bak.`)
    );
    expect(backups.length).toBeGreaterThanOrEqual(1);

    const folders = await dbInstance.query<{ id: number; name: string; path: string }>(
      `SELECT id, name, path FROM folder WHERE path = '${workspacePath}';`
    );
    expect(folders).toHaveLength(1);
    expect(folders[0].name).toBe("full-cycle-sample");
    const folderId = folders[0].id;

    const tasks = await dbInstance.query<{
      id: number;
      folder_id: number;
      title: string;
      config: string;
      status: string;
      source_kind: string;
      source_key: string;
      source_meta: string;
    }>("SELECT id, folder_id, title, config, status, source_kind, source_key, source_meta FROM work_task ORDER BY id ASC;");

    expect(tasks).toHaveLength(4);
    for (const task of tasks) {
      expect(task.folder_id).toBe(folderId);
      expect(task.source_kind).toBe("omo_plan");
      expect(task.source_key).toBeTruthy();
      expect(task.source_key.startsWith("sample-plan:")).toBe(true);

      const parsedConfig = JSON.parse(task.config);
      expect(parsedConfig).toHaveProperty("prompt");
      expect(parsedConfig).toHaveProperty("wave");

      const parsedMeta = JSON.parse(task.source_meta);
      expect(parsedMeta.plan).toBe("sample-plan");
      expect(parsedMeta).toHaveProperty("wave");
    }

    expect(tasks.find((t) => t.title.includes("Initialize git"))?.status).toBe("done");
    expect(tasks.find((t) => t.title.includes("Setup core types"))?.status).toBe("todo");
  });

  it("конкурентная синхронизация одного и того же плана не создает дубликатов задач (concurrent synchronization does not create duplicate tasks)", async () => {
    const workspacePath = "/workspace/concurrent-sample";

    const concurrencyCount = 5;
    const syncPromises = Array.from({ length: concurrencyCount }, () =>
      syncPlanToCodeg({
        dbPath: dbInstance.dbPath,
        planPath: samplePlanPath,
        workspacePath,
        dryRun: false
      })
    );

    const results = await Promise.all(syncPromises);

    expect(results).toHaveLength(concurrencyCount);
    for (const res of results) {
      expect(res.success).toBe(true);
      expect(res.total).toBe(4);
    }

    const folders = await dbInstance.query<{ id: number; path: string }>(
      `SELECT id, path FROM folder WHERE path = '${workspacePath}';`
    );
    expect(folders).toHaveLength(1);
    const folderId = folders[0].id;

    const tasks = await dbInstance.query<{ id: number; title: string; source_key: string }>(
      `SELECT id, title, source_key FROM work_task WHERE folder_id = ${folderId};`
    );
    expect(tasks).toHaveLength(4);

    const sourceKeys = tasks.map((t) => t.source_key);
    const uniqueKeys = new Set(sourceKeys);
    expect(uniqueKeys.size).toBe(4);

    const countRow = await dbInstance.query<{ count: number }>(
      "SELECT count(*) as count FROM work_task;"
    );
    expect(countRow[0].count).toBe(4);
  });

  it("роллбэк транзакции при симуляции синтаксической ошибки в середине пакета (transaction rollback on simulated syntax error mid-batch)", async () => {
    const workspacePath = "/workspace/rollback-sample";
    const client = new SqliteClient(dbInstance.dbPath);
    const folder = await findOrCreateFolder(client, workspacePath);

    const commandsWithMidBatchSyntaxError = [
      `INSERT INTO work_task (folder_id, title, config, status, source_kind, source_key, source_meta, created_at, updated_at)
       SELECT ${folder.id}, 'Task 1 Before Error', '{}', 'todo', 'omo_plan', 'key:before', '{}', datetime('now'), datetime('now')
       WHERE NOT EXISTS (SELECT 1 FROM work_task WHERE folder_id = ${folder.id} AND source_key = 'key:before');`,
      `THIS IS AN INVALID SYNTAX ERROR STATEMENT IN THE MIDDLE OF BATCH;`,
      `INSERT INTO work_task (folder_id, title, config, status, source_kind, source_key, source_meta, created_at, updated_at)
       SELECT ${folder.id}, 'Task 2 After Error', '{}', 'todo', 'omo_plan', 'key:after', '{}', datetime('now'), datetime('now')
       WHERE NOT EXISTS (SELECT 1 FROM work_task WHERE folder_id = ${folder.id} AND source_key = 'key:after');`
    ];

    await expect(
      client.executeInTransaction(commandsWithMidBatchSyntaxError)
    ).rejects.toThrow();

    const taskCountAfterFailedBatch = await dbInstance.query<{ count: number }>(
      `SELECT count(*) as count FROM work_task WHERE folder_id = ${folder.id};`
    );
    expect(taskCountAfterFailedBatch[0].count).toBe(0);

    const clientPrototype = SqliteClient.prototype;
    const originalExecuteInTransaction = clientPrototype.executeInTransaction;

    try {
      clientPrototype.executeInTransaction = async function (commands, retryOpts) {
        const midIndex = Math.floor(commands.length / 2);
        const corruptedCommands = [
          ...commands.slice(0, midIndex),
          "MALFORMED SQL SYNTAX ERROR INSERT INTO NO_WHERE;",
          ...commands.slice(midIndex)
        ];
        return originalExecuteInTransaction.call(this, corruptedCommands, retryOpts);
      };

      await expect(
        syncPlanToCodeg({
          dbPath: dbInstance.dbPath,
          planPath: samplePlanPath,
          workspacePath,
          dryRun: false
        })
      ).rejects.toThrow();

      const taskCountAfterFailedSync = await dbInstance.query<{ count: number }>(
        `SELECT count(*) as count FROM work_task WHERE folder_id = ${folder.id};`
      );
      expect(taskCountAfterFailedSync[0].count).toBe(0);
    } finally {
      clientPrototype.executeInTransaction = originalExecuteInTransaction;
    }
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
    await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: samplePlanPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    await dbInstance.exec(`
      UPDATE work_task
      SET status = 'running'
      WHERE title LIKE '%Setup core types%';
    `);

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

  it("preserves running, claimed, review, and done statuses during re-sync", async () => {
    await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: samplePlanPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    await dbInstance.exec(`
      UPDATE work_task SET status = 'running' WHERE title LIKE '%Setup core types%';
      UPDATE work_task SET status = 'claimed' WHERE title LIKE '%Implement zero-native%';
      UPDATE work_task SET status = 'review' WHERE title LIKE '%Add bidirectional%';
      UPDATE work_task SET status = 'done' WHERE title LIKE '%Initialize git%';
    `);

    const reSyncResult = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: samplePlanPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    expect(reSyncResult.created).toBe(0);
    expect(reSyncResult.updated).toBe(0);
    expect(reSyncResult.preserved).toBe(4);

    const tasks = await dbInstance.query<{ title: string; status: string }>(
      "SELECT title, status FROM work_task;"
    );

    const running = tasks.find((t) => t.title.includes("Setup core types"));
    const claimed = tasks.find((t) => t.title.includes("Implement zero-native"));
    const review = tasks.find((t) => t.title.includes("Add bidirectional"));
    const done = tasks.find((t) => t.title.includes("Initialize git"));

    expect(running?.status).toBe("running");
    expect(claimed?.status).toBe("claimed");
    expect(review?.status).toBe("review");
    expect(done?.status).toBe("done");
  });

  it("preserves all extended statuses in PRESERVED_STATUSES set when plan has todo", async () => {
    const statusesToTest = Array.from(PRESERVED_STATUSES);

    const planPath = path.join(dbInstance.tempDir, "all-statuses-plan.md");
    const planLines = ["# Status Test Plan", "", "## Wave 1"];
    for (let i = 0; i < statusesToTest.length; i++) {
      planLines.push(`- [ ] **Task ${i} Status Check**`);
    }
    await fs.writeFile(planPath, planLines.join("\n"), "utf-8");

    await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    for (let i = 0; i < statusesToTest.length; i++) {
      await dbInstance.exec(`
        UPDATE work_task
        SET status = '${statusesToTest[i]}'
        WHERE title = 'Task ${i} Status Check';
      `);
    }

    const reSync = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    expect(reSync.created).toBe(0);
    expect(reSync.updated).toBe(0);
    expect(reSync.preserved).toBe(statusesToTest.length);

    const rows = await dbInstance.query<{ title: string; status: string }>(
      "SELECT title, status FROM work_task;"
    );

    for (let i = 0; i < statusesToTest.length; i++) {
      const match = rows.find((r) => r.title === `Task ${i} Status Check`);
      expect(match?.status).toBe(statusesToTest[i]);
    }
  });

  it("isolates tasks between Plan A and Plan B with identical names preventing hijacking", async () => {
    const planAPath = path.join(dbInstance.tempDir, "plan-a.md");
    const planBPath = path.join(dbInstance.tempDir, "plan-b.md");

    const planAContent = [
      "# Plan A",
      "",
      "## Wave 1",
      "- [ ] **Setup Shared Component**",
      "- [ ] **Unique Plan A Task**"
    ].join("\n");

    const planBContent = [
      "# Plan B",
      "",
      "## Wave 1",
      "- [ ] **Setup Shared Component**",
      "- [ ] **Unique Plan B Task**"
    ].join("\n");

    await fs.writeFile(planAPath, planAContent, "utf-8");
    await fs.writeFile(planBPath, planBContent, "utf-8");

    const syncAResult = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: planAPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    expect(syncAResult.created).toBe(2);
    expect(syncAResult.updated).toBe(0);

    await dbInstance.exec(`
      UPDATE work_task
      SET status = 'running'
      WHERE title = 'Setup Shared Component';
    `);

    const syncBResult = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: planBPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    expect(syncBResult.created).toBe(2);
    expect(syncBResult.updated).toBe(0);
    expect(syncBResult.preserved).toBe(0);

    const allTasks = await dbInstance.query<{
      id: number;
      title: string;
      status: string;
      source_key: string;
      source_meta: string;
    }>("SELECT id, title, status, source_key, source_meta FROM work_task ORDER BY id ASC;");

    expect(allTasks).toHaveLength(4);

    const sharedTasks = allTasks.filter((t) => t.title === "Setup Shared Component");
    expect(sharedTasks).toHaveLength(2);

    const planATask = sharedTasks.find((t) => t.source_key.startsWith("plan-a:"));
    const planBTask = sharedTasks.find((t) => t.source_key.startsWith("plan-b:"));

    expect(planATask).toBeDefined();
    expect(planATask?.status).toBe("running");

    expect(planBTask).toBeDefined();
    expect(planBTask?.status).toBe("todo");

    const reSyncA = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: planAPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    expect(reSyncA.created).toBe(0);
    expect(reSyncA.updated).toBe(0);
    expect(reSyncA.preserved).toBe(2);

    const reSyncB = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: planBPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    expect(reSyncB.created).toBe(0);
    expect(reSyncB.updated).toBe(0);
    expect(reSyncB.preserved).toBe(2);

    const afterReSyncTasks = await dbInstance.query<{
      title: string;
      status: string;
      source_key: string;
    }>("SELECT title, status, source_key FROM work_task;");

    const reCheckedATask = afterReSyncTasks.find((t) => t.source_key.startsWith("plan-a:") && t.title === "Setup Shared Component");
    const reCheckedBTask = afterReSyncTasks.find((t) => t.source_key.startsWith("plan-b:") && t.title === "Setup Shared Component");

    expect(reCheckedATask?.status).toBe("running");
    expect(reCheckedBTask?.status).toBe("todo");
  });

  it("supports force flag to reset preserved statuses back to plan task status", async () => {
    await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: samplePlanPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    await dbInstance.exec(`
      UPDATE work_task SET status = 'running' WHERE title LIKE '%Setup core types%';
      UPDATE work_task SET status = 'claimed' WHERE title LIKE '%Implement zero-native%';
      UPDATE work_task SET status = 'review' WHERE title LIKE '%Add bidirectional%';
      UPDATE work_task SET status = 'done' WHERE title LIKE '%Initialize git%';
    `);

    const standardSync = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: samplePlanPath,
      workspacePath: "/workspace/sample",
      dryRun: false,
      force: false
    });

    expect(standardSync.preserved).toBe(4);
    expect(standardSync.updated).toBe(0);

    const forcedSync = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: samplePlanPath,
      workspacePath: "/workspace/sample",
      dryRun: false,
      force: true
    });

    expect(forcedSync.updated).toBe(3);
    expect(forcedSync.preserved).toBe(1);
    expect(forcedSync.created).toBe(0);

    const tasks = await dbInstance.query<{ title: string; status: string }>(
      "SELECT title, status FROM work_task;"
    );

    const task1 = tasks.find((t) => t.title.includes("Setup core types"));
    const task2 = tasks.find((t) => t.title.includes("Implement zero-native"));
    const task3 = tasks.find((t) => t.title.includes("Add bidirectional"));
    const task4 = tasks.find((t) => t.title.includes("Initialize git"));

    expect(task1?.status).toBe("todo");
    expect(task2?.status).toBe("todo");
    expect(task3?.status).toBe("todo");
    expect(task4?.status).toBe("done");
  });

  it("updates task to done when marked done in plan even if status in db was running", async () => {
    const testPlanPath = path.join(dbInstance.tempDir, "sample-plan.md");
    const originalContent = await fs.readFile(samplePlanPath, "utf-8");
    await fs.writeFile(testPlanPath, originalContent, "utf-8");

    await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: testPlanPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    await dbInstance.exec(`
      UPDATE work_task SET status = 'running' WHERE title LIKE '%Setup core types%';
    `);

    const updatedContent = originalContent.replace(
      "- [ ] **[IMPL] Setup core types and interfaces**",
      "- [x] **[IMPL] Setup core types and interfaces**"
    );
    await fs.writeFile(testPlanPath, updatedContent, "utf-8");

    const syncResult = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: testPlanPath,
      workspacePath: "/workspace/sample",
      dryRun: false
    });

    expect(syncResult.updated).toBe(1);
    expect(syncResult.preserved).toBe(3);

    const task = await dbInstance.query<{ status: string }>(
      "SELECT status FROM work_task WHERE title LIKE '%Setup core types%';"
    );
    expect(task[0].status).toBe("done");
  });

  it("matches manual unkeyed task by title fallback and preserves status", async () => {
    const client = new SqliteClient(dbInstance.dbPath);
    const folder = await findOrCreateFolder(client, "/workspace/sample");
    const folderId = folder.id;

    await dbInstance.exec(`
      INSERT INTO work_task (folder_id, title, config, status, source_kind, source_key, source_meta, created_at, updated_at)
      VALUES (${folderId}, '[IMPL] Setup core types and interfaces', '{}', 'running', NULL, NULL, NULL, datetime('now'), datetime('now'));
    `);

    const planContent = await fs.readFile(samplePlanPath, "utf-8");
    const plan = parseMarkdownPlan(planContent, samplePlanPath);
    const diffs = await computePlanDiff(client, plan, folderId);

    const matchedDiff = diffs.find((d) => d.task.title.includes("Setup core types"));
    expect(matchedDiff).toBeDefined();
    expect(matchedDiff?.action).toBe("preserve");
    expect(matchedDiff?.currentStatus).toBe("running");
    expect(matchedDiff?.targetStatus).toBe("running");
  });

  it("supports dryRun preview without touching database records (zero mutations on work_task and folder)", async () => {
    const dryRunResult = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: samplePlanPath,
      workspacePath: "/workspace/sample",
      dryRun: true
    });

    expect(dryRunResult.dryRun).toBe(true);
    expect(dryRunResult.created).toBe(4);

    const taskCount = await dbInstance.query<{ count: number }>(
      "SELECT count(*) as count FROM work_task;"
    );
    expect(taskCount[0].count).toBe(0);

    const folderCount = await dbInstance.query<{ count: number }>(
      "SELECT count(*) as count FROM folder;"
    );
    expect(folderCount[0].count).toBe(0);
  });
});

describe("syncPlanToCodeg Input Validation", () => {
  let dbInstance: TestDbInstance;
  let samplePlanPath: string;

  beforeEach(async () => {
    dbInstance = await createTestDatabase();
    samplePlanPath = path.resolve(__dirname, "../fixtures/sample-plan.md");
  });

  afterEach(async () => {
    await dbInstance.cleanup();
  });

  it("throws DatabaseNotFoundError when dbPath is missing or invalid", async () => {
    await expect(
      syncPlanToCodeg({
        dbPath: "",
        planPath: samplePlanPath,
        workspacePath: "/workspace/sample"
      })
    ).rejects.toThrowError(DatabaseNotFoundError);
  });

  it("throws PlanNotFoundError when planPath is missing or file does not exist", async () => {
    await expect(
      syncPlanToCodeg({
        dbPath: dbInstance.dbPath,
        planPath: "",
        workspacePath: "/workspace/sample"
      })
    ).rejects.toThrowError(PlanNotFoundError);

    await expect(
      syncPlanToCodeg({
        dbPath: dbInstance.dbPath,
        planPath: "/non/existent/path/plan.md",
        workspacePath: "/workspace/sample"
      })
    ).rejects.toThrowError(PlanNotFoundError);
  });

  it("throws FolderNotFoundError when workspacePath is missing or invalid", async () => {
    await expect(
      syncPlanToCodeg({
        dbPath: dbInstance.dbPath,
        planPath: samplePlanPath,
        workspacePath: ""
      })
    ).rejects.toThrowError(FolderNotFoundError);
  });

  it("throws BridgeError when dryRun or force is not a boolean", async () => {
    await expect(
      syncPlanToCodeg({
        dbPath: dbInstance.dbPath,
        planPath: samplePlanPath,
        workspacePath: "/workspace/sample",
        dryRun: "true" as any
      })
    ).rejects.toThrowError(BridgeError);

    await expect(
      syncPlanToCodeg({
        dbPath: dbInstance.dbPath,
        planPath: samplePlanPath,
        workspacePath: "/workspace/sample",
        force: 123 as any
      })
    ).rejects.toThrowError(BridgeError);
  });

  it("assigns monotonically increasing sort_order based on existing max(sort_order)", async () => {
    const emptyWorkspace = "/workspace/empty-db-sort-order";
    const planPath1 = path.join(dbInstance.tempDir, "plan-empty-db.md");
    await fs.writeFile(
      planPath1,
      [
        "# FIFO Empty DB Test Plan",
        "",
        "## Wave 1",
        "- [ ] **[IMPL-01/03] Task One**",
        "- [ ] **[IMPL-02/03] Task Two**",
        "- [ ] **[IMPL-03/03] Task Three**"
      ].join("\n"),
      "utf-8"
    );

    const result1 = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: planPath1,
      workspacePath: emptyWorkspace,
      dryRun: false
    });

    expect(result1.success).toBe(true);
    expect(result1.created).toBe(3);

    const folder1 = await findFolder(new SqliteClient(dbInstance.dbPath), emptyWorkspace);
    expect(folder1).not.toBeNull();

    const tasks1 = await dbInstance.query<{ title: string; sort_order: number }>(
      `SELECT title, sort_order FROM work_task WHERE folder_id = ${folder1!.id} ORDER BY id ASC;`
    );

    expect(tasks1).toHaveLength(3);
    expect(tasks1[0].sort_order).toBe(1);
    expect(tasks1[1].sort_order).toBe(2);
    expect(tasks1[2].sort_order).toBe(3);

    const existingWorkspace = "/workspace/existing-max-sort-order";
    const client = new SqliteClient(dbInstance.dbPath);
    const folder2 = await findOrCreateFolder(client, existingWorkspace);

    await dbInstance.exec(`
      INSERT INTO work_task (folder_id, title, config, status, sort_order, created_at, updated_at)
      VALUES (${folder2.id}, 'Pre-existing Task', '{}', 'todo', 10, datetime('now'), datetime('now'));
    `);

    const planPath2 = path.join(dbInstance.tempDir, "plan-existing-max.md");
    await fs.writeFile(
      planPath2,
      [
        "# FIFO Existing Max Test Plan",
        "",
        "## Wave 1",
        "- [ ] **[IMPL-01/03] Alpha Feature**",
        "- [ ] **[IMPL-02/03] Beta Feature**",
        "- [ ] **[IMPL-03/03] Gamma Feature**"
      ].join("\n"),
      "utf-8"
    );

    const result2 = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath: planPath2,
      workspacePath: existingWorkspace,
      dryRun: false
    });

    expect(result2.success).toBe(true);
    expect(result2.created).toBe(3);

    const tasks2 = await dbInstance.query<{ title: string; sort_order: number }>(
      `SELECT title, sort_order FROM work_task WHERE folder_id = ${folder2.id} AND title != 'Pre-existing Task' ORDER BY id ASC;`
    );

    expect(tasks2).toHaveLength(3);
    expect(tasks2[0].sort_order).toBe(11);
    expect(tasks2[1].sort_order).toBe(12);
    expect(tasks2[2].sort_order).toBe(13);
  });
});

describe("Non-mutating Folder Discovery & Atomic Upsert", () => {
  let dbInstance: TestDbInstance;
  let client: SqliteClient;
  let samplePlanPath: string;

  beforeEach(async () => {
    dbInstance = await createTestDatabase();
    client = new SqliteClient(dbInstance.dbPath);
    samplePlanPath = path.resolve(__dirname, "../fixtures/sample-plan.md");
  });

  afterEach(async () => {
    await dbInstance.cleanup();
  });

  it("findFolder returns null and does NOT insert into folder table when path is missing", async () => {
    const nonExistentPath = "/workspace/does-not-exist";
    const found = await findFolder(client, nonExistentPath);

    expect(found).toBeNull();

    const folderRows = await dbInstance.query<{ count: number }>(
      "SELECT count(*) as count FROM folder;"
    );
    expect(folderRows[0].count).toBe(0);
  });

  it("findFolder returns existing FolderRow when folder exists", async () => {
    const targetPath = "/workspace/project-alpha";
    await dbInstance.exec(`
      INSERT INTO folder (name, path, git_branch, last_opened_at, created_at, updated_at, is_open)
      VALUES ('project-alpha', '${targetPath}', 'main', datetime('now'), datetime('now'), datetime('now'), 1);
    `);

    const found = await findFolder(client, targetPath);
    expect(found).not.toBeNull();
    expect(found?.name).toBe("project-alpha");
    expect(found?.path).toBe(targetPath);
    expect(typeof found?.id).toBe("number");
  });

  it("findOrCreateFolder atomically inserts new folder and returns FolderRow", async () => {
    const targetPath = "/workspace/new-folder";
    const folder = await findOrCreateFolder(client, targetPath);

    expect(folder).toBeDefined();
    expect(folder.id).toBeGreaterThan(0);
    expect(folder.name).toBe("new-folder");
    expect(folder.path).toBe(targetPath);

    const count = await dbInstance.query<{ count: number }>(
      "SELECT count(*) as count FROM folder;"
    );
    expect(count[0].count).toBe(1);
  });

  it("findOrCreateFolder uses ON CONFLICT(path) to update without duplicates or errors", async () => {
    const targetPath = "/workspace/idempotent-folder";

    const first = await findOrCreateFolder(client, targetPath);
    const second = await findOrCreateFolder(client, targetPath);

    expect(second.id).toBe(first.id);
    expect(second.path).toBe(first.path);

    const count = await dbInstance.query<{ count: number }>(
      "SELECT count(*) as count FROM folder WHERE path = '" + targetPath + "';"
    );
    expect(count[0].count).toBe(1);
  });

  it("computePlanDiff with folderId=null generates all 'create' actions with zero DB mutations", async () => {
    const planContent = await fs.readFile(samplePlanPath, "utf-8");
    const plan = parseMarkdownPlan(planContent, samplePlanPath);

    const diffs = await computePlanDiff(client, plan, null);

    expect(diffs).toHaveLength(plan.tasks.length);
    for (const diff of diffs) {
      expect(diff.action).toBe("create");
      expect(diff.existingId).toBeUndefined();
    }

    const folderCount = await dbInstance.query<{ count: number }>(
      "SELECT count(*) as count FROM folder;"
    );
    expect(folderCount[0].count).toBe(0);

    const taskCount = await dbInstance.query<{ count: number }>(
      "SELECT count(*) as count FROM work_task;"
    );
    expect(taskCount[0].count).toBe(0);
  });

  it("inspection via findFolder + computePlanDiff leaves DB 100% unmutated for new workspace path", async () => {
    const newWorkspacePath = "/workspace/brand-new-inspected-project";
    const planContent = await fs.readFile(samplePlanPath, "utf-8");
    const plan = parseMarkdownPlan(planContent, samplePlanPath);

    const existingFolder = await findFolder(client, newWorkspacePath);
    expect(existingFolder).toBeNull();

    const diffs = await computePlanDiff(client, plan, existingFolder ? existingFolder.id : null);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.every((d) => d.action === "create")).toBe(true);

    const folderCount = await dbInstance.query<{ count: number }>(
      "SELECT count(*) as count FROM folder;"
    );
    expect(folderCount[0].count).toBe(0);

    const taskCount = await dbInstance.query<{ count: number }>(
      "SELECT count(*) as count FROM work_task;"
    );
    expect(taskCount[0].count).toBe(0);
  });
});
