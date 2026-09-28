import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { opencodeCodegBridgePlugin } from "../../src/plugin.js";
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

  it("registers expected tools on plugin initialization", async () => {
    const hooks = await opencodeCodegBridgePlugin({} as any, {} as any);
    expect(hooks.tool).toBeDefined();
    expect(hooks.tool?.codeg_sync_plan).toBeDefined();
    expect(hooks.tool?.codeg_diff_plan).toBeDefined();
    expect(hooks.tool?.codeg_status_plan).toBeDefined();
  });

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
