import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDatabase, type TestDbInstance } from "../helpers/test-db.js";
import { SubagentTracker } from "../../src/tracker.js";

describe("SubagentTracker unit tests", () => {
  let testDb: TestDbInstance;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    // Insert folder and parent conversation
    await testDb.exec(`
      INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at)
      VALUES (1, 'test-project', '/workspace/test-project', datetime('now'), datetime('now'), datetime('now'));

      INSERT INTO conversation (id, folder_id, title, agent_type, status, external_id, created_at, updated_at, kind)
      VALUES (10, 1, 'Parent Session', 'sisyphus', 'in_progress', 'ses_parent_123', datetime('now'), datetime('now'), 'regular');
    `);
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it("handles full lifecycle: before -> sessionCreated -> after (status completed)", async () => {
    const client = testDb.spawnRawClient();
    const tracker = new SubagentTracker(client);

    const callID = "call_task_001";
    const sessionID = "ses_parent_123";
    const childSessionID = "ses_child_456";

    // 1. handleToolBefore
    await tracker.handleToolBefore({
      tool: "task",
      sessionID,
      callID,
      args: {
        description: "Explore subtask",
        subagent_type: "explore"
      }
    });

    expect(tracker.activeDelegations.has(callID)).toBe(true);
    const delegation = tracker.activeDelegations.get(callID)!;
    expect(delegation.callId).toBe(callID);
    expect(delegation.parentSessionId).toBe(sessionID);

    // Wait for the async barrier
    const recordId = await delegation.recordIdPromise;
    expect(recordId).not.toBeNull();
    expect(typeof recordId).toBe("number");

    // Check DB record created
    let rows = await testDb.query<any>(`SELECT * FROM conversation WHERE id = ${recordId};`);
    expect(rows).toHaveLength(1);
    expect(rows[0].parent_id).toBe(10);
    expect(rows[0].folder_id).toBe(1);
    expect(rows[0].title).toBe("Explore subtask");
    expect(rows[0].agent_type).toBe("explore");
    expect(rows[0].kind).toBe("delegate");
    expect(rows[0].parent_tool_use_id).toBe(callID);
    expect(rows[0].external_id).toBeNull();
    expect(rows[0].status).toBe("in_progress");

    // 2. handleSessionCreated
    await tracker.handleSessionCreated({
      id: childSessionID,
      parentID: sessionID,
      title: "Explore subtask"
    });

    rows = await testDb.query<any>(`SELECT external_id FROM conversation WHERE id = ${recordId};`);
    expect(rows[0].external_id).toBe(childSessionID);

    // 3. handleToolAfter (success)
    await tracker.handleToolAfter({
      tool: "task",
      sessionID,
      callID,
      args: {},
      output: { result: "All done successfully" }
    });

    expect(tracker.activeDelegations.has(callID)).toBe(false);

    rows = await testDb.query<any>(`SELECT * FROM conversation WHERE id = ${recordId};`);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].external_id).toBe(childSessionID);
    expect(rows[0].parent_id).toBe(10);
    expect(rows[0].kind).toBe("delegate");
  });

  it("handles failure in handleToolAfter correctly", async () => {
    const client = testDb.spawnRawClient();
    const tracker = new SubagentTracker(client);

    const callID = "call_task_fail_1";
    const sessionID = "ses_parent_123";

    await tracker.handleToolBefore({
      tool: "delegate_to_agent",
      sessionID,
      callID,
      args: {
        prompt: "Do something risky",
        agent_type: "open_code"
      }
    });

    const delegation = tracker.activeDelegations.get(callID)!;
    const recordId = await delegation.recordIdPromise;
    expect(recordId).not.toBeNull();

    await tracker.handleToolAfter({
      tool: "delegate_to_agent",
      sessionID,
      callID,
      args: {},
      output: { error: "Something crashed" }
    });

    expect(tracker.activeDelegations.has(callID)).toBe(false);

    const rows = await testDb.query<any>(`SELECT status FROM conversation WHERE id = ${recordId};`);
    expect(rows[0].status).toBe("failed");
  });

  it("handles out-of-order execution without race conditions (sessionCreated arrives during before)", async () => {
    const client = testDb.spawnRawClient();
    const tracker = new SubagentTracker(client);

    const callID = "call_race_01";
    const sessionID = "ses_parent_123";
    const childSessionID = "ses_child_fast";

    // Start handleToolBefore (do not wait for barrier completion before firing sessionCreated)
    const beforePromise = tracker.handleToolBefore({
      tool: "task",
      sessionID,
      callID,
      args: { description: "Race condition test" }
    });

    // Fire handleSessionCreated immediately concurrently
    const sessionCreatedPromise = tracker.handleSessionCreated({
      id: childSessionID,
      parentID: sessionID
    });

    await Promise.all([beforePromise, sessionCreatedPromise]);

    const delegation = tracker.activeDelegations.get(callID)!;
    const recordId = await delegation.recordIdPromise;
    expect(recordId).not.toBeNull();

    // Verify external_id was updated despite concurrent invocation
    const rows = await testDb.query<any>(`SELECT external_id FROM conversation WHERE id = ${recordId};`);
    expect(rows[0].external_id).toBe(childSessionID);

    // Call handleToolAfter
    await tracker.handleToolAfter({
      tool: "task",
      sessionID,
      callID,
      args: {},
      output: "Done"
    });

    const finalRows = await testDb.query<any>(`SELECT status FROM conversation WHERE id = ${recordId};`);
    expect(finalRows[0].status).toBe("completed");
  });

  it("safely skips insertion without crashing when parent sessionID is unknown", async () => {
    const client = testDb.spawnRawClient();
    const warnFn = vi.fn();
    const tracker = new SubagentTracker(client, { warn: warnFn });

    const callID = "call_unknown_parent";
    const unknownSessionID = "ses_unknown_999";

    // Should not throw
    await expect(
      tracker.handleToolBefore({
        tool: "task",
        sessionID: unknownSessionID,
        callID,
        args: { description: "Child of unknown" }
      })
    ).resolves.toBeUndefined();

    const delegation = tracker.activeDelegations.get(callID);
    expect(delegation).toBeDefined();

    const recordId = await delegation!.recordIdPromise;
    expect(recordId).toBeNull();
    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining("Parent conversation not found")
    );

    // handleSessionCreated should safely handle null recordId
    await expect(
      tracker.handleSessionCreated({
        id: "ses_child_none",
        parentID: unknownSessionID
      })
    ).resolves.toBeUndefined();

    // handleToolAfter should safely delete delegation without throwing
    await expect(
      tracker.handleToolAfter({
        tool: "task",
        sessionID: unknownSessionID,
        callID,
        args: {},
        output: "Result"
      })
    ).resolves.toBeUndefined();

    expect(tracker.activeDelegations.has(callID)).toBe(false);

    // Confirm no new conversation row was created
    const rows = await testDb.query<any>("SELECT COUNT(*) as count FROM conversation WHERE id != 10;");
    expect(rows[0].count).toBe(0);
  });

  it("ignores irrelevant tools", async () => {
    const client = testDb.spawnRawClient();
    const tracker = new SubagentTracker(client);

    await tracker.handleToolBefore({
      tool: "read_file",
      sessionID: "ses_parent_123",
      callID: "call_other",
      args: {}
    });

    expect(tracker.activeDelegations.size).toBe(0);

    await tracker.handleToolAfter({
      tool: "read_file",
      sessionID: "ses_parent_123",
      callID: "call_other",
      args: {},
      output: {}
    });

    expect(tracker.activeDelegations.size).toBe(0);
  });

  it("supports SubagentTrackerOptions, pruneAbandoned and dispose", async () => {
    const client = testDb.spawnRawClient();
    const tracker = new SubagentTracker(client, undefined, {
      timeoutMs: 100,
      maxAgeMs: 50,
      pruneIntervalMs: 1000
    });

    tracker.activeDelegations.set("old_call", {
      callId: "old_call",
      parentSessionId: "ses_parent_123",
      recordIdPromise: Promise.resolve(null),
      startedAt: Date.now() - 100
    });
    tracker.activeDelegations.set("fresh_call", {
      callId: "fresh_call",
      parentSessionId: "ses_parent_123",
      recordIdPromise: Promise.resolve(null),
      startedAt: Date.now()
    });

    const pruned = tracker.pruneAbandoned();
    expect(pruned).toBe(1);
    expect(tracker.activeDelegations.has("old_call")).toBe(false);
    expect(tracker.activeDelegations.has("fresh_call")).toBe(true);

    tracker.dispose();
  });

  it("handles timeout in background creation safely resolving recordId to null", async () => {
    const slowClient = {
      query: () => new Promise<never>(() => {})
    } as any;
    const tracker = new SubagentTracker(slowClient, undefined, {
      timeoutMs: 50
    });

    await tracker.handleToolBefore({
      tool: "task",
      sessionID: "ses_parent_123",
      callID: "call_timeout",
      args: { description: "Timeout test" }
    });

    const delegation = tracker.activeDelegations.get("call_timeout");
    expect(delegation).toBeDefined();

    const recordId = await delegation!.recordIdPromise;
    expect(recordId).toBeNull();
    tracker.dispose();
  });
});
