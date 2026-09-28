import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  BridgeError,
  SqliteBusyError,
  SqliteExecutionError,
  SqliteCliNotFoundError
} from "./errors.js";
import { isSqliteBusyError, retryAsync, type RetryOptions } from "./retry.js";
import { createDatabaseBackup, rotateDatabaseBackups } from "./backup.js";

export {
  BridgeError,
  SqliteBusyError,
  SqliteExecutionError,
  SqliteCliNotFoundError
};
export type { RetryOptions };

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export interface ExecFileAsyncOptions {
  input?: string | Buffer;
  maxBuffer?: number;
  timeout?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function execFileAsync(
  file: string,
  args: string[],
  options: ExecFileAsyncOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env,
      cwd: options.cwd,
      timeout: options.timeout,
      signal: options.signal
    });

    let stdout = "";
    let stderr = "";
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let finished = false;

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > maxBuffer && !finished) {
        finished = true;
        child.kill("SIGTERM");
        reject(new Error("stdout maxBuffer exceeded"));
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > maxBuffer && !finished) {
        finished = true;
        child.kill("SIGTERM");
        reject(new Error("stderr maxBuffer exceeded"));
      }
    });

    child.stdin.on("error", () => {});

    child.on("error", (err) => {
      if (!finished) {
        finished = true;
        reject(err);
      }
    });

    child.on("close", (code, signal) => {
      if (finished) return;
      finished = true;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`Command failed: ${file} ${args.join(" ")}\n${stderr}`);
        Object.assign(err, {
          code,
          signal,
          stdout,
          stderr
        });
        reject(err);
      }
    });

    if (options.input !== undefined && options.input !== null) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export function sanitizeSqlText(
  sql: string,
  options?: { escapeQuotes?: boolean }
): string {
  if (!sql) {
    return "";
  }
  let sanitized = sql.replace(/\0/g, "");
  if (options?.escapeQuotes) {
    sanitized = sanitized.replace(/'/g, "''");
  }
  return sanitized;
}

export function escapeSqlString(val: string): string {
  return sanitizeSqlText(val, { escapeQuotes: true });
}

export function mapSqliteError(err: unknown): BridgeError {
  if (err instanceof BridgeError) {
    return err;
  }

  const errorObj = err as {
    code?: unknown;
    message?: string;
    stderr?: string | Buffer;
    stdout?: string | Buffer;
  };

  if (errorObj?.code === "ENOENT") {
    return new SqliteCliNotFoundError(undefined, { cause: err });
  }

  const stderrStr =
    typeof errorObj?.stderr === "string"
      ? errorObj.stderr
      : errorObj?.stderr?.toString() ?? "";
  const stdoutStr =
    typeof errorObj?.stdout === "string"
      ? errorObj.stdout
      : errorObj?.stdout?.toString() ?? "";

  const trimmedStderr = stderrStr.trim();
  const baseMessage = trimmedStderr || errorObj?.message || "SQLite execution failed";

  if (isSqliteBusyError(err) || isSqliteBusyError(stderrStr)) {
    return new SqliteBusyError(trimmedStderr || "SQLite database is busy or locked", {
      details: { stderr: stderrStr, stdout: stdoutStr },
      cause: err
    });
  }

  return new SqliteExecutionError(baseMessage, {
    details: { stderr: stderrStr, stdout: stdoutStr },
    cause: err
  });
}

export interface SqliteClientOptions {
  busyTimeoutMs?: number;
  maxBackups?: number;
  retry?: boolean;
  retryOptions?: RetryOptions;
  wal?: boolean;
}

export class SqliteClient {
  public readonly dbPath: string;
  private busyTimeoutMs: number;
  private maxBackups: number;
  private retryEnabled: boolean;
  private defaultRetryOptions?: RetryOptions;
  private initPromise: Promise<void> | null = null;

  constructor(dbPath: string, options: SqliteClientOptions = {}) {
    this.dbPath = path.resolve(dbPath);
    this.busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    this.maxBackups = options.maxBackups ?? 5;
    this.retryEnabled = options.retry ?? true;
    this.defaultRetryOptions = options.retryOptions;

    if (options.wal ?? true) {
      this.initPromise = this.initPragmas().catch(() => {});
    }
  }

  public async initPragmas(): Promise<void> {
    const parentDir = path.dirname(this.dbPath);
    await fs.mkdir(parentDir, { recursive: true });

    const args = [
      "-bail",
      "-cmd",
      `.timeout ${this.busyTimeoutMs}`,
      this.dbPath
    ];

    const pragmaScript = [
      "PRAGMA journal_mode = WAL;",
      `PRAGMA busy_timeout = ${this.busyTimeoutMs};`
    ].join("\n");

    try {
      await execFileAsync("sqlite3", args, {
        input: sanitizeSqlText(pragmaScript),
        maxBuffer: DEFAULT_MAX_BUFFER
      });
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise.catch(() => {});
    }
  }

  public async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    await this.ensureInitialized();

    const args = [
      "-bail",
      "-cmd",
      `.timeout ${this.busyTimeoutMs}`,
      "-json",
      this.dbPath
    ];

    try {
      const { stdout } = await execFileAsync("sqlite3", args, {
        input: sanitizeSqlText(sql),
        maxBuffer: DEFAULT_MAX_BUFFER
      });
      const trimmed = stdout.trim();
      if (!trimmed) {
        return [];
      }
      return JSON.parse(trimmed) as T[];
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  public async exec(sql: string): Promise<void> {
    await this.ensureInitialized();

    const args = [
      "-bail",
      "-cmd",
      `.timeout ${this.busyTimeoutMs}`,
      this.dbPath
    ];

    try {
      await execFileAsync("sqlite3", args, {
        input: sanitizeSqlText(sql),
        maxBuffer: DEFAULT_MAX_BUFFER
      });
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  public async executeInTransaction(
    commands: string[],
    retryOptions?: RetryOptions
  ): Promise<void> {
    await this.ensureInitialized();

    const script = [
      "PRAGMA journal_mode = WAL;",
      `PRAGMA busy_timeout = ${this.busyTimeoutMs};`,
      "BEGIN IMMEDIATE;",
      ...commands,
      "COMMIT;"
    ].join("\n");

    const runScript = async (): Promise<void> => {
      const args = [
        "-bail",
        "-cmd",
        `.timeout ${this.busyTimeoutMs}`,
        this.dbPath
      ];

      try {
        await execFileAsync("sqlite3", args, {
          input: sanitizeSqlText(script),
          maxBuffer: DEFAULT_MAX_BUFFER
        });
      } catch (err) {
        throw mapSqliteError(err);
      }
    };

    if (!this.retryEnabled) {
      await runScript();
      return;
    }

    const effectiveRetryOptions: RetryOptions = {
      maxAttempts: 5,
      minDelayMs: 50,
      maxDelayMs: 500,
      ...this.defaultRetryOptions,
      ...retryOptions
    };

    await retryAsync(runScript, effectiveRetryOptions);
  }

  public async createBackup(): Promise<string> {
    await this.ensureInitialized();
    return createDatabaseBackup(this.dbPath, {
      maxBackups: this.maxBackups,
      busyTimeoutMs: this.busyTimeoutMs
    });
  }

  public async rotateBackups(): Promise<void> {
    await rotateDatabaseBackups(this.dbPath, this.maxBackups);
  }
}
