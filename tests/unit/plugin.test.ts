import { describe, it, expect, beforeEach, afterEach } from "vitest";
import opencodeCodegBridgePluginDefault, {
  opencodeCodegBridgePlugin as pluginFromIndex
} from "../../src/index.js";
import pluginFromFileDefault, {
  opencodeCodegBridgePlugin,
  formatErrorOutput
} from "../../src/plugin.js";
import { BridgeError } from "../../src/errors.js";
import { createTestDatabase, type TestDbInstance } from "../helpers/test-db.js";
import path from "node:path";

describe("OpenCode Plugin Interface & Tool Registration", () => {
  let dbInstance: TestDbInstance;
  let samplePlanPath: string;

  beforeEach(async () => {
    dbInstance = await createTestDatabase();
    samplePlanPath = path.resolve(__dirname, "../fixtures/sample-plan.md");
  });

  afterEach(async () => {
    await dbInstance.cleanup();
  });

  describe("Exports and Plugin Factory", () => {
    it("provides both default and named export from index.ts and plugin.ts", () => {
      expect(opencodeCodegBridgePluginDefault).toBeDefined();
      expect(typeof opencodeCodegBridgePluginDefault).toBe("function");
      expect(pluginFromIndex).toBe(opencodeCodegBridgePluginDefault);
      expect(pluginFromFileDefault).toBe(opencodeCodegBridgePluginDefault);
      expect(opencodeCodegBridgePlugin).toBe(opencodeCodegBridgePluginDefault);
    });
  });

  describe("Tool Registration & Schemas", () => {
    it("registers expected tools with proper schemas on plugin initialization", async () => {
      const hooks = await opencodeCodegBridgePlugin({} as any, {} as any);
      expect(hooks.tool).toBeDefined();

      // codeg_sync_plan
      const syncTool = hooks.tool?.codeg_sync_plan;
      expect(syncTool).toBeDefined();
      expect(syncTool?.description).toContain("Synchronize an Oh My OpenAgent");
      expect(syncTool?.args).toHaveProperty("planPath");
      expect(syncTool?.args).toHaveProperty("dbPath");
      expect(syncTool?.args).toHaveProperty("workspacePath");
      expect(syncTool?.args).toHaveProperty("dryRun");
      expect(syncTool?.args).toHaveProperty("force");

      // codeg_diff_plan
      const diffTool = hooks.tool?.codeg_diff_plan;
      expect(diffTool).toBeDefined();
      expect(diffTool?.description).toContain("diff");
      expect(diffTool?.args).toHaveProperty("planPath");
      expect(diffTool?.args).toHaveProperty("dbPath");
      expect(diffTool?.args).toHaveProperty("workspacePath");

      // codeg_status_plan
      const statusTool = hooks.tool?.codeg_status_plan;
      expect(statusTool).toBeDefined();
      expect(statusTool?.description).toContain("tasks in Codeg SQLite database");
      expect(statusTool?.args).toHaveProperty("dbPath");
      expect(statusTool?.args).toHaveProperty("workspacePath");
    });

    it("registers /codeg-sync slash command via config and command hooks", async () => {
      const hooks = await opencodeCodegBridgePlugin({} as any, {} as any);

      // Verify command property on hooks
      expect((hooks as any).command).toBeDefined();
      expect((hooks as any).command["codeg-sync"]).toBeDefined();
      expect((hooks as any).command["codeg-sync"].description).toBeDefined();
      expect((hooks as any).command["codeg-sync"].template).toContain("codeg_sync_plan");

      // Verify config hook populates command in config
      expect(hooks.config).toBeDefined();
      const mockConfig: any = {};
      await hooks.config!(mockConfig);
      expect(mockConfig.command).toBeDefined();
      expect(mockConfig.command["codeg-sync"]).toBeDefined();
      expect(mockConfig.command["codeg-sync"].description).toBeDefined();
      expect(mockConfig.command["codeg-sync"].template).toContain("codeg_sync_plan");

      // Verify command.execute.before hook
      expect(hooks["command.execute.before"]).toBeDefined();
    });
  });

  describe("Tool Execution", () => {
    it("executes codeg_sync_plan tool with custom arguments", async () => {
      const hooks = await opencodeCodegBridgePlugin({} as any, {} as any);
      const syncTool = hooks.tool?.codeg_sync_plan;

      const result = await (syncTool as any).execute(
        {
          planPath: samplePlanPath,
          dbPath: dbInstance.dbPath,
          workspacePath: "/workspace/plugin-test",
          dryRun: false
        },
        {
          directory: "/workspace/plugin-test",
          worktree: "/workspace/plugin-test"
        }
      );

      expect(result.title).toBe("Codeg Plan Sync");
      const parsed = JSON.parse(result.output);
      expect(parsed.success).toBe(true);
      expect(parsed.created).toBe(4);
    });

    it("executes codeg_status_plan tool", async () => {
      const hooks = await opencodeCodegBridgePlugin({} as any, {} as any);
      const statusTool = hooks.tool?.codeg_status_plan;

      const result = await (statusTool as any).execute(
        {
          dbPath: dbInstance.dbPath,
          workspacePath: "/workspace/plugin-test"
        },
        {
          directory: "/workspace/plugin-test"
        }
      );

      expect(result.title).toBe("Codeg Task Status");
      const parsed = JSON.parse(result.output);
      expect(parsed.workspace).toBe("/workspace/plugin-test");
      expect(Array.isArray(parsed.tasks)).toBe(true);
    });

    it("executes codeg_diff_plan and codeg_status_plan without mutating database", async () => {
      const hooks = await opencodeCodegBridgePlugin({} as any, {} as any);
      const diffTool = hooks.tool?.codeg_diff_plan;
      const statusTool = hooks.tool?.codeg_status_plan;

      const diffResult = await (diffTool as any).execute(
        {
          planPath: samplePlanPath,
          dbPath: dbInstance.dbPath,
          workspacePath: "/workspace/plugin-inspect-test"
        },
        {
          directory: "/workspace/plugin-inspect-test"
        }
      );

      const diffParsed = JSON.parse(diffResult.output);
      expect(diffParsed.diffs).toHaveLength(4);
      expect(diffParsed.diffs.every((d: any) => d.action === "create")).toBe(true);

      const statusResult = await (statusTool as any).execute(
        {
          dbPath: dbInstance.dbPath,
          workspacePath: "/workspace/plugin-inspect-test"
        },
        {
          directory: "/workspace/plugin-inspect-test"
        }
      );

      const statusParsed = JSON.parse(statusResult.output);
      expect(statusParsed.folderId).toBeNull();
      expect(statusParsed.tasks).toEqual([]);

      const folderCount = await dbInstance.query<{ count: number }>(
        "SELECT count(*) as count FROM folder;"
      );
      expect(folderCount[0].count).toBe(0);
    });
  });

  describe("Safe Error Handling & BridgeError Serialization", () => {
    it("handles missing plan file gracefully in codeg_sync_plan without throwing", async () => {
      const hooks = await opencodeCodegBridgePlugin({} as any, {} as any);
      const syncTool = hooks.tool?.codeg_sync_plan;

      const result = await (syncTool as any).execute(
        {
          planPath: "/nonexistent/plan-file.md",
          dbPath: dbInstance.dbPath,
          workspacePath: "/workspace/plugin-test"
        },
        {
          directory: "/workspace/plugin-test"
        }
      );

      expect(result.title).toBe("Codeg Plan Sync");
      const parsed = JSON.parse(result.output);
      expect(parsed.status).toBe("error");
      expect(parsed.error).toContain("Explicit plan file not found");
      expect(parsed.code).toBe("ERR_PLAN_NOT_FOUND");
      expect(parsed.remediation).toBeDefined();
    });

    it("handles missing database file gracefully in codeg_status_plan without throwing", async () => {
      const hooks = await opencodeCodegBridgePlugin({} as any, {} as any);
      const statusTool = hooks.tool?.codeg_status_plan;

      const result = await (statusTool as any).execute(
        {
          dbPath: "/nonexistent/path/codeg.db",
          workspacePath: "/workspace/plugin-test"
        },
        {
          directory: "/workspace/plugin-test"
        }
      );

      expect(result.title).toBe("Codeg Task Status");
      const parsed = JSON.parse(result.output);
      expect(parsed.status).toBe("error");
      expect(parsed.error).toContain("Explicit Codeg database not found");
      expect(parsed.code).toBe("ERR_DATABASE_NOT_FOUND");
      expect(parsed.remediation).toBeDefined();
    });

    it("handles missing plan gracefully in codeg_diff_plan without throwing", async () => {
      const hooks = await opencodeCodegBridgePlugin({} as any, {} as any);
      const diffTool = hooks.tool?.codeg_diff_plan;

      const result = await (diffTool as any).execute(
        {
          planPath: "/nonexistent/diff-plan.md",
          dbPath: dbInstance.dbPath,
          workspacePath: "/workspace/plugin-test"
        },
        {
          directory: "/workspace/plugin-test"
        }
      );

      expect(result.title).toBe("Codeg Plan Diff");
      const parsed = JSON.parse(result.output);
      expect(parsed.status).toBe("error");
      expect(parsed.error).toContain("Explicit plan file not found");
      expect(parsed.code).toBe("ERR_PLAN_NOT_FOUND");
      expect(parsed.remediation).toBeDefined();
    });

    it("formats arbitrary BridgeError instances into structured error JSON", () => {
      const customError = new BridgeError("Custom bridge failure occurred", {
        code: "ERR_CUSTOM_TEST",
        remediation: "Verify custom test invariants."
      });

      const formatted = formatErrorOutput("Custom Error Test", customError);
      expect(formatted.title).toBe("Custom Error Test");
      const parsed = JSON.parse(formatted.output);
      expect(parsed).toEqual({
        status: "error",
        error: "Custom bridge failure occurred",
        code: "ERR_CUSTOM_TEST",
        remediation: "Verify custom test invariants."
      });
    });
  });
});
