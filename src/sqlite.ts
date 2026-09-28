import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDatabaseBackup, rotateDatabaseBackups } from "./backup.js";

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
    return createDatabaseBackup(this.dbPath, {
      maxBackups: this.maxBackups,
      busyTimeoutMs: this.busyTimeoutMs
    });
  }

  public async rotateBackups(): Promise<void> {
    await rotateDatabaseBackups(this.dbPath, this.maxBackups);
  }
}
