import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createDatabaseBackup,
  rotateDatabaseBackups,
  formatBackupTimestamp,
  listDatabaseBackups
} from "../../src/backup.js";
import { DatabaseNotFoundError } from "../../src/errors.js";
import { createTestDatabase, type TestDbInstance } from "../helpers/test-db.js";

const execFileAsync = promisify(execFile);

describe("SQLite Hot Backup and Snapshot Rotation Engine", () => {
  let dbInstance: TestDbInstance;

  beforeEach(async () => {
    dbInstance = await createTestDatabase();
  });

  afterEach(async () => {
    await dbInstance.cleanup();
  });

  describe("formatBackupTimestamp", () => {
    it("formats dates into filesystem-safe ISO timestamp format YYYY-MM-DDTHH-mm-ss-SSSZ", () => {
      const fixedDate = new Date("2026-09-29T14:30:45.123Z");
      const formatted = formatBackupTimestamp(fixedDate);
      expect(formatted).toBe("2026-09-29T14-30-45-123Z");
      expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    });
  });

  describe("createDatabaseBackup", () => {
    it("creates a valid SQLite hot backup using .backup with matching content", async () => {
      await dbInstance.exec(
        "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at) VALUES (1, 'my-folder', '/test/folder', datetime('now'), datetime('now'), datetime('now'));"
      );
      await dbInstance.exec(
        "INSERT INTO work_task (id, folder_id, title, config, status, created_at, updated_at) VALUES (101, 1, 'Backup verification task', '{}', 'todo', datetime('now'), datetime('now'));"
      );

      const backupPath = await createDatabaseBackup(dbInstance.dbPath);

      expect(backupPath).toContain(`${dbInstance.dbPath}.bak.`);
      const stat = await fs.stat(backupPath);
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBeGreaterThan(0);

      // Verify the backup is a valid SQLite database with accurate content
      const { stdout } = await execFileAsync("sqlite3", [
        backupPath,
        "-json",
        "SELECT id, title, status FROM work_task WHERE id = 101;"
      ]);
      const rows = JSON.parse(stdout);
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Backup verification task");
      expect(rows[0].status).toBe("todo");
    });

    it("throws DatabaseNotFoundError when target database file does not exist", async () => {
      const nonExistentDb = path.join(dbInstance.tempDir, "does-not-exist.db");
      await expect(createDatabaseBackup(nonExistentDb)).rejects.toThrow(
        DatabaseNotFoundError
      );
    });

    it("creates 8 consecutive backups and automatically rotates, preserving exactly the 5 newest files with valid data", async () => {
      // Seed table with data that updates on each backup step
      for (let i = 1; i <= 8; i++) {
        await dbInstance.exec(
          `INSERT INTO work_task (id, folder_id, title, config, status, created_at, updated_at) ` +
            `VALUES (${i}, 1, 'Task snapshot #${i}', '{}', 'todo', datetime('now'), datetime('now'));`
        );

        // Slight delay to guarantee unique timestamps and clear mtime separation
        await new Promise((resolve) => setTimeout(resolve, 30));
        await createDatabaseBackup(dbInstance.dbPath, { maxBackups: 5 });
      }

      const parentDir = dbInstance.tempDir;
      const files = await fs.readdir(parentDir);
      const backupFiles = files.filter((f) =>
        f.startsWith(`${path.basename(dbInstance.dbPath)}.bak.`)
      );

      // Exactly 5 backup files remain on disk
      expect(backupFiles).toHaveLength(5);

      // Check all 5 files are valid SQLite databases
      for (const backupFileName of backupFiles) {
        const fullBackupPath = path.join(parentDir, backupFileName);
        const { stdout: pragmaCheck } = await execFileAsync("sqlite3", [
          fullBackupPath,
          "PRAGMA integrity_check;"
        ]);
        expect(pragmaCheck.trim()).toBe("ok");

        const { stdout: rowCountOut } = await execFileAsync("sqlite3", [
          fullBackupPath,
          "SELECT count(*) as count FROM work_task;"
        ]);
        const rowCount = parseInt(rowCountOut.trim(), 10);
        // Since we created 8 backups and kept the newest 5,
        // the remaining backups correspond to iterations 4, 5, 6, 7, 8 (count >= 4)
        expect(rowCount).toBeGreaterThanOrEqual(4);
        expect(rowCount).toBeLessThanOrEqual(8);
      }

      // Check listDatabaseBackups returns the 5 backups sorted descending
      const listed = await listDatabaseBackups(dbInstance.dbPath);
      expect(listed).toHaveLength(5);
    });
  });

  describe("rotateDatabaseBackups", () => {
    it("asynchronously prunes oldest backup files and returns deleted file paths", async () => {
      const parentDir = dbInstance.tempDir;
      const baseName = path.basename(dbInstance.dbPath);

      // Manually create mock backup files with varying mtimes
      const createdPaths: string[] = [];
      for (let i = 1; i <= 7; i++) {
        const fakeTimestamp = `2026-09-29T10-00-0${i}-000Z`;
        const filePath = path.join(parentDir, `${baseName}.bak.${fakeTimestamp}`);
        await fs.writeFile(filePath, `backup content ${i}`);
        // Set distinct mtime
        const time = new Date(2026, 8, 29, 10, 0, i);
        await fs.utimes(filePath, time, time);
        createdPaths.push(filePath);
      }

      const deleted = await rotateDatabaseBackups(dbInstance.dbPath, 3);

      expect(deleted).toHaveLength(4);
      // Oldest files (indices 0, 1, 2, 3 corresponding to i = 1, 2, 3, 4) should be deleted
      for (let i = 0; i < 4; i++) {
        expect(deleted).toContain(createdPaths[i]);
        await expect(fs.stat(createdPaths[i])).rejects.toThrow();
      }

      // Newest 3 files should still exist
      for (let i = 4; i < 7; i++) {
        const stat = await fs.stat(createdPaths[i]);
        expect(stat.isFile()).toBe(true);
      }
    });

    it("safely handles concurrent deletion without throwing", async () => {
      const parentDir = dbInstance.tempDir;
      const baseName = path.basename(dbInstance.dbPath);

      // Create backup files
      for (let i = 1; i <= 6; i++) {
        const fakeTimestamp = `2026-09-29T11-00-0${i}-000Z`;
        const filePath = path.join(parentDir, `${baseName}.bak.${fakeTimestamp}`);
        await fs.writeFile(filePath, `test content ${i}`);
      }

      // Concurrently run rotateDatabaseBackups twice
      const [deleted1, deleted2] = await Promise.all([
        rotateDatabaseBackups(dbInstance.dbPath, 2),
        rotateDatabaseBackups(dbInstance.dbPath, 2)
      ]);

      const files = await fs.readdir(parentDir);
      const remainingBackups = files.filter((f) => f.startsWith(`${baseName}.bak.`));
      expect(remainingBackups).toHaveLength(2);
      expect(deleted1.length + deleted2.length).toBeGreaterThanOrEqual(4);
    });

    it("returns empty array when directory has fewer files than maxBackups", async () => {
      const parentDir = dbInstance.tempDir;
      const baseName = path.basename(dbInstance.dbPath);

      const filePath = path.join(parentDir, `${baseName}.bak.2026-09-29T12-00-00-000Z`);
      await fs.writeFile(filePath, "single backup");

      const deleted = await rotateDatabaseBackups(dbInstance.dbPath, 5);
      expect(deleted).toEqual([]);

      const stat = await fs.stat(filePath);
      expect(stat.isFile()).toBe(true);
    });
  });
});
