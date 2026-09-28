import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createTestDatabase } from "../helpers/test-db.js";

const execFileAsync = promisify(execFile);

describe("omo-codeg CLI Binary", () => {
  const cliPath = path.resolve(__dirname, "../../bin/omo-codeg");
  const samplePlanPath = path.resolve(__dirname, "../fixtures/sample-plan.md");

  it("prints help information via --help", async () => {
    const { stdout } = await execFileAsync(cliPath, ["--help"]);
    expect(stdout).toContain("Oh My OpenAgent to Codeg Bridge CLI");
    expect(stdout).toContain("sync");
    expect(stdout).toContain("diff");
    expect(stdout).toContain("status");
    expect(stdout).toContain("doctor");
  });

  it("runs doctor command successfully", async () => {
    const { stdout } = await execFileAsync(cliPath, ["doctor"]);
    expect(stdout).toContain("=== omo-codeg doctor ===");
    expect(stdout).toContain("Zero native dependencies check: PASSED");
  });

  it("runs diff and status commands without mutating folder or work_task table", async () => {
    const testDb = await createTestDatabase();
    try {
      const workspacePath = "/workspace/cli-inspection-test";

      const diffResult = await execFileAsync(cliPath, [
        "diff",
        "--db",
        testDb.dbPath,
        "--plan",
        samplePlanPath,
        "--workspace",
        workspacePath
      ]);
      expect(diffResult.stdout).toContain("CREATE");

      const statusResult = await execFileAsync(cliPath, [
        "status",
        "--db",
        testDb.dbPath,
        "--workspace",
        workspacePath
      ]);
      expect(statusResult.stdout).toContain("Codeg Tasks (0)");

      const folderCount = await testDb.query<{ count: number }>(
        "SELECT count(*) as count FROM folder;"
      );
      expect(folderCount[0].count).toBe(0);

      const taskCount = await testDb.query<{ count: number }>(
        "SELECT count(*) as count FROM work_task;"
      );
      expect(taskCount[0].count).toBe(0);
    } finally {
      await testDb.cleanup();
    }
  });
});
