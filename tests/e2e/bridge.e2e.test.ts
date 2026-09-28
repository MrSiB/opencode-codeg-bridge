import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { createTestDatabase, type TestDbInstance } from "../helpers/test-db.js";
import { listDatabaseBackups } from "../../src/backup.js";
import opencodeCodegBridgePlugin from "../../src/plugin.js";

const execFileAsync = promisify(execFile);

function stripAnsi(str: string): string {
  return str.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("End-to-End (E2E) Integration: CLI & Plugin Full Lifecycle", () => {
  const cliPath = path.resolve(__dirname, "../../bin/omo-codeg");
  const samplePlanPath = path.resolve(__dirname, "../fixtures/sample-plan.md");
  let testDb: TestDbInstance;

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it("completes full 8-step lifecycle scenario via omo-codeg CLI", async () => {
    const workspacePath = "/workspace/e2e-cli-lifecycle-test";

    // -------------------------------------------------------------------------
    // Шаг 1: Запуск doctor на тестовой БД -> код возврата 0
    // -------------------------------------------------------------------------
    const { stdout: doctorStdout } = await execFileAsync(cliPath, [
      "doctor",
      "--db",
      testDb.dbPath,
      "--workspace",
      workspacePath
    ]);
    const cleanDoctorOut = stripAnsi(doctorStdout);
    expect(cleanDoctorOut).toContain("=== omo-codeg doctor ===");
    expect(cleanDoctorOut).toContain("[PASS] node_version");
    expect(cleanDoctorOut).toContain("[PASS] sqlite3_cli");
    expect(cleanDoctorOut).toContain("[PASS] database_accessibility");
    expect(cleanDoctorOut).toContain("[PASS] wal_shm_permissions");
    expect(cleanDoctorOut).toContain("All health checks passed successfully!");

    // -------------------------------------------------------------------------
    // Шаг 2: Запуск diff на пустой БД -> проверка, что папка не создается (non-mutating)
    // -------------------------------------------------------------------------
    const { stdout: diffInitialStdout } = await execFileAsync(cliPath, [
      "diff",
      "--db",
      testDb.dbPath,
      "--plan",
      samplePlanPath,
      "--workspace",
      workspacePath
    ]);
    const cleanDiffInitialOut = stripAnsi(diffInitialStdout);
    expect(cleanDiffInitialOut).toContain("=== Diff: Multi-Wave Test Plan ===");
    expect(cleanDiffInitialOut).toContain("[+] CREATE");

    // Invariant verification: Zero records in folder and work_task
    const folderCountStep2 = await testDb.query<{ count: number }>(
      "SELECT count(*) as count FROM folder;"
    );
    expect(folderCountStep2[0].count).toBe(0);

    const taskCountStep2 = await testDb.query<{ count: number }>(
      "SELECT count(*) as count FROM work_task;"
    );
    expect(taskCountStep2[0].count).toBe(0);

    // -------------------------------------------------------------------------
    // Шаг 3: Запуск sync -> задачи создаются со стабильными source_key, создается первый бэкап
    // -------------------------------------------------------------------------
    const { stdout: syncInitialStdout } = await execFileAsync(cliPath, [
      "sync",
      "--db",
      testDb.dbPath,
      "--plan",
      samplePlanPath,
      "--workspace",
      workspacePath
    ]);
    const cleanSyncInitialOut = stripAnsi(syncInitialStdout);
    expect(cleanSyncInitialOut).toContain("Sync complete! Total: 4, Created: 4, Updated: 0, Preserved: 0");

    // Invariant: Folder created
    const foldersStep3 = await testDb.query<{ id: number; path: string }>(
      `SELECT id, path FROM folder WHERE path = '${workspacePath}';`
    );
    expect(foldersStep3).toHaveLength(1);
    const folderId = foldersStep3[0].id;

    // Invariant: 4 tasks created with stable source_key matching sample-plan:
    const tasksStep3 = await testDb.query<{
      id: number;
      folder_id: number;
      title: string;
      status: string;
      source_key: string;
      source_meta: string;
    }>("SELECT id, folder_id, title, status, source_key, source_meta FROM work_task ORDER BY id ASC;");
    expect(tasksStep3).toHaveLength(4);
    for (const t of tasksStep3) {
      expect(t.folder_id).toBe(folderId);
      expect(t.source_key).toBeTruthy();
      expect(t.source_key.startsWith("sample-plan:")).toBe(true);

      const parsedMeta = JSON.parse(t.source_meta);
      expect(parsedMeta.plan).toBe("sample-plan");
      expect(parsedMeta).toHaveProperty("wave");
    }

    // Invariant: Exactly 1 backup file created on disk
    const backupsStep3 = await listDatabaseBackups(testDb.dbPath);
    expect(backupsStep3).toHaveLength(1);
    expect(backupsStep3[0]).toContain(`${path.basename(testDb.dbPath)}.bak.`);

    // -------------------------------------------------------------------------
    // Шаг 4: Имитация работы пользователя (прямой SQL-запрос переводит задачу в running)
    // -------------------------------------------------------------------------
    await testDb.exec(
      "UPDATE work_task SET status = 'running' WHERE title LIKE '%Setup core types%';"
    );
    const runningTasksStep4 = await testDb.query<{ id: number; title: string; status: string }>(
      "SELECT id, title, status FROM work_task WHERE status = 'running';"
    );
    expect(runningTasksStep4).toHaveLength(1);
    expect(runningTasksStep4[0].title).toContain("Setup core types");
    expect(runningTasksStep4[0].status).toBe("running");

    // -------------------------------------------------------------------------
    // Шаг 5: Повторный diff -> задача помечена как [=] PRESERVE
    // -------------------------------------------------------------------------
    const { stdout: diffPreserveStdout } = await execFileAsync(cliPath, [
      "diff",
      "--db",
      testDb.dbPath,
      "--plan",
      samplePlanPath,
      "--workspace",
      workspacePath
    ]);
    const cleanDiffPreserveOut = stripAnsi(diffPreserveStdout);
    expect(cleanDiffPreserveOut).toContain("[=] PRESERVE");
    expect(cleanDiffPreserveOut).toContain("Setup core types");
    expect(cleanDiffPreserveOut).toContain("(target status: running)");

    // -------------------------------------------------------------------------
    // Шаг 6: Повторный sync -> задача остается в статусе running в базе данных (инвариант сохранен)
    // -------------------------------------------------------------------------
    const { stdout: syncPreserveStdout } = await execFileAsync(cliPath, [
      "sync",
      "--db",
      testDb.dbPath,
      "--plan",
      samplePlanPath,
      "--workspace",
      workspacePath
    ]);
    const cleanSyncPreserveOut = stripAnsi(syncPreserveStdout);
    expect(cleanSyncPreserveOut).toContain("Sync complete! Total: 4, Created: 0, Updated: 0, Preserved: 4");

    const tasksStep6 = await testDb.query<{ title: string; status: string }>(
      "SELECT title, status FROM work_task WHERE title LIKE '%Setup core types%';"
    );
    expect(tasksStep6[0].status).toBe("running");

    // -------------------------------------------------------------------------
    // Шаг 7: Проверка ротации бэкапов: выполнение 6 последовательных синхронизаций,
    // проверка, что на диске осталось ровно 5 новейших файлов .bak.<timestamp>
    // -------------------------------------------------------------------------
    for (let i = 1; i <= 6; i++) {
      // 40ms delay guarantees distinct millisecond ISO timestamps
      await new Promise((resolve) => setTimeout(resolve, 40));
      await execFileAsync(cliPath, [
        "sync",
        "--db",
        testDb.dbPath,
        "--plan",
        samplePlanPath,
        "--workspace",
        workspacePath
      ]);
    }

    const parentDir = testDb.tempDir;
    const dirEntries = await fs.readdir(parentDir);
    const backupFiles = dirEntries.filter((f) =>
      f.startsWith(`${path.basename(testDb.dbPath)}.bak.`)
    );

    // Exactly 5 newest backups preserved
    expect(backupFiles).toHaveLength(5);

    // Validate that each backup file is valid SQLite and matches the timestamp pattern
    for (const fileName of backupFiles) {
      expect(fileName).toMatch(/\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
      const fullPath = path.join(parentDir, fileName);
      const { stdout: pragmaCheck } = await execFileAsync("sqlite3", [
        fullPath,
        "PRAGMA integrity_check;"
      ]);
      expect(pragmaCheck.trim()).toBe("ok");
    }

    const listedBackups = await listDatabaseBackups(testDb.dbPath);
    expect(listedBackups).toHaveLength(5);

    // -------------------------------------------------------------------------
    // Шаг 8: Валидация вывода CLI с флагом --json
    // -------------------------------------------------------------------------
    // 8a: doctor --json
    const { stdout: doctorJsonStdout } = await execFileAsync(cliPath, [
      "doctor",
      "--db",
      testDb.dbPath,
      "--workspace",
      workspacePath,
      "--json"
    ]);
    const parsedDoctor = JSON.parse(doctorJsonStdout);
    expect(parsedDoctor.success).toBe(true);
    expect(parsedDoctor.ok).toBe(true);
    expect(parsedDoctor.nodeVersion).toBe(process.version);
    expect(parsedDoctor.platform).toBe(process.platform);
    expect(Array.isArray(parsedDoctor.checks)).toBe(true);
    expect(parsedDoctor.checks.length).toBeGreaterThanOrEqual(4);
    expect(parsedDoctor.summary.passed).toBeGreaterThanOrEqual(4);
    expect(parsedDoctor.summary.failed).toBe(0);

    // 8b: diff --json
    const { stdout: diffJsonStdout } = await execFileAsync(cliPath, [
      "diff",
      "--db",
      testDb.dbPath,
      "--plan",
      samplePlanPath,
      "--workspace",
      workspacePath,
      "--json"
    ]);
    const parsedDiff = JSON.parse(diffJsonStdout);
    expect(parsedDiff.success).toBe(true);
    expect(parsedDiff.planSlug).toBe("sample-plan");
    expect(Array.isArray(parsedDiff.diffs)).toBe(true);
    expect(parsedDiff.diffs).toHaveLength(4);

    const preservedDiff = parsedDiff.diffs.find((d: any) =>
      d.task.title.includes("Setup core types")
    );
    expect(preservedDiff).toBeDefined();
    expect(preservedDiff.action).toBe("preserve");
    expect(preservedDiff.currentStatus).toBe("running");
    expect(preservedDiff.targetStatus).toBe("running");

    // 8c: sync --json
    const { stdout: syncJsonStdout } = await execFileAsync(cliPath, [
      "sync",
      "--db",
      testDb.dbPath,
      "--plan",
      samplePlanPath,
      "--workspace",
      workspacePath,
      "--json"
    ]);
    const parsedSync = JSON.parse(syncJsonStdout);
    expect(parsedSync.success).toBe(true);
    expect(parsedSync.planSlug).toBe("sample-plan");
    expect(parsedSync.total).toBe(4);
    expect(parsedSync.created).toBe(0);
    expect(parsedSync.updated).toBe(0);
    expect(parsedSync.preserved).toBe(4);
    expect(parsedSync.dryRun).toBe(false);

    // 8d: status --json
    const { stdout: statusJsonStdout } = await execFileAsync(cliPath, [
      "status",
      "--db",
      testDb.dbPath,
      "--workspace",
      workspacePath,
      "--json"
    ]);
    const parsedStatus = JSON.parse(statusJsonStdout);
    expect(parsedStatus.success).toBe(true);
    expect(parsedStatus.workspacePath).toBe(workspacePath);
    expect(Array.isArray(parsedStatus.tasks)).toBe(true);
    expect(parsedStatus.tasks).toHaveLength(4);

    const runningStatusTask = parsedStatus.tasks.find((t: any) =>
      t.title.includes("Setup core types")
    );
    expect(runningStatusTask).toBeDefined();
    expect(runningStatusTask.status).toBe("running");
    expect(runningStatusTask.sourceKey).toMatch(/^sample-plan:/);

    // 8e: Global --json placed before command
    const { stdout: globalJsonStdout } = await execFileAsync(cliPath, [
      "--json",
      "status",
      "--db",
      testDb.dbPath,
      "--workspace",
      workspacePath
    ]);
    const parsedGlobalStatus = JSON.parse(globalJsonStdout);
    expect(parsedGlobalStatus.success).toBe(true);
    expect(parsedGlobalStatus.workspacePath).toBe(workspacePath);
    expect(parsedGlobalStatus.tasks).toHaveLength(4);
  });

  it("completes full lifecycle via OpenCode Bridge Plugin tool interfaces", async () => {
    const workspacePath = "/workspace/e2e-plugin-lifecycle-test";
    const hooks = await opencodeCodegBridgePlugin({} as any, {} as any);
    expect(hooks.tool).toBeDefined();

    const diffTool = hooks.tool?.codeg_diff_plan;
    const syncTool = hooks.tool?.codeg_sync_plan;
    const statusTool = hooks.tool?.codeg_status_plan;

    expect(diffTool).toBeDefined();
    expect(syncTool).toBeDefined();
    expect(statusTool).toBeDefined();

    // 1. Initial diff via plugin on empty DB -> non-mutating
    const diffResult1 = await (diffTool as any).execute(
      {
        dbPath: testDb.dbPath,
        planPath: samplePlanPath,
        workspacePath
      },
      { directory: workspacePath }
    );
    const parsedDiff1 = JSON.parse(diffResult1.output);
    expect(parsedDiff1.plan).toBe("sample-plan");
    expect(parsedDiff1.diffs).toHaveLength(4);
    expect(parsedDiff1.diffs.every((d: any) => d.action === "create")).toBe(true);

    const folderCountAfterDiff = await testDb.query<{ count: number }>(
      "SELECT count(*) as count FROM folder;"
    );
    expect(folderCountAfterDiff[0].count).toBe(0);

    // 2. Initial sync via plugin -> creates tasks and folder
    const syncResult1 = await (syncTool as any).execute(
      {
        dbPath: testDb.dbPath,
        planPath: samplePlanPath,
        workspacePath,
        dryRun: false
      },
      { directory: workspacePath }
    );
    const parsedSync1 = JSON.parse(syncResult1.output);
    expect(parsedSync1.success).toBe(true);
    expect(parsedSync1.created).toBe(4);

    const folderRows = await testDb.query<{ id: number }>(
      `SELECT id FROM folder WHERE path = '${workspacePath}';`
    );
    expect(folderRows).toHaveLength(1);

    // 3. User modifies task status in DB
    await testDb.exec(
      "UPDATE work_task SET status = 'in_progress' WHERE title LIKE '%Implement zero-native%';"
    );

    // 4. Plugin diff shows task status preserved
    const diffResult2 = await (diffTool as any).execute(
      {
        dbPath: testDb.dbPath,
        planPath: samplePlanPath,
        workspacePath
      },
      { directory: workspacePath }
    );
    const parsedDiff2 = JSON.parse(diffResult2.output);
    const inProgressDiff = parsedDiff2.diffs.find((d: any) =>
      d.task.title.includes("Implement zero-native")
    );
    expect(inProgressDiff).toBeDefined();
    expect(inProgressDiff.action).toBe("preserve");
    expect(inProgressDiff.targetStatus).toBe("in_progress");

    // 5. Plugin re-sync preserves status in DB
    const syncResult2 = await (syncTool as any).execute(
      {
        dbPath: testDb.dbPath,
        planPath: samplePlanPath,
        workspacePath
      },
      { directory: workspacePath }
    );
    const parsedSync2 = JSON.parse(syncResult2.output);
    expect(parsedSync2.preserved).toBe(4);

    const inProgressInDb = await testDb.query<{ status: string }>(
      "SELECT status FROM work_task WHERE title LIKE '%Implement zero-native%';"
    );
    expect(inProgressInDb[0].status).toBe("in_progress");

    // 6. Plugin status tool returns all tasks including in_progress task
    const statusResult = await (statusTool as any).execute(
      {
        dbPath: testDb.dbPath,
        workspacePath
      },
      { directory: workspacePath }
    );
    const parsedStatus = JSON.parse(statusResult.output);
    expect(parsedStatus.tasks).toHaveLength(4);
    const inProgressTask = parsedStatus.tasks.find((t: any) =>
      t.title.includes("Implement zero-native")
    );
    expect(inProgressTask.status).toBe("in_progress");
  });
});
