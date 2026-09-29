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

  describe("SubagentTracker Hook Integration", () => {
    let savedDbEnv: string | undefined;

    beforeEach(async () => {
      savedDbEnv = process.env.CODEG_DB_PATH;
      process.env.CODEG_DB_PATH = dbInstance.dbPath;

      await dbInstance.exec(`
        INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at)
        VALUES (1, 'test-plugin-project', '/workspace/plugin-subagent', datetime('now'), datetime('now'), datetime('now'));

        INSERT INTO conversation (id, folder_id, title, agent_type, status, external_id, created_at, updated_at, kind)
        VALUES (10, 1, 'Parent Session', 'sisyphus', 'in_progress', 'ses_parent_001', datetime('now'), datetime('now'), 'regular');
      `);
    });

    afterEach(() => {
      if (savedDbEnv !== undefined) {
        process.env.CODEG_DB_PATH = savedDbEnv;
      } else {
        delete process.env.CODEG_DB_PATH;
      }
    });

    it("registers hook handlers on plugin initialization", async () => {
      const hooks = await opencodeCodegBridgePlugin(
        {
          directory: "/workspace/plugin-subagent",
          worktree: "/workspace/plugin-subagent"
        } as any,
        {} as any
      );

      expect(hooks["tool.execute.before"]).toBeDefined();
      expect(typeof hooks["tool.execute.before"]).toBe("function");
      expect(hooks["tool.execute.after"]).toBeDefined();
      expect(typeof hooks["tool.execute.after"]).toBe("function");
      expect(hooks.event).toBeDefined();
      expect(typeof hooks.event).toBe("function");
    });

    it("dispatches tool.execute.before for task and delegate_to_agent, and ignores other tools", async () => {
      const hooks = await opencodeCodegBridgePlugin(
        {
          directory: "/workspace/plugin-subagent",
          worktree: "/workspace/plugin-subagent"
        } as any,
        {} as any
      );

      await hooks["tool.execute.before"]!(
        {
          tool: "bash",
          sessionID: "ses_parent_001",
          callID: "call_bash_ignore"
        },
        { args: { command: "ls" } }
      );

      let rows = await dbInstance.query<any>(
        "SELECT * FROM conversation WHERE parent_tool_use_id = 'call_bash_ignore';"
      );
      expect(rows).toHaveLength(0);

      await hooks["tool.execute.before"]!(
        {
          tool: "task",
          sessionID: "ses_parent_001",
          callID: "call_task_001"
        },
        { args: { description: "Explore code", subagent_type: "explore" } }
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      rows = await dbInstance.query<any>(
        "SELECT * FROM conversation WHERE parent_tool_use_id = 'call_task_001';"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Explore code");
      expect(rows[0].agent_type).toBe("explore");
      expect(rows[0].kind).toBe("delegate");
      expect(rows[0].parent_id).toBe(10);

      await hooks["tool.execute.before"]!(
        {
          tool: "delegate_to_agent",
          sessionID: "ses_parent_001",
          callID: "call_delegate_001"
        },
        { args: { task: "Run test suite", agent_type: "open_code" } }
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      rows = await dbInstance.query<any>(
        "SELECT * FROM conversation WHERE parent_tool_use_id = 'call_delegate_001';"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Run test suite");
      expect(rows[0].agent_type).toBe("open_code");
    });

    it("dispatches event hook to handleSessionCreated for session.created event", async () => {
      const hooks = await opencodeCodegBridgePlugin(
        {
          directory: "/workspace/plugin-subagent",
          worktree: "/workspace/plugin-subagent"
        } as any,
        {} as any
      );

      await hooks["tool.execute.before"]!(
        {
          tool: "task",
          sessionID: "ses_parent_001",
          callID: "call_task_link"
        },
        { args: { description: "Task to link" } }
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      await hooks.event!({
        event: {
          type: "session.created",
          properties: {
            info: {
              id: "ses_child_linked",
              parentID: "ses_parent_001",
              title: "Task to link"
            }
          }
        } as any
      });

      const rows = await dbInstance.query<any>(
        "SELECT * FROM conversation WHERE parent_tool_use_id = 'call_task_link';"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].external_id).toBe("ses_child_linked");
    });

    it("dispatches tool.execute.after for task and delegate_to_agent, and ignores other tools", async () => {
      const hooks = await opencodeCodegBridgePlugin(
        {
          directory: "/workspace/plugin-subagent",
          worktree: "/workspace/plugin-subagent"
        } as any,
        {} as any
      );

      await hooks["tool.execute.before"]!(
        {
          tool: "task",
          sessionID: "ses_parent_001",
          callID: "call_task_complete"
        },
        { args: { description: "Task completing" } }
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      await hooks["tool.execute.after"]!(
        {
          tool: "bash",
          sessionID: "ses_parent_001",
          callID: "call_bash_ignore",
          args: {}
        },
        { title: "Bash", output: "success", metadata: {} }
      );

      await hooks["tool.execute.after"]!(
        {
          tool: "task",
          sessionID: "ses_parent_001",
          callID: "call_task_complete",
          args: {}
        },
        { title: "Task", output: "All done", metadata: {} }
      );

      const rows = await dbInstance.query<any>(
        "SELECT * FROM conversation WHERE parent_tool_use_id = 'call_task_complete';"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("completed");
    });

    it("runs startup background reconciliation and marks stale sessions as failed", async () => {
      await dbInstance.exec(`
        INSERT INTO conversation (id, folder_id, title, agent_type, status, external_id, created_at, updated_at, kind)
        VALUES (99, 1, 'Stale Subagent', 'explore', 'in_progress', 'ses_stale_99', datetime('now', '-45 minutes'), datetime('now', '-45 minutes'), 'delegate');
      `);

      await opencodeCodegBridgePlugin(
        {
          directory: "/workspace/plugin-subagent",
          worktree: "/workspace/plugin-subagent"
        } as any,
        {} as any
      );

      await new Promise((resolve) => setTimeout(resolve, 150));

      const rows = await dbInstance.query<any>("SELECT status FROM conversation WHERE id = 99;");
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("failed");
    });

    it("ensures hooks never throw exceptions even when errors occur", async () => {
      delete process.env.CODEG_DB_PATH;

      const hooks = await opencodeCodegBridgePlugin(
        {
          directory: "/nonexistent/dir",
          worktree: "/nonexistent/dir"
        } as any,
        {} as any
      );

      await expect(
        hooks["tool.execute.before"]!(
          {
            tool: "task",
            sessionID: "ses_error",
            callID: "call_error"
          },
          { args: null }
        )
      ).resolves.toBeUndefined();

      await expect(
        hooks["tool.execute.after"]!(
          {
            tool: "task",
            sessionID: "ses_error",
            callID: "call_error",
            args: null
          },
          { title: "", output: "", metadata: null }
        )
      ).resolves.toBeUndefined();

      await expect(
        hooks.event!({
          event: {
            type: "session.created",
            properties: null
          } as any
        })
      ).resolves.toBeUndefined();
    });
  });
});
