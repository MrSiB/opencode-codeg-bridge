import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createTestDatabase,
  simulateExternalLock,
  type TestDbInstance
} from "../helpers/test-db.js";
import { SqliteClient } from "../../src/sqlite.js";
import { SubagentTracker, type Logger } from "../../src/tracker.js";

describe("SubagentTracker Resilience & Failure Modes", () => {
  let testDb: TestDbInstance;

  beforeEach(async () => {
    testDb = await createTestDatabase();
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

  it("recovers from SQLite lock contention via retryAsync once external lock releases", async () => {
    // 1. Acquire an external lock for ~300ms
    const releaseLock = await simulateExternalLock(testDb.dbPath, 300);

    const client = testDb.spawnRawClient({ busyTimeoutMs: 50 });
    const tracker = new SubagentTracker(client, undefined, { timeoutMs: 3000 });

    const callID = "call_retry_contention_01";
    const sessionID = "ses_parent_123";

    try {
      await tracker.handleToolBefore({
        tool: "task",
        sessionID,
        callID,
        args: {
          description: "Contention task",
          subagent_type: "explore"
        }
      });

      const delegation = tracker.activeDelegations.get(callID);
      expect(delegation).toBeDefined();

      // Wait for barrier - retryAsync catches SQLITE_BUSY and retries until lock releases
      const recordId = await delegation!.recordIdPromise;
      expect(recordId).not.toBeNull();
      expect(typeof recordId).toBe("number");

      // Verify conversation record in DB
      const rows = await testDb.query<any>(`SELECT * FROM conversation WHERE id = ${recordId};`);
      expect(rows).toHaveLength(1);
      expect(rows[0].parent_id).toBe(10);
      expect(rows[0].folder_id).toBe(1);
      expect(rows[0].title).toBe("Contention task");
      expect(rows[0].agent_type).toBe("explore");
      expect(rows[0].status).toBe("in_progress");
    } finally {
      tracker.dispose();
      releaseLock();
    }
  });

  it("handles permanent lock / timeout gracefully without throwing or crashing", async () => {
    // 2. Hold permanent lock (durationMs = 0)
    const releaseLock = await simulateExternalLock(testDb.dbPath, 0);

    try {
      const client = testDb.spawnRawClient({ busyTimeoutMs: 50 });
      const logger: Logger = {
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn()
      };
      // Short timeout (300ms) for fast execution
      const tracker = new SubagentTracker(client, logger, { timeoutMs: 300 });

      const callID = "call_perm_lock_01";
      const sessionID = "ses_parent_123";

      // handleToolBefore must resolve cleanly without throwing
      await expect(
        tracker.handleToolBefore({
          tool: "task",
          sessionID,
          callID,
          args: { description: "Blocked task" }
        })
      ).resolves.toBeUndefined();

      const delegation = tracker.activeDelegations.get(callID);
      expect(delegation).toBeDefined();

      // Wait for barrier timeout - resolves to null, error logged
      const recordId = await delegation!.recordIdPromise;
      expect(recordId).toBeNull();
      expect(logger.error).toHaveBeenCalled();

      // handleSessionCreated must resolve cleanly without throwing
      await expect(
        tracker.handleSessionCreated({
          id: "ses_child_timeout",
          parentID: sessionID
        })
      ).resolves.toBeUndefined();

      // handleToolAfter must resolve cleanly and delete active delegation
      await expect(
        tracker.handleToolAfter({
          tool: "task",
          sessionID,
          callID,
          args: {},
          output: "Cancelled"
        })
      ).resolves.toBeUndefined();

      expect(tracker.activeDelegations.has(callID)).toBe(false);
      tracker.dispose();
    } finally {
      releaseLock();
    }
  });

  it("swallows error and logs appropriately when given an invalid database file path", async () => {
    // 3. Client pointing to a non-existent directory
    const invalidClient = new SqliteClient("/nonexistent/directory/invalid.db", {
      retry: false,
      wal: false
    });
    const logger: Logger = {
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };
    const tracker = new SubagentTracker(invalidClient, logger, { timeoutMs: 500 });

    const callID = "call_invalid_db_01";
    const sessionID = "ses_parent_123";

    await expect(
      tracker.handleToolBefore({
        tool: "task",
        sessionID,
        callID,
        args: { description: "Invalid DB task" }
      })
    ).resolves.toBeUndefined();

    const delegation = tracker.activeDelegations.get(callID);
    expect(delegation).toBeDefined();

    const recordId = await delegation!.recordIdPromise;
    expect(recordId).toBeNull();
    expect(logger.error).toHaveBeenCalled();

    await expect(
      tracker.handleSessionCreated({
        id: "ses_child_invalid",
        parentID: sessionID
      })
    ).resolves.toBeUndefined();

    await expect(
      tracker.handleToolAfter({
        tool: "task",
        sessionID,
        callID,
        args: {},
        output: "Finished"
      })
    ).resolves.toBeUndefined();

    expect(tracker.activeDelegations.has(callID)).toBe(false);
    tracker.dispose();
  });

  it("prunes abandoned delegations based on maxAgeMs and cleans up resources on dispose", () => {
    // 4. Pruning and dispose lifecycle
    const client = testDb.spawnRawClient();
    const debugFn = vi.fn();
    const logger: Logger = { debug: debugFn };
    const tracker = new SubagentTracker(client, logger, {
      maxAgeMs: 200,
      pruneIntervalMs: 5000
    });

    const now = Date.now();
    tracker.activeDelegations.set("old_call_1", {
      callId: "old_call_1",
      parentSessionId: "ses_parent_123",
      recordIdPromise: Promise.resolve(null),
      startedAt: now - 300
    });
    tracker.activeDelegations.set("old_call_2", {
      callId: "old_call_2",
      parentSessionId: "ses_parent_123",
      recordIdPromise: Promise.resolve(null),
      startedAt: now - 500
    });
    tracker.activeDelegations.set("fresh_call_1", {
      callId: "fresh_call_1",
      parentSessionId: "ses_parent_123",
      recordIdPromise: Promise.resolve(null),
      startedAt: now - 50
    });

    // Prune with default maxAgeMs (200ms)
    const prunedCount = tracker.pruneAbandoned();
    expect(prunedCount).toBe(2);
    expect(tracker.activeDelegations.has("old_call_1")).toBe(false);
    expect(tracker.activeDelegations.has("old_call_2")).toBe(false);
    expect(tracker.activeDelegations.has("fresh_call_1")).toBe(true);
    expect(debugFn).toHaveBeenCalledTimes(2);

    // Prune with custom maxAgeMs override (10ms)
    const prunedOverride = tracker.pruneAbandoned(10);
    expect(prunedOverride).toBe(1);
    expect(tracker.activeDelegations.has("fresh_call_1")).toBe(false);

    // Verify dispose cleans up interval safely and is idempotent
    tracker.dispose();
    expect(() => tracker.dispose()).not.toThrow();
  });
});
