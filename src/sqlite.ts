import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SqliteClientOptions {
  busyTimeoutMs?: number;
  maxBackups?: number;
}

export class SqliteClient {
  public readonly dbPath: string;
  private busyTimeoutMs: number;
  private maxBackups: number;

  constructor(dbPath: string, options: SqliteClientOptions = {}) {
    this.dbPath = path.resolve(dbPath);
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    this.maxBackups = options.maxBackups ?? 5;
  }

  public async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const args = [
      "-bail",
      "-cmd",
      `.timeout ${this.busyTimeoutMs}`,
      "-json",
      this.dbPath,
      sql
    ];

    const { stdout } = await execFileAsync("sqlite3", args);
    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }
    return JSON.parse(trimmed) as T[];
  }

  public async exec(sql: string): Promise<void> {
    const args = [
      "-bail",
      "-cmd",
      `.timeout ${this.busyTimeoutMs}`,
      this.dbPath,
      sql
    ];

    await execFileAsync("sqlite3", args);
  }

  public async executeInTransaction(commands: string[]): Promise<void> {
    const script = [
      "PRAGMA journal_mode = WAL;",
      "BEGIN IMMEDIATE;",
      ...commands,
      "COMMIT;"
    ].join("\n");

    const args = [
      "-bail",
      "-cmd",
      `.timeout ${this.busyTimeoutMs}`,
      this.dbPath,
      script
    ];

    await execFileAsync("sqlite3", args);
  }

  public async createBackup(): Promise<string> {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    const backupPath = `${this.dbPath}.bak.${timestamp}`;

    const args = [
      "-bail",
      "-cmd",
      `.timeout ${this.busyTimeoutMs}`,
      this.dbPath,
      `.backup '${backupPath}'`
    ];

    await execFileAsync("sqlite3", args);
    await this.rotateBackups();
    return backupPath;
  }

  public async rotateBackups(): Promise<void> {
    const parentDir = path.dirname(this.dbPath);
    const baseName = path.basename(this.dbPath);
    const backupPrefix = `${baseName}.bak.`;

    const entries = await fs.readdir(parentDir, { withFileTypes: true });
    const backupFiles: { name: string; fullPath: string; mtime: number }[] = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith(backupPrefix)) {
        const fullPath = path.join(parentDir, entry.name);
        const stat = await fs.stat(fullPath);
        backupFiles.push({ name: entry.name, fullPath, mtime: stat.mtimeMs });
      }
    }

    backupFiles.sort((a, b) => b.mtime - a.mtime);

    if (backupFiles.length > this.maxBackups) {
      const toDelete = backupFiles.slice(this.maxBackups);
      for (const item of toDelete) {
        try {
          await fs.unlink(item.fullPath);
        } catch {
          // ignore unlink error
        }
      }
    }
  }
}
