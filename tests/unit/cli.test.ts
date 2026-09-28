import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createTestDatabase, type TestDbInstance } from "../helpers/test-db.js";
import { runDoctorChecks } from "../../src/cli.js";

const execFileAsync = promisify(execFile);

function stripAnsi(str: string): string {
  return str.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("omo-codeg CLI Binary & Options", () => {
  const cliPath = path.resolve(__dirname, "../../bin/omo-codeg");
  const samplePlanPath = path.resolve(__dirname, "../fixtures/sample-plan.md");
  let testDb: TestDbInstance;

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it("prints general help information via --help and -h", async () => {
    const { stdout: helpLong } = await execFileAsync(cliPath, ["--help"]);
    expect(helpLong).toContain("Oh My OpenAgent to Codeg Bridge CLI");
    expect(helpLong).toContain("sync");
    expect(helpLong).toContain("diff");
    expect(helpLong).toContain("status");
    expect(helpLong).toContain("doctor");
    expect(helpLong).toContain("--json");

    const { stdout: helpShort } = await execFileAsync(cliPath, ["-h"]);
    expect(helpShort).toEqual(helpLong);
  });

  it("prints version information via --version and -V", async () => {
    const { stdout: verLong } = await execFileAsync(cliPath, ["--version"]);
    expect(verLong.trim()).toBe("0.1.0");

    const { stdout: verShort } = await execFileAsync(cliPath, ["-V"]);
    expect(verShort.trim()).toBe("0.1.0");
  });

  it("parses flags correctly for sync --help", async () => {
    const { stdout } = await execFileAsync(cliPath, ["sync", "--help"]);
    expect(stdout).toContain("-p, --plan <path>");
    expect(stdout).toContain("-d, --db <path>");
    expect(stdout).toContain("-w, --workspace <path>");
    expect(stdout).toContain("--dry-run");
    expect(stdout).toContain("-f, --force");
    expect(stdout).toContain("--json");
  });

  it("parses flags correctly for diff --help", async () => {
    const { stdout } = await execFileAsync(cliPath, ["diff", "--help"]);
    expect(stdout).toContain("-p, --plan <path>");
    expect(stdout).toContain("-d, --db <path>");
    expect(stdout).toContain("-w, --workspace <path>");
    expect(stdout).toContain("-f, --force");
    expect(stdout).toContain("--json");
  });

  it("parses flags correctly for status --help and doctor --help", async () => {
    const { stdout: statusHelp } = await execFileAsync(cliPath, ["status", "--help"]);
    expect(statusHelp).toContain("-d, --db <path>");
    expect(statusHelp).toContain("-w, --workspace <path>");
    expect(statusHelp).toContain("--json");

    const { stdout: doctorHelp } = await execFileAsync(cliPath, ["doctor", "--help"]);
    expect(doctorHelp).toContain("-d, --db <path>");
    expect(doctorHelp).toContain("-w, --workspace <path>");
    expect(doctorHelp).toContain("--json");
  });

  it("executes doctor command successfully in human-readable mode", async () => {
    const { stdout } = await execFileAsync(cliPath, ["doctor", "--db", testDb.dbPath]);
    const cleanStdout = stripAnsi(stdout);
    expect(cleanStdout).toContain("=== omo-codeg doctor ===");
    expect(cleanStdout).toContain("[PASS] node_version");
    expect(cleanStdout).toContain("[PASS] sqlite3_cli");
    expect(cleanStdout).toContain("[PASS] database_accessibility");
    expect(cleanStdout).toContain("[PASS] wal_shm_permissions");
    expect(cleanStdout).toContain("Zero native dependencies check: PASSED");
    expect(cleanStdout).toContain("All health checks passed successfully!");
  });

  it("outputs valid JSON for doctor --json", async () => {
    const { stdout } = await execFileAsync(cliPath, ["doctor", "--db", testDb.dbPath, "--json"]);
    const parsed = JSON.parse(stdout);

    expect(parsed.success).toBe(true);
    expect(parsed.ok).toBe(true);
    expect(parsed.nodeVersion).toBe(process.version);
    expect(parsed.platform).toBe(process.platform);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThanOrEqual(4);

    const checkNames = parsed.checks.map((c: { name: string }) => c.name);
    expect(checkNames).toContain("node_version");
    expect(checkNames).toContain("sqlite3_cli");
    expect(checkNames).toContain("database_accessibility");
    expect(checkNames).toContain("wal_shm_permissions");

    expect(parsed.summary.passed).toBeGreaterThanOrEqual(4);
    expect(parsed.summary.failed).toBe(0);
  });

  it("outputs valid JSON for diff --json and preserves read-only invariant", async () => {
    const workspacePath = "/workspace/cli-diff-json-test";
    const { stdout } = await execFileAsync(cliPath, [
      "diff",
      "--db",
      testDb.dbPath,
      "--plan",
      samplePlanPath,
      "--workspace",
      workspacePath,
      "--json"
    ]);

    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.planSlug).toBe("sample-plan");
    expect(Array.isArray(parsed.diffs)).toBe(true);
    expect(parsed.diffs.length).toBe(4);
    expect(parsed.diffs[0].action).toBe("create");

    const folderCount = await testDb.query<{ count: number }>("SELECT count(*) as count FROM folder;");
    expect(folderCount[0].count).toBe(0);
  });

  it("outputs valid JSON for status --json and preserves read-only invariant", async () => {
    const workspacePath = "/workspace/cli-status-json-test";
    const { stdout } = await execFileAsync(cliPath, [
      "status",
      "--db",
      testDb.dbPath,
      "--workspace",
      workspacePath,
      "--json"
    ]);

    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.workspacePath).toBe(workspacePath);
    expect(parsed.tasks).toEqual([]);

    const folderCount = await testDb.query<{ count: number }>("SELECT count(*) as count FROM folder;");
    expect(folderCount[0].count).toBe(0);
  });

  it("outputs valid JSON for sync --json with dry-run and actual sync", async () => {
    const workspacePath = "/workspace/cli-sync-json-test";
    const { stdout: dryStdout } = await execFileAsync(cliPath, [
      "sync",
      "--db",
      testDb.dbPath,
      "--plan",
      samplePlanPath,
      "--workspace",
      workspacePath,
      "--dry-run",
      "--json"
    ]);

    const dryParsed = JSON.parse(dryStdout);
    expect(dryParsed.success).toBe(true);
    expect(dryParsed.dryRun).toBe(true);
    expect(dryParsed.created).toBe(4);

    const folderBeforeSync = await testDb.query<{ count: number }>("SELECT count(*) as count FROM folder;");
    expect(folderBeforeSync[0].count).toBe(0);

    const { stdout: syncStdout } = await execFileAsync(cliPath, [
      "sync",
      "--db",
      testDb.dbPath,
      "--plan",
      samplePlanPath,
      "--workspace",
      workspacePath,
      "--json"
    ]);

    const syncParsed = JSON.parse(syncStdout);
    expect(syncParsed.success).toBe(true);
    expect(syncParsed.dryRun).toBe(false);
    expect(syncParsed.total).toBe(4);
    expect(syncParsed.created).toBe(4);

    const folderAfterSync = await testDb.query<{ count: number }>("SELECT count(*) as count FROM folder;");
    expect(folderAfterSync[0].count).toBe(1);

    const tasksAfterSync = await testDb.query<{ count: number }>("SELECT count(*) as count FROM work_task;");
    expect(tasksAfterSync[0].count).toBe(4);
  });

  it("supports global --json placed before command", async () => {
    const workspacePath = "/workspace/cli-global-json-test";
    const { stdout } = await execFileAsync(cliPath, [
      "--json",
      "status",
      "--db",
      testDb.dbPath,
      "--workspace",
      workspacePath
    ]);

    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.workspacePath).toBe(workspacePath);
    expect(Array.isArray(parsed.tasks)).toBe(true);
  });

  it("formats error as valid JSON when plan is missing with --json", async () => {
    try {
      await execFileAsync(cliPath, [
        "sync",
        "--db",
        testDb.dbPath,
        "--plan",
        "/non/existent/plan.md",
        "--workspace",
        "/workspace/test",
        "--json"
      ]);
      expect.fail("Should have failed with missing plan");
    } catch (err: any) {
      expect(err.code).toBe(1);
      const parsed = JSON.parse(err.stdout || err.message);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBeDefined();
      expect(parsed.error.code).toBe("ERR_PLAN_NOT_FOUND");
      expect(parsed.error.remediation).toBeDefined();
    }
  });

  it("supports --force flag during sync to reset preserved statuses", async () => {
    const workspacePath = "/workspace/cli-force-sync-test";

    await execFileAsync(cliPath, [
      "sync",
      "--db",
      testDb.dbPath,
      "--plan",
      samplePlanPath,
      "--workspace",
      workspacePath
    ]);

    await testDb.exec(
      "UPDATE work_task SET status = 'running' WHERE title LIKE '%Setup core types%';"
    );

    const beforeNormal = await testDb.query<{ status: string }>(
      "SELECT status FROM work_task WHERE title LIKE '%Setup core types%';"
    );
    expect(beforeNormal[0].status).toBe("running");

    await execFileAsync(cliPath, [
      "sync",
      "--db",
      testDb.dbPath,
      "--plan",
      samplePlanPath,
      "--workspace",
      workspacePath
    ]);

    const afterNormal = await testDb.query<{ status: string }>(
      "SELECT status FROM work_task WHERE title LIKE '%Setup core types%';"
    );
    expect(afterNormal[0].status).toBe("running");

    await execFileAsync(cliPath, [
      "sync",
      "--db",
      testDb.dbPath,
      "--plan",
      samplePlanPath,
      "--workspace",
      workspacePath,
      "--force"
    ]);

    const afterForce = await testDb.query<{ status: string }>(
      "SELECT status FROM work_task WHERE title LIKE '%Setup core types%';"
    );
    expect(afterForce[0].status).toBe("todo");
  });

  it("exits with code 1 and remediation when doctor encounters missing database", async () => {
    try {
      await execFileAsync(cliPath, ["doctor", "--db", "/non/existent/missing-codeg.db"]);
      expect.fail("Should have exited with code 1");
    } catch (err: any) {
      expect(err.code).toBe(1);
      const cleanStdout = stripAnsi(err.stdout || "");
      expect(cleanStdout).toContain("[FAIL] database_accessibility");
      expect(cleanStdout).toContain("Remediation:");
      expect(cleanStdout).toContain("Summary: 2 passed, 0 warnings, 2 failed");
    }
  });

  it("exits with code 1 and returns parseable JSON when doctor fails with --json", async () => {
    try {
      await execFileAsync(cliPath, [
        "doctor",
        "--db",
        "/non/existent/missing-codeg.db",
        "--json"
      ]);
      expect.fail("Should have exited with code 1");
    } catch (err: any) {
      expect(err.code).toBe(1);
      const parsed = JSON.parse(err.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.success).toBe(false);
      expect(parsed.summary.failed).toBeGreaterThan(0);
      const dbCheck = parsed.checks.find((c: any) => c.name === "database_accessibility");
      expect(dbCheck).toBeDefined();
      expect(dbCheck.status).toBe("fail");
      expect(dbCheck.remediation).toContain("Ensure Codeg database file exists");
    }
  });

  it("exits with code 1 when database is corrupted or invalid for WAL/SHM creation", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omo-corrupt-db-test-"));
    const corruptDbPath = path.join(tempDir, "corrupt.db");
    await fs.writeFile(corruptDbPath, "corrupted database content");

    try {
      await execFileAsync(cliPath, ["doctor", "--db", corruptDbPath]);
      expect.fail("Should fail on corrupted database for WAL creation");
    } catch (err: any) {
      expect(err.code).toBe(1);
      const cleanStdout = stripAnsi(err.stdout || "");
      expect(cleanStdout).toContain("[FAIL] wal_shm_permissions");
      expect(cleanStdout).toContain("Remediation: Grant write permissions");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("exits with code 1 and outputs exact installation commands when sqlite3 is missing from PATH", async () => {
    const tempBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "omo-node-bin-"));
    const nodePath = process.execPath;
    await fs.symlink(nodePath, path.join(tempBinDir, "node"));

    try {
      await execFileAsync(cliPath, ["doctor", "--db", testDb.dbPath, "--json"], {
        env: {
          ...process.env,
          PATH: tempBinDir
        }
      });
      expect.fail("Should have failed without sqlite3");
    } catch (err: any) {
      expect(err.code).toBe(1);
      const parsed = JSON.parse(err.stdout);
      expect(parsed.ok).toBe(false);
      const sqliteCheck = parsed.checks.find((c: any) => c.name === "sqlite3_cli");
      expect(sqliteCheck).toBeDefined();
      expect(sqliteCheck.status).toBe("fail");
      expect(sqliteCheck.remediation).toContain("apt install sqlite3");
      expect(sqliteCheck.remediation).toContain("apk add sqlite3");
      expect(sqliteCheck.remediation).toContain("brew install sqlite");
    } finally {
      await fs.rm(tempBinDir, { recursive: true, force: true });
    }
  });

  it("verifies runDoctorChecks function directly in-process", async () => {
    const validReport = await runDoctorChecks({ db: testDb.dbPath });
    expect(validReport.ok).toBe(true);
    expect(validReport.summary.passed).toBeGreaterThanOrEqual(4);
    expect(validReport.summary.failed).toBe(0);

    const invalidReport = await runDoctorChecks({ db: "/invalid/path.db" });
    expect(invalidReport.ok).toBe(false);
    expect(invalidReport.summary.failed).toBeGreaterThan(0);
    const dbCheck = invalidReport.checks.find((c) => c.name === "database_accessibility");
    expect(dbCheck?.status).toBe("fail");
    expect(dbCheck?.remediation).toBeDefined();
  });
});
