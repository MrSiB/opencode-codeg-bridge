import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  findCodegDatabase,
  findPlanFile,
  resolveWorkspaceFolder,
  discoverEnvironment
} from "../../src/discovery.js";

describe("Environment Discovery Engine", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omo-discovery-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("resolveWorkspaceFolder", () => {
    it("resolves explicit workspace directory when provided", async () => {
      const explicitDir = path.join(tempDir, "custom-workspace");
      await fs.mkdir(explicitDir, { recursive: true });

      const resolved = await resolveWorkspaceFolder(explicitDir, tempDir);
      expect(resolved).toBe(path.resolve(explicitDir));
    });

    it("resolves from CODEG_WORKSPACE environment variable", async () => {
      const envDir = path.join(tempDir, "env-workspace");
      await fs.mkdir(envDir, { recursive: true });

      const oldEnv = process.env.CODEG_WORKSPACE;
      try {
        process.env.CODEG_WORKSPACE = envDir;
        const resolved = await resolveWorkspaceFolder(undefined, tempDir);
        expect(resolved).toBe(path.resolve(envDir));
      } finally {
        process.env.CODEG_WORKSPACE = oldEnv;
      }
    });

    it("falls back to cwd if not a git repository", async () => {
      const subDir = path.join(tempDir, "sub");
      await fs.mkdir(subDir, { recursive: true });

      const resolved = await resolveWorkspaceFolder(undefined, subDir);
      expect(resolved).toBe(path.resolve(subDir));
    });
  });

  describe("findCodegDatabase", () => {
    it("returns explicit database path if file exists", async () => {
      const dbFile = path.join(tempDir, "custom.db");
      await fs.writeFile(dbFile, "");

      const resolved = await findCodegDatabase(dbFile, tempDir);
      expect(resolved).toBe(path.resolve(dbFile));
    });

    it("throws if explicit database path does not exist", async () => {
      const missing = path.join(tempDir, "nonexistent.db");
      await expect(findCodegDatabase(missing, tempDir)).rejects.toThrow("Explicit Codeg database not found");
    });

    it("finds database via CODEG_DB_PATH environment variable", async () => {
      const envDb = path.join(tempDir, "env.db");
      await fs.writeFile(envDb, "");

      const oldEnv = process.env.CODEG_DB_PATH;
      try {
        process.env.CODEG_DB_PATH = envDb;
        const resolved = await findCodegDatabase(undefined, tempDir);
        expect(resolved).toBe(path.resolve(envDb));
      } finally {
        process.env.CODEG_DB_PATH = oldEnv;
      }
    });

    it("locates codeg.db in cwd if present", async () => {
      const cwdDb = path.join(tempDir, "codeg.db");
      await fs.writeFile(cwdDb, "");

      const oldEnv = process.env.CODEG_DB_PATH;
      try {
        delete process.env.CODEG_DB_PATH;
        const resolved = await findCodegDatabase(undefined, tempDir);
        expect(resolved).toBe(path.resolve(cwdDb));
      } finally {
        process.env.CODEG_DB_PATH = oldEnv;
      }
    });
  });

  describe("findPlanFile", () => {
    it("returns explicit plan file path if present", async () => {
      const planFile = path.join(tempDir, "my-plan.md");
      await fs.writeFile(planFile, "# Plan");

      const resolved = await findPlanFile(planFile, tempDir);
      expect(resolved).toBe(path.resolve(planFile));
    });

    it("throws if explicit plan path does not exist", async () => {
      const missing = path.join(tempDir, "missing.md");
      await expect(findPlanFile(missing, tempDir)).rejects.toThrow("Explicit plan file not found");
    });

    it("reads active_plan from .omo/boulder.json when present", async () => {
      const omoDir = path.join(tempDir, ".omo");
      await fs.mkdir(omoDir, { recursive: true });

      const targetPlan = path.join(tempDir, "active-plan.md");
      await fs.writeFile(targetPlan, "# Active Plan");

      await fs.writeFile(
        path.join(omoDir, "boulder.json"),
        JSON.stringify({ active_plan: targetPlan })
      );

      const resolved = await findPlanFile(undefined, tempDir);
      expect(resolved).toBe(targetPlan);
    });

    it("discovers latest modified plan from .omo/plans/", async () => {
      const plansDir = path.join(tempDir, ".omo/plans");
      await fs.mkdir(plansDir, { recursive: true });

      const plan1 = path.join(plansDir, "plan1.md");
      const plan2 = path.join(plansDir, "plan2.md");

      await fs.writeFile(plan1, "# Plan 1");
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(plan2, "# Plan 2");

      const resolved = await findPlanFile(undefined, tempDir);
      expect(resolved).toBe(plan2);
    });
  });

  describe("discoverEnvironment", () => {
    it("aggregates workspace, db, and plan discoveries", async () => {
      const dbFile = path.join(tempDir, "codeg.db");
      await fs.writeFile(dbFile, "");

      const planFile = path.join(tempDir, "test.md");
      await fs.writeFile(planFile, "# Content");

      const env = await discoverEnvironment({
        explicitDbPath: dbFile,
        explicitPlanPath: planFile,
        explicitWorkspace: tempDir,
        cwd: tempDir
      });

      expect(env.workspacePath).toBe(path.resolve(tempDir));
      expect(env.dbPath).toBe(path.resolve(dbFile));
      expect(env.planPath).toBe(path.resolve(planFile));
    });
  });
});
