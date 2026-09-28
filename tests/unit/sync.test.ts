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
