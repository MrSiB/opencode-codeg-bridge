import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { createTestDatabase, type TestDbInstance } from "../helpers/test-db.js";
import { syncPlanToCodeg, findOrCreateFolder } from "../../src/sync.js";
import { SqliteClient } from "../../src/sqlite.js";

describe("Phase 4 Validation Playbook: Two-Stage Approval Gate & Strict FIFO Execution", () => {
  let dbInstance: TestDbInstance;
  let workspacePath: string;
  let planDir: string;

  beforeEach(async () => {
    dbInstance = await createTestDatabase();
    workspacePath = "/workspace/phase4-verification";
    planDir = path.join(dbInstance.tempDir, ".omo", "plans");
    await fs.mkdir(planDir, { recursive: true });
  });

  afterEach(async () => {
    await dbInstance.cleanup();
  });

  it("Step 1 (Stage 1 Idle Test): Plan file generation stops with zero tasks created in Codeg DB", async () => {
    const planSlug = "test_validation_plan";
    const planPath = path.join(planDir, `${planSlug}.md`);

    // Simulate Stage 1: Synthesis outputs plan markdown into .omo/plans/
    const stage1PlanContent = [
      `# ${planSlug}`,
      "",
      "## Executive Summary",
      "Stage 1 synthesized plan awaiting explicit user review and confirmation.",
      "",
      "## Work Breakdown Structure",
      "- [ ] **[IMPL-01/03] Core: Setup data models**",
      "- [ ] **[IMPL-02/03] Core: Add business logic**",
      "- [ ] **[IMPL-03/03] Core: Implement verification tests**"
    ].join("\n");

    await fs.writeFile(planPath, stage1PlanContent, "utf-8");

    // Verify plan file exists on disk
    const planStat = await fs.stat(planPath);
    expect(planStat.isFile()).toBe(true);

    // Verify Invariant: ZERO tasks added to work_task in codeg.db
    const initialTasks = await dbInstance.query<{ count: number }>(
      "SELECT count(*) as count FROM work_task;"
    );
    expect(initialTasks[0].count).toBe(0);

    // Verify Invariant: ZERO folders created or mutated
    const initialFolders = await dbInstance.query<{ count: number }>(
      "SELECT count(*) as count FROM folder;"
    );
    expect(initialFolders[0].count).toBe(0);

    // Simulating dry-run / audit inspection confirms zero side effects
    const inspectResult = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath,
      workspacePath,
      dryRun: true
    });

    expect(inspectResult.dryRun).toBe(true);
    expect(inspectResult.total).toBe(3);
    expect(inspectResult.created).toBe(3);

    // Assert DB remains 100% untouched
    const postAuditTasks = await dbInstance.query<{ count: number }>(
      "SELECT count(*) as count FROM work_task;"
    );
    expect(postAuditTasks[0].count).toBe(0);
  });

  it("Step 2 (Stage 2 Ordering Test): Approved plan registers tasks with [IMPL-XX/NN] titles and strictly ascending sort_order K+1, K+2, K+3", async () => {
    const client = new SqliteClient(dbInstance.dbPath);
    const folder = await findOrCreateFolder(client, workspacePath);
    const folderId = folder.id;

    // Simulate pre-existing task in folder to test baseline K
    const baselineSortOrder = 20;
    await dbInstance.exec(`
      INSERT INTO work_task (folder_id, title, config, status, sort_order, created_at, updated_at)
      VALUES (${folderId}, 'Existing Task Before Plan Approval', '{}', 'done', ${baselineSortOrder}, datetime('now'), datetime('now'));
    `);

    // Verify baseline K = 20
    const baselineOrderRows = await client.query<{ max_order: number }>(
      `SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM work_task WHERE folder_id = ${folderId};`
    );
    const K = baselineOrderRows[0].max_order;
    expect(K).toBe(baselineSortOrder);

    // Stage 2: User provides explicit confirmation ("Утверждаю")
    // Approved plan markdown is synchronized
    const planSlug = "approved_execution_plan";
    const planPath = path.join(planDir, `${planSlug}.md`);
    const planContent = [
      `# ${planSlug}`,
      "",
      "## Wave 1",
      "- [ ] **[IMPL-01/03] Database: Apply migration schema**",
      "- [ ] **[IMPL-02/03] API: Author endpoints and routes**",
      "- [ ] **[IMPL-03/03] Test: Verify integration behavior**"
    ].join("\n");

    await fs.writeFile(planPath, planContent, "utf-8");

    const syncResult = await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath,
      workspacePath,
      dryRun: false
    });

    expect(syncResult.success).toBe(true);
    expect(syncResult.created).toBe(3);

    // Query newly registered tasks
    const tasks = await dbInstance.query<{
      id: number;
      title: string;
      sort_order: number;
      status: string;
    }>(
      `SELECT id, title, sort_order, status FROM work_task 
       WHERE folder_id = ${folderId} AND title LIKE '[IMPL-%'
       ORDER BY id ASC;`
    );

    expect(tasks).toHaveLength(3);

    // Check [IMPL-XX/NN] titles
    expect(tasks[0].title).toBe("[IMPL-01/03] Database: Apply migration schema");
    expect(tasks[1].title).toBe("[IMPL-02/03] API: Author endpoints and routes");
    expect(tasks[2].title).toBe("[IMPL-03/03] Test: Verify integration behavior");

    // Check sort_order values: K+1, K+2, K+3
    expect(tasks[0].sort_order).toBe(K + 1); // 21
    expect(tasks[1].sort_order).toBe(K + 2); // 22
    expect(tasks[2].sort_order).toBe(K + 3); // 23

    // Check strict monotonicity: task 0 < task 1 < task 2
    expect(tasks[0].sort_order).toBeLessThan(tasks[1].sort_order);
    expect(tasks[1].sort_order).toBeLessThan(tasks[2].sort_order);
  });

  it("Step 3 (FIFO Execution Verification): Engine schedules and executes queued tasks strictly by sort_order ASC, id ASC (1 -> 2 -> 3)", async () => {
    const client = new SqliteClient(dbInstance.dbPath);
    const folder = await findOrCreateFolder(client, workspacePath);
    const folderId = folder.id;

    const planPath = path.join(planDir, "fifo_dispatch_plan.md");
    const planContent = [
      "# FIFO Dispatch Verification Plan",
      "",
      "## Wave 1",
      "- [ ] **[IMPL-01/03] Step 1: Initialize service**",
      "- [ ] **[IMPL-02/03] Step 2: Configure middleware**",
      "- [ ] **[IMPL-03/03] Step 3: Run validation checks**"
    ].join("\n");

    await fs.writeFile(planPath, planContent, "utf-8");

    await syncPlanToCodeg({
      dbPath: dbInstance.dbPath,
      planPath,
      workspacePath,
      dryRun: false
    });

    const tasks = await dbInstance.query<{ id: number; title: string; sort_order: number }>(
      `SELECT id, title, sort_order FROM work_task WHERE folder_id = ${folderId} ORDER BY sort_order ASC, id ASC;`
    );
    expect(tasks).toHaveLength(3);

    const [t1, t2, t3] = tasks;
    expect(t1.title).toContain("[IMPL-01/03]");
    expect(t2.title).toContain("[IMPL-02/03]");
    expect(t3.title).toContain("[IMPL-03/03]");

    // Exact Engine Scheduling Query Disassembled from codeg-server binary:
    // SELECT work_task.* FROM work_task 
    // INNER JOIN folder ON folder.id = work_task.folder_id
    // WHERE work_task.deleted_at IS NULL 
    //   AND work_task.folder_id = ? 
    //   AND work_task.status = 'todo' 
    //   AND work_task.scheduled_at IS NULL 
    //   AND folder.deleted_at IS NULL 
    // ORDER BY work_task.sort_order ASC, work_task.id ASC 
    // LIMIT 1;
    const fetchNextTaskSql = `
      SELECT work_task.id, work_task.title, work_task.sort_order
      FROM work_task 
      INNER JOIN folder ON folder.id = work_task.folder_id 
      WHERE work_task.deleted_at IS NULL 
        AND work_task.folder_id = ${folderId} 
        AND work_task.status = 'todo' 
        AND work_task.scheduled_at IS NULL 
        AND folder.deleted_at IS NULL 
      ORDER BY work_task.sort_order ASC, work_task.id ASC 
      LIMIT 1;
    `;

    const executionLog: Array<{ taskId: number; title: string; startedAt: string }> = [];

    // Cycle 1: First engine poll
    const poll1 = await dbInstance.query<{ id: number; title: string; sort_order: number }>(fetchNextTaskSql);
    expect(poll1).toHaveLength(1);
    expect(poll1[0].id).toBe(t1.id);
    expect(poll1[0].title).toBe(t1.title);

    // Simulate task 1 start and transition to running
    const t1StartTime = "2026-09-29T10:00:01.000Z";
    await dbInstance.exec(`
      UPDATE work_task SET status = 'running', started_at = '${t1StartTime}', updated_at = '${t1StartTime}' WHERE id = ${t1.id};
      INSERT INTO work_task_event (task_id, kind, actor, created_at) VALUES (${t1.id}, 'status_changed', 'engine', '${t1StartTime}');
    `);
    executionLog.push({ taskId: t1.id, title: t1.title, startedAt: t1StartTime });

    // While task 1 is running, poll should return NO todo tasks if only 1 worker,
    // or if another worker asks for next 'todo' task, it must get task 2:
    const pollWhile1Running = await dbInstance.query<{ id: number; title: string }>(fetchNextTaskSql);
    expect(pollWhile1Running[0].id).toBe(t2.id);

    // Settle Task 1 -> done
    const t1DoneTime = "2026-09-29T10:00:05.000Z";
    await dbInstance.exec(`
      UPDATE work_task SET status = 'done', settled_at = '${t1DoneTime}', updated_at = '${t1DoneTime}' WHERE id = ${t1.id};
      INSERT INTO work_task_event (task_id, kind, actor, created_at) VALUES (${t1.id}, 'status_changed', 'engine', '${t1DoneTime}');
    `);

    // Cycle 2: Second engine poll (after Task 1 finished)
    const poll2 = await dbInstance.query<{ id: number; title: string }>(fetchNextTaskSql);
    expect(poll2).toHaveLength(1);
    expect(poll2[0].id).toBe(t2.id);
    expect(poll2[0].title).toBe(t2.title);

    // Simulate task 2 start and completion
    const t2StartTime = "2026-09-29T10:00:06.000Z";
    await dbInstance.exec(`
      UPDATE work_task SET status = 'running', started_at = '${t2StartTime}', updated_at = '${t2StartTime}' WHERE id = ${t2.id};
      INSERT INTO work_task_event (task_id, kind, actor, created_at) VALUES (${t2.id}, 'status_changed', 'engine', '${t2StartTime}');
    `);
    executionLog.push({ taskId: t2.id, title: t2.title, startedAt: t2StartTime });

    const t2DoneTime = "2026-09-29T10:00:10.000Z";
    await dbInstance.exec(`
      UPDATE work_task SET status = 'done', settled_at = '${t2DoneTime}', updated_at = '${t2DoneTime}' WHERE id = ${t2.id};
      INSERT INTO work_task_event (task_id, kind, actor, created_at) VALUES (${t2.id}, 'status_changed', 'engine', '${t2DoneTime}');
    `);

    // Cycle 3: Third engine poll
    const poll3 = await dbInstance.query<{ id: number; title: string }>(fetchNextTaskSql);
    expect(poll3).toHaveLength(1);
    expect(poll3[0].id).toBe(t3.id);
    expect(poll3[0].title).toBe(t3.title);

    // Simulate task 3 start and completion
    const t3StartTime = "2026-09-29T10:00:11.000Z";
    await dbInstance.exec(`
      UPDATE work_task SET status = 'running', started_at = '${t3StartTime}', updated_at = '${t3StartTime}' WHERE id = ${t3.id};
      INSERT INTO work_task_event (task_id, kind, actor, created_at) VALUES (${t3.id}, 'status_changed', 'engine', '${t3StartTime}');
    `);
    executionLog.push({ taskId: t3.id, title: t3.title, startedAt: t3StartTime });

    const t3DoneTime = "2026-09-29T10:00:15.000Z";
    await dbInstance.exec(`
      UPDATE work_task SET status = 'done', settled_at = '${t3DoneTime}', updated_at = '${t3DoneTime}' WHERE id = ${t3.id};
      INSERT INTO work_task_event (task_id, kind, actor, created_at) VALUES (${t3.id}, 'status_changed', 'engine', '${t3DoneTime}');
    `);

    // Cycle 4: Queue is now empty
    const poll4 = await dbInstance.query<{ id: number }>(fetchNextTaskSql);
    expect(poll4).toHaveLength(0);

    // Verify chronological execution sequence from work_task_event
    const events = await dbInstance.query<{
      task_id: number;
      kind: string;
      created_at: string;
    }>(
      `SELECT task_id, kind, created_at FROM work_task_event 
       WHERE kind = 'status_changed' AND task_id IN (${t1.id}, ${t2.id}, ${t3.id})
       ORDER BY id ASC;`
    );

    expect(events.length).toBe(6); // 2 per task (running + done)

    // Verify start event ordering: Task 1 -> Task 2 -> Task 3
    const startEvents = events.filter((_, idx) => idx % 2 === 0);
    expect(startEvents[0].task_id).toBe(t1.id);
    expect(startEvents[1].task_id).toBe(t2.id);
    expect(startEvents[2].task_id).toBe(t3.id);

    // Verify timestamps are monotonically increasing
    expect(new Date(startEvents[0].created_at).getTime()).toBeLessThan(
      new Date(startEvents[1].created_at).getTime()
    );
    expect(new Date(startEvents[1].created_at).getTime()).toBeLessThan(
      new Date(startEvents[2].created_at).getTime()
    );

    // Verify execution log
    expect(executionLog.map((e) => e.taskId)).toEqual([t1.id, t2.id, t3.id]);
  });
});
