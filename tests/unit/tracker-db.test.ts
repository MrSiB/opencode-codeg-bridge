import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDatabase, type TestDbInstance } from "../helpers/test-db.js";
import {
  findConversationByExternalId,
  createChildConversation,
  updateConversationExternalId,
  updateConversationStatus,
  reconcileStaleSubagents
} from "../../src/tracker-db.js";

describe("tracker-db SQLite conversation helpers", () => {
  let testDb: TestDbInstance;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    // Insert a test folder so FK constraint is satisfied
    await testDb.exec(`
      INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at)
      VALUES (1, 'test-project', '/workspace/test-project', datetime('now'), datetime('now'), datetime('now'));
    `);
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it("creates a child conversation and queries it by externalId after assignment", async () => {
    const client = testDb.spawnRawClient();

    // 1. Create child conversation with valid parentToolUseId and delegationCallId
    const newId = await createChildConversation(client, {
      folderId: 1,
      title: "Subagent Task",
      agentType: "sisyphus",
      status: "in_progress",
      model: "claude-3-5-sonnet",
      parentId: null,
      parentToolUseId: "toolu_01abc",
      delegationCallId: "call_01xyz",
      originCwd: "/workspace/test-project",
      kind: "delegate"
    });

    expect(newId).toBeGreaterThan(0);

    // Initial external_id should be NULL
    const initialByExternalId = await findConversationByExternalId(client, "ext_subagent_123");
    expect(initialByExternalId).toBeNull();

    // Query directly from DB to verify created fields
    const rows = await testDb.query<any>(`SELECT * FROM conversation WHERE id = ${newId};`);
    expect(rows).toHaveLength(1);
    expect(rows[0].folder_id).toBe(1);
    expect(rows[0].title).toBe("Subagent Task");
    expect(rows[0].agent_type).toBe("sisyphus");
    expect(rows[0].status).toBe("in_progress");
    expect(rows[0].model).toBe("claude-3-5-sonnet");
    expect(rows[0].external_id).toBeNull();
    expect(rows[0].parent_tool_use_id).toBe("toolu_01abc");
    expect(rows[0].delegation_call_id).toBe("call_01xyz");
    expect(rows[0].kind).toBe("delegate");
    expect(rows[0].origin_cwd).toBe("/workspace/test-project");

    // 2. Update external_id
    await updateConversationExternalId(client, newId, "ext_subagent_123");

    // 3. Find by externalId
    const fetched = await findConversationByExternalId(client, "ext_subagent_123");
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(newId);
    expect(fetched?.folder_id).toBe(1);
    expect(fetched?.title).toBe("Subagent Task");
    expect(fetched?.agent_type).toBe("sisyphus");
    expect(fetched?.status).toBe("in_progress");
    expect(fetched?.model).toBe("claude-3-5-sonnet");
    expect(fetched?.external_id).toBe("ext_subagent_123");
    expect(fetched?.parent_tool_use_id).toBe("toolu_01abc");
    expect(fetched?.delegation_call_id).toBe("call_01xyz");
    expect(fetched?.kind).toBe("delegate");
    expect(fetched?.origin_cwd).toBe("/workspace/test-project");
  });

  it("validates that parentToolUseId and delegationCallId are non-empty", async () => {
    const client = testDb.spawnRawClient();

    await expect(
      createChildConversation(client, {
        folderId: 1,
        agentType: "sisyphus",
        parentToolUseId: "",
        delegationCallId: "call_123"
      })
    ).rejects.toThrow("parentToolUseId must be non-empty");

    await expect(
      createChildConversation(client, {
        folderId: 1,
        agentType: "sisyphus",
        parentToolUseId: "   ",
        delegationCallId: "call_123"
      })
    ).rejects.toThrow("parentToolUseId must be non-empty");

    await expect(
      createChildConversation(client, {
        folderId: 1,
        agentType: "sisyphus",
        parentToolUseId: "tool_123",
        delegationCallId: ""
      })
    ).rejects.toThrow("delegationCallId must be non-empty");

    await expect(
      createChildConversation(client, {
        folderId: 1,
        agentType: "sisyphus",
        parentToolUseId: "tool_123",
        delegationCallId: "  "
      })
    ).rejects.toThrow("delegationCallId must be non-empty");
  });

  it("properly escapes single quotes in parameters", async () => {
    const client = testDb.spawnRawClient();

    const newId = await createChildConversation(client, {
      folderId: 1,
      title: "Task's 'Special' Title with '' quotes",
      agentType: "custom'agent",
      model: "model'with'quote",
      parentToolUseId: "tool'use'id",
      delegationCallId: "call'id'xyz",
      originCwd: "/workspace/dir'with'quote",
      kind: "delegate'kind"
    });

    const rows = await testDb.query<any>(`SELECT * FROM conversation WHERE id = ${newId};`);
    expect(rows[0].title).toBe("Task's 'Special' Title with '' quotes");
    expect(rows[0].agent_type).toBe("custom'agent");
    expect(rows[0].parent_tool_use_id).toBe("tool'use'id");

    await updateConversationExternalId(client, newId, "ext'id'123");
    const fetched = await findConversationByExternalId(client, "ext'id'123");
    expect(fetched?.external_id).toBe("ext'id'123");

    await updateConversationStatus(client, newId, "custom'status");
    const updated = await testDb.query<any>(`SELECT status FROM conversation WHERE id = ${newId};`);
    expect(updated[0].status).toBe("custom'status");
  });

  it("updates conversation status and timestamp", async () => {
    const client = testDb.spawnRawClient();

    const id = await createChildConversation(client, {
      folderId: 1,
      agentType: "sisyphus",
      parentToolUseId: "tool_1",
      delegationCallId: "call_1"
    });

    await updateConversationStatus(client, id, "completed");

    const rows = await testDb.query<any>(`SELECT status FROM conversation WHERE id = ${id};`);
    expect(rows[0].status).toBe("completed");
  });

  it("reconciles stale subagent sessions", async () => {
    const client = testDb.spawnRawClient();

    // 1. Fresh in_progress delegate (should NOT be reconciled)
    await testDb.exec(`
      INSERT INTO conversation (folder_id, title, agent_type, status, created_at, updated_at, kind)
      VALUES (1, 'Fresh Active', 'sisyphus', 'in_progress', datetime('now'), datetime('now'), 'delegate');
    `);

    // 2. Stale in_progress delegate (updated 45 mins ago -> SHOULD be reconciled)
    await testDb.exec(`
      INSERT INTO conversation (folder_id, title, agent_type, status, created_at, updated_at, kind)
      VALUES (1, 'Stale Active', 'sisyphus', 'in_progress', datetime('now', '-50 minutes'), datetime('now', '-45 minutes'), 'delegate');
    `);

    // 3. Stale non-delegate in_progress (kind = 'regular' -> should NOT be touched)
    await testDb.exec(`
      INSERT INTO conversation (folder_id, title, agent_type, status, created_at, updated_at, kind)
      VALUES (1, 'Stale Regular', 'sisyphus', 'in_progress', datetime('now', '-50 minutes'), datetime('now', '-45 minutes'), 'regular');
    `);

    // 4. Stale already completed delegate (should NOT be touched)
    await testDb.exec(`
      INSERT INTO conversation (folder_id, title, agent_type, status, created_at, updated_at, kind)
      VALUES (1, 'Stale Done', 'sisyphus', 'completed', datetime('now', '-50 minutes'), datetime('now', '-45 minutes'), 'delegate');
    `);

    const affected = await reconcileStaleSubagents(client, 30);
    expect(affected).toBe(1);

    const rows = await testDb.query<any>(`SELECT title, status FROM conversation ORDER BY id ASC;`);
    expect(rows.find((r) => r.title === "Fresh Active")?.status).toBe("in_progress");
    expect(rows.find((r) => r.title === "Stale Active")?.status).toBe("failed");
    expect(rows.find((r) => r.title === "Stale Regular")?.status).toBe("in_progress");
    expect(rows.find((r) => r.title === "Stale Done")?.status).toBe("completed");
  });
});
