import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DatabaseNotFoundError,
  SqliteCliNotFoundError,
  SqliteExecutionError
} from "./errors.js";
import { retryAsync, isSqliteBusyError } from "./retry.js";

const execFileAsync = promisify(execFile);

export interface BackupOptions {
  maxBackups?: number;
  busyTimeoutMs?: number;
}

/**
 * Formats a Date instance into a filesystem-safe ISO timestamp:
 * YYYY-MM-DDTHH-mm-ss-SSSZ
 */
export function formatBackupTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Lists all existing backup files for the specified database,
 * sorted descending by modification time (mtimeMs, newest first).
 */
export async function listDatabaseBackups(dbPath: string): Promise<string[]> {
  const resolvedDbPath = path.resolve(dbPath);
  const parentDir = path.dirname(resolvedDbPath);
  const baseName = path.basename(resolvedDbPath);
  const backupPrefix = `${baseName}.bak.`;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(parentDir, { withFileTypes: true });
  } catch (err: unknown) {
    const errorObj = err as { code?: string };
    if (errorObj.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const backupFiles: { name: string; fullPath: string; mtimeMs: number }[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith(backupPrefix)) {
      const fullPath = path.join(parentDir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        backupFiles.push({ name: entry.name, fullPath, mtimeMs: stat.mtimeMs });
      } catch (err: unknown) {
        const statErr = err as { code?: string };
        if (statErr.code !== "ENOENT") {
          throw err;
        }
      }
    }
  }

  backupFiles.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) {
      return b.mtimeMs - a.mtimeMs;
    }
    return b.name.localeCompare(a.name);
  });

  return backupFiles.map((f) => f.fullPath);
}

/**
 * Rotates database backup snapshots for a given database path:
 * 1. Reads the directory containing the database.
 * 2. Searches for files matching the prefix `${basename(dbPath)}.bak.`.
 * 3. Sorts backups descending by mtimeMs (newest to oldest).
 * 4. Asynchronously unlinks excess files beyond maxBackups (preserving at most maxBackups newest).
 * 5. Protects against concurrent deletion errors.
 *
 * @param dbPath Path to the target SQLite database.
 * @param maxBackups Maximum number of backup snapshots to preserve (defaults to 5).
 * @returns Array of file paths that were unlinked during rotation.
 */
export async function rotateDatabaseBackups(
  dbPath: string,
  maxBackups: number = 5
): Promise<string[]> {
  const resolvedDbPath = path.resolve(dbPath);
  const parentDir = path.dirname(resolvedDbPath);
  const baseName = path.basename(resolvedDbPath);
  const backupPrefix = `${baseName}.bak.`;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(parentDir, { withFileTypes: true });
  } catch (err: unknown) {
    const errorObj = err as { code?: string };
    if (errorObj.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const backupFiles: { name: string; fullPath: string; mtimeMs: number }[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith(backupPrefix)) {
      const fullPath = path.join(parentDir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        backupFiles.push({ name: entry.name, fullPath, mtimeMs: stat.mtimeMs });
      } catch (err: unknown) {
        // Guard against concurrent deletion between readdir and stat
        const statErr = err as { code?: string };
        if (statErr.code !== "ENOENT") {
          throw err;
        }
      }
    }
  }

  // Sort descending by mtimeMs (newest to oldest), name as tie-breaker
  backupFiles.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) {
      return b.mtimeMs - a.mtimeMs;
    }
    return b.name.localeCompare(a.name);
  });

  const deleted: string[] = [];

  if (maxBackups >= 0 && backupFiles.length > maxBackups) {
    const toDelete = backupFiles.slice(maxBackups);
    await Promise.all(
      toDelete.map(async (file) => {
        try {
          await fs.unlink(file.fullPath);
          deleted.push(file.fullPath);
        } catch (err: unknown) {
          // Guard against concurrent deletion (e.g. ENOENT)
          const unlinkErr = err as { code?: string };
          if (unlinkErr.code !== "ENOENT") {
            // Ignore concurrent deletion errors
          }
        }
      })
    );
  }

  return deleted;
}

/**
 * Creates a consistent hot backup snapshot of the SQLite database using `.backup '<target_path>'`.
 * Automatically names the backup using the filesystem-safe ISO format:
 * `${dbPath}.bak.${timestamp}` (YYYY-MM-DDTHH-mm-ss-SSSZ).
 * Automatically executes snapshot rotation to retain at most maxBackups (defaults to 5).
 *
 * @param dbPath Path to the SQLite database to backup.
 * @param options Backup options including maxBackups and busyTimeoutMs.
 * @returns Full path to the created backup snapshot.
 */
export async function createDatabaseBackup(
  dbPath: string,
  options?: BackupOptions
): Promise<string> {
  const maxBackups = options?.maxBackups ?? 5;
  const busyTimeoutMs = options?.busyTimeoutMs ?? 5000;
  const resolvedDbPath = path.resolve(dbPath);

  try {
    const stat = await fs.stat(resolvedDbPath);
    if (!stat.isFile()) {
      throw new DatabaseNotFoundError(
        `SQLite database path '${dbPath}' is not a regular file`,
        { details: { dbPath: resolvedDbPath } }
      );
    }
  } catch (err: unknown) {
    if (err instanceof DatabaseNotFoundError) {
      throw err;
    }
    const statErr = err as { code?: string };
    if (statErr.code === "ENOENT") {
      throw new DatabaseNotFoundError(
        `SQLite database file not found at '${dbPath}'`,
        { details: { dbPath: resolvedDbPath }, cause: err }
      );
    }
    throw err;
  }

  const timestamp = formatBackupTimestamp(new Date());
  const backupPath = `${resolvedDbPath}.bak.${timestamp}`;

  // Ensure destination directory exists
  await fs.mkdir(path.dirname(backupPath), { recursive: true });

  const escapedBackupPath = backupPath.replace(/'/g, "''");
  const args = [
    "-bail",
    "-cmd",
    `.timeout ${busyTimeoutMs}`,
    resolvedDbPath,
    `.backup '${escapedBackupPath}'`
  ];

  await retryAsync(
    async () => {
      try {
        await execFileAsync("sqlite3", args);
      } catch (err: unknown) {
        const errorObj = err as { code?: string; message?: string };
        if (errorObj.code === "ENOENT") {
          throw new SqliteCliNotFoundError();
        }
        if (isSqliteBusyError(err)) {
          throw err;
        }
        throw new SqliteExecutionError(
          `Failed to create SQLite backup: ${errorObj.message || String(err)}`,
          { details: { dbPath: resolvedDbPath, backupPath }, cause: err }
        );
      }
    },
    {
      maxAttempts: 5,
      minDelayMs: 50,
      maxDelayMs: 500,
      shouldRetry: isSqliteBusyError
    }
  );

  await rotateDatabaseBackups(resolvedDbPath, maxBackups);

  return backupPath;
}
