import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDatabase, type TestDbInstance } from "../helpers/test-db.js";
import opencodeCodegBridgePlugin from "../../src/plugin.js";

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("End-to-End (E2E) Subagent Tracking Bridge", () => {
  let testDb: TestDbInstance;
  let savedDbEnv: string | undefined;
  const workspacePath = "/workspace/subagent-tracking-e2e";

  beforeEach(async () => {
    testDb = await createTestDatabase();
    savedDbEnv = process.env.CODEG_DB_PATH;
    process.env.CODEG_DB_PATH = testDb.dbPath;

    // Insert root project folder (id = 1) and root parent conversation (id = 10, external_id = "ses_main_123")
    await testDb.exec(`
      INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at)
      VALUES (1, 'root-project', '${workspacePath}', datetime('now'), datetime('now'), datetime('now'));

      INSERT INTO conversation (id, folder_id, title, agent_type, status, external_id, created_at, updated_at, kind)
      VALUES (10, 1, 'Main Parent Session', 'open_code', 'in_progress', 'ses_main_123', datetime('now'), datetime('now'), 'regular');
    `);
  });

  afterEach(async () => {
    if (savedDbEnv !== undefined) {
      process.env.CODEG_DB_PATH = savedDbEnv;
    } else {
      delete process.env.CODEG_DB_PATH;
    }
    await testDb.cleanup();
  });

  it("handles complete successful subagent tracking lifecycle: before -> session.created -> after (completed)", async () => {
    const hooks = await opencodeCodegBridgePlugin(
      {
        directory: workspacePath,
        worktree: workspacePath
      } as any,
      {} as any
    );

    // 1. Dispatch tool.execute.before for tool "task"
    await hooks["tool.execute.before"]!(
      {
        tool: "task",
        sessionID: "ses_main_123",
        callID: "call_abc_999"
      },
      {
        args: {
          description: "Subagent Task",
          subagent_type: "explore"
        }
      }
    );

    // Allow async barrier in SubagentTracker to persist initial conversation row
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 2. Dispatch event for "session.created"
    await hooks.event!({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "ses_subagent_456",
            parentID: "ses_main_123"
          }
        }
      } as any
    });

    // Allow external_id update to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 3. Dispatch tool.execute.after with successful output
    await hooks["tool.execute.after"]!(
      {
        tool: "task",
        sessionID: "ses_main_123",
        callID: "call_abc_999",
        args: { description: "Subagent Task", subagent_type: "explore" }
      },
      {
        title: "Task",
        output: JSON.stringify({ result: "Exploration completed successfully" }),
        metadata: {}
      }
    );

    // Allow status update to settle
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 4. Query conversation table and assert strict Codeg SeaORM columns
    const childConversations = await testDb.query<any>(
      "SELECT * FROM conversation WHERE id != 10;"
    );

    expect(childConversations).toHaveLength(1);
    const child = childConversations[0];

    expect(child.parent_id).toBe(10);
    expect(child.folder_id).toBe(1);
    expect(child.external_id).toBe("ses_subagent_456");
    expect(child.parent_tool_use_id).toBe("call_abc_999");
    expect(child.delegation_call_id).toMatch(UUID_V4_REGEX);
    expect(child.kind).toBe("delegate");
    expect(child.status).toBe("completed");
    expect(child.agent_type).toBe("explore");
    expect(child.title).toBe("Subagent Task");

    // Invariant: work_task table count === 0 (verifying no pollution of task board)
    const taskCountRows = await testDb.query<{ count: number }>(
      "SELECT count(*) as count FROM work_task;"
    );
    expect(taskCountRows[0].count).toBe(0);
  });

  it("handles error lifecycle with output.error: updates child conversation status to failed", async () => {
    const hooks = await opencodeCodegBridgePlugin(
      {
        directory: workspacePath,
        worktree: workspacePath
      } as any,
      {} as any
    );

    // 1. Dispatch tool.execute.before for tool "task"
    await hooks["tool.execute.before"]!(
      {
        tool: "task",
        sessionID: "ses_main_123",
        callID: "call_err_out_001"
      },
      {
        args: {
          description: "Failing Subagent Task (output.error)",
          subagent_type: "librarian"
        }
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    // 2. Dispatch event for "session.created"
    await hooks.event!({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "ses_subagent_err_out",
            parentID: "ses_main_123"
          }
        }
      } as any
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // 3. Dispatch tool.execute.after with output.error
    await hooks["tool.execute.after"]!(
      {
        tool: "task",
        sessionID: "ses_main_123",
        callID: "call_err_out_001",
        args: { description: "Failing Subagent Task (output.error)", subagent_type: "librarian" }
      },
      {
        title: "Task",
        output: "Error: Fatal error encountered during search",
        metadata: {}
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    // 4. Query conversation table and assert status is 'failed'
    const childConversations = await testDb.query<any>(
      "SELECT * FROM conversation WHERE parent_tool_use_id = 'call_err_out_001';"
    );

    expect(childConversations).toHaveLength(1);
    const child = childConversations[0];

    expect(child.parent_id).toBe(10);
    expect(child.folder_id).toBe(1);
    expect(child.external_id).toBe("ses_subagent_err_out");
    expect(child.parent_tool_use_id).toBe("call_err_out_001");
    expect(child.delegation_call_id).toMatch(UUID_V4_REGEX);
    expect(child.kind).toBe("delegate");
    expect(child.status).toBe("failed");
    expect(child.agent_type).toBe("librarian");
    expect(child.title).toBe("Failing Subagent Task (output.error)");

    // Invariant: work_task table count === 0
    const taskCountRows = await testDb.query<{ count: number }>(
      "SELECT count(*) as count FROM work_task;"
    );
    expect(taskCountRows[0].count).toBe(0);
  });

  it("handles error lifecycle with metadata.error: updates child conversation status to failed", async () => {
    const hooks = await opencodeCodegBridgePlugin(
      {
        directory: workspacePath,
        worktree: workspacePath
      } as any,
      {} as any
    );

    // 1. Dispatch tool.execute.before for tool "task"
    await hooks["tool.execute.before"]!(
      {
        tool: "task",
        sessionID: "ses_main_123",
        callID: "call_err_meta_002"
      },
      {
        args: {
          description: "Failing Subagent Task (metadata.error)",
          subagent_type: "explore"
        }
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    // 2. Dispatch event for "session.created"
    await hooks.event!({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "ses_subagent_err_meta",
            parentID: "ses_main_123"
          }
        }
      } as any
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // 3. Dispatch tool.execute.after with metadata.error
    await hooks["tool.execute.after"]!(
      {
        tool: "task",
        sessionID: "ses_main_123",
        callID: "call_err_meta_002",
        args: { description: "Failing Subagent Task (metadata.error)", subagent_type: "explore" }
      },
      {
        title: "Task",
        output: "Execution aborted",
        metadata: { error: true }
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    // 4. Query conversation table and assert status is 'failed'
    const childConversations = await testDb.query<any>(
      "SELECT * FROM conversation WHERE parent_tool_use_id = 'call_err_meta_002';"
    );

    expect(childConversations).toHaveLength(1);
    const child = childConversations[0];

    expect(child.parent_id).toBe(10);
    expect(child.folder_id).toBe(1);
    expect(child.external_id).toBe("ses_subagent_err_meta");
    expect(child.parent_tool_use_id).toBe("call_err_meta_002");
    expect(child.delegation_call_id).toMatch(UUID_V4_REGEX);
    expect(child.kind).toBe("delegate");
    expect(child.status).toBe("failed");
    expect(child.agent_type).toBe("explore");

    // Invariant: work_task table count === 0
    const taskCountRows = await testDb.query<{ count: number }>(
      "SELECT count(*) as count FROM work_task;"
    );
    expect(taskCountRows[0].count).toBe(0);
  });

  it("handles delegate_to_agent tool lifecycle seamlessly", async () => {
    const hooks = await opencodeCodegBridgePlugin(
      {
        directory: workspacePath,
        worktree: workspacePath
      } as any,
      {} as any
    );

    await hooks["tool.execute.before"]!(
      {
        tool: "delegate_to_agent",
        sessionID: "ses_main_123",
        callID: "call_delegate_777"
      },
      {
        args: {
          task: "Run comprehensive audit",
          agent_type: "open_code"
        }
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    await hooks.event!({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "ses_subagent_del_888",
            parentID: "ses_main_123"
          }
        }
      } as any
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    await hooks["tool.execute.after"]!(
      {
        tool: "delegate_to_agent",
        sessionID: "ses_main_123",
        callID: "call_delegate_777",
        args: {}
      },
      {
        title: "Delegation Result",
        output: JSON.stringify({ result: "Audit successful" }),
        metadata: {}
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    const childConversations = await testDb.query<any>(
      "SELECT * FROM conversation WHERE parent_tool_use_id = 'call_delegate_777';"
    );

    expect(childConversations).toHaveLength(1);
    const child = childConversations[0];

    expect(child.parent_id).toBe(10);
    expect(child.external_id).toBe("ses_subagent_del_888");
    expect(child.parent_tool_use_id).toBe("call_delegate_777");
    expect(child.delegation_call_id).toMatch(UUID_V4_REGEX);
    expect(child.kind).toBe("delegate");
    expect(child.status).toBe("completed");
    expect(child.agent_type).toBe("open_code");
    expect(child.title).toBe("Run comprehensive audit");

    const taskCountRows = await testDb.query<{ count: number }>(
      "SELECT count(*) as count FROM work_task;"
    );
    expect(taskCountRows[0].count).toBe(0);
  });
});
