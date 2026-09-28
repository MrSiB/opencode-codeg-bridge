import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { createTestDatabase, type TestDbInstance } from "../helpers/test-db.js";
import {
  syncPlanToCodeg,
  findFolder,
  findOrCreateFolder,
  computePlanDiff
} from "../../src/sync.js";
import { SqliteClient } from "../../src/sqlite.js";
import { parseMarkdownPlan } from "../../src/parser.js";

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
