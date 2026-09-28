import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SqliteClient,
  sanitizeSqlText,
  escapeSqlString,
  SqliteBusyError,
  SqliteExecutionError
} from "../../src/sqlite.js";
import {
  createTestDatabase,
  simulateExternalLock,
  type TestDbInstance
} from "../helpers/test-db.js";
import fs from "node:fs/promises";
import path from "node:path";

describe("Robust Zero-Native SQLite Client", () => {
  let dbInstance: TestDbInstance;
  let client: SqliteClient;

  beforeEach(async () => {
    dbInstance = await createTestDatabase();
    client = new SqliteClient(dbInstance.dbPath, { maxBackups: 2, busyTimeoutMs: 1000 });
  });

  afterEach(async () => {
    await dbInstance.cleanup();
  });

  it("executes queries and returns parsed JSON results", async () => {
    await client.exec(
      "INSERT INTO folder (name, path, last_opened_at, created_at, updated_at) VALUES ('p1', '/p1', datetime('now'), datetime('now'), datetime('now'));"
    );

    const rows = await client.query<{ id: number; name: string }>(
      "SELECT id, name FROM folder WHERE name = 'p1';"
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("p1");
  });

  it("executes atomic commands inside an immediate transaction", async () => {
    const commands = [
      "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at) VALUES (10, 'f10', '/f10', datetime('now'), datetime('now'), datetime('now'));",
      "INSERT INTO work_task (folder_id, title, config, status, created_at, updated_at) VALUES (10, 'Task inside tx', '{}', 'todo', datetime('now'), datetime('now'));"
    ];

    await client.executeInTransaction(commands);

    const tasks = await client.query<{ title: string }>(
      "SELECT title FROM work_task WHERE folder_id = 10;"
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Task inside tx");
  });

  it("creates hot backups and rotates older files according to maxBackups", async () => {
    await client.exec(
      "INSERT INTO folder (name, path, last_opened_at, created_at, updated_at) VALUES ('p', '/p', datetime('now'), datetime('now'), datetime('now'));"
    );

    await client.createBackup();
    await new Promise((r) => setTimeout(r, 20));
    await client.createBackup();
    await new Promise((r) => setTimeout(r, 20));
    const b3 = await client.createBackup();

    expect(await fs.stat(b3)).toBeDefined();

    const parentDir = path.dirname(dbInstance.dbPath);
    const files = await fs.readdir(parentDir);
    const backups = files.filter((f) => f.includes(".bak."));

    expect(backups.length).toBeLessThanOrEqual(2);
  });

  it("streams large SQL payloads (>2MB) without E2BIG error", async () => {
    await client.exec(
      "CREATE TABLE IF NOT EXISTS large_payload (id INTEGER PRIMARY KEY, data TEXT);"
    );

    const largeString = "A".repeat(2.5 * 1024 * 1024);
    const insertSql = `INSERT INTO large_payload (data) VALUES ('${largeString}');`;

    await client.exec(insertSql);

    const rows = await client.query<{ len: number }>(
      "SELECT length(data) AS len FROM large_payload WHERE id = 1;"
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].len).toBe(largeString.length);
  });

  it("successfully executes transaction under temporary external lock via retry mechanism", async () => {
    await simulateExternalLock(dbInstance.dbPath, 250);

    const retryClient = new SqliteClient(dbInstance.dbPath, {
      busyTimeoutMs: 80,
      retryOptions: {
        minDelayMs: 40,
        maxDelayMs: 150,
        maxAttempts: 5
      }
    });

    await retryClient.executeInTransaction([
      "INSERT INTO folder (name, path, last_opened_at, created_at, updated_at) VALUES ('retry-ok', '/retry-ok', datetime('now'), datetime('now'), datetime('now'));"
    ]);

    const rows = await retryClient.query<{ name: string }>(
      "SELECT name FROM folder WHERE name = 'retry-ok';"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("retry-ok");
  });

  it("throws SqliteBusyError when external lock persists beyond 5 retry attempts", async () => {
    const releaseLock = await simulateExternalLock(dbInstance.dbPath, 10000);

    const busyClient = new SqliteClient(dbInstance.dbPath, {
      busyTimeoutMs: 50,
      retryOptions: {
        minDelayMs: 20,
        maxDelayMs: 50,
        maxAttempts: 5
      }
    });

    let caughtError: unknown;
    try {
      await busyClient.executeInTransaction([
        "INSERT INTO folder (name, path, last_opened_at, created_at, updated_at) VALUES ('blocked', '/blocked', datetime('now'), datetime('now'), datetime('now'));"
      ]);
    } catch (err) {
      caughtError = err;
    } finally {
      releaseLock();
    }

    expect(caughtError).toBeInstanceOf(SqliteBusyError);
    expect((caughtError as SqliteBusyError).code).toBe("ERR_SQLITE_BUSY");
    expect((caughtError as SqliteBusyError).message).toContain("5 attempts");
  });

  it("sanitizes SQL input by removing NUL bytes and handling quotes", async () => {
    expect(sanitizeSqlText("SELECT * FROM\0 folder\0;")).toBe("SELECT * FROM folder;");
    expect(escapeSqlString("O'Reilly\0")).toBe("O''Reilly");
    expect(sanitizeSqlText("O'Reilly", { escapeQuotes: true })).toBe("O''Reilly");

    await client.exec(
      "INSERT INTO folder (name, path, last_opened_at, created_at, updated_at) VALUES ('nul\0test', '/nul\0test', datetime('now'), datetime('now'), datetime('now'));"
    );
    const rows = await client.query<{ name: string }>(
      "SELECT name FROM folder WHERE name = 'nultest';"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("nultest");
  });

  it("initializes WAL journal mode on client startup", async () => {
    const walClient = new SqliteClient(dbInstance.dbPath);
    await walClient.initPragmas();

    const rows = await walClient.query<{ journal_mode: string }>("PRAGMA journal_mode;");
    expect(rows[0].journal_mode.toLowerCase()).toBe("wal");
  });

  it("maps sqlite execution errors to typed BridgeError / SqliteExecutionError", async () => {
    await expect(
      client.query("SELECT * FROM table_that_does_not_exist;")
    ).rejects.toThrowError(SqliteExecutionError);
  });
});
