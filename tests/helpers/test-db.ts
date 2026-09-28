import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { SqliteClient, type SqliteClientOptions } from "../../src/sqlite.js";

const execFileAsync = promisify(execFile);

export const REQUIRED_WORK_TASK_INDEXES = [
  "idx_work_task_source_key",
  "idx_work_task_folder",
  "idx_work_task_status"
] as const;

export interface SchemaValidationResult {
  valid: boolean;
  missingIndexes: string[];
  existingIndexes: string[];
}

export interface TestDbInstance {
  dbPath: string;
  tempDir: string;
  cleanup: () => Promise<void>;
  query: <T = Record<string, unknown>>(sql: string) => Promise<T[]>;
  exec: (sql: string) => Promise<void>;
  getWalPath: () => string;
  getShmPath: () => string;
  isWalActive: () => Promise<boolean>;
  spawnRawClient: (options?: SqliteClientOptions) => SqliteClient;
  validateSchema: () => Promise<SchemaValidationResult>;
}

export interface CreateTestDatabaseOptions {
  wal?: boolean;
  validateSchema?: boolean;
}

export async function validateSchema(
  dbPathOrInstance: string | TestDbInstance
): Promise<SchemaValidationResult> {
  const dbPath = typeof dbPathOrInstance === "string" ? dbPathOrInstance : dbPathOrInstance.dbPath;
  const { stdout } = await execFileAsync("sqlite3", [
    dbPath,
    "-json",
    "SELECT name FROM sqlite_master WHERE type = 'index';"
  ]);
  const rows = stdout.trim() ? (JSON.parse(stdout) as { name: string }[]) : [];
  const existingIndexes = rows.map((r) => r.name);
  const missingIndexes = REQUIRED_WORK_TASK_INDEXES.filter(
    (idx) => !existingIndexes.includes(idx)
  );

  return {
    valid: missingIndexes.length === 0,
    missingIndexes,
    existingIndexes
  };
}

export async function simulateExternalLock(
  dbPath: string,
  durationMs: number
): Promise<() => void> {
  const resolvedDbPath = path.resolve(dbPath);

  return new Promise<() => void>((resolve, reject) => {
    const proc = spawn("sqlite3", [resolvedDbPath]);
    let acquired = false;
    let released = false;
    let timer: NodeJS.Timeout | null = null;
    let resolveClose: () => void;

    const closePromise = new Promise<void>((r) => {
      resolveClose = r;
    });

    const release = (): Promise<void> => {
      if (released) {
        return closePromise;
      }
      released = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      try {
        if (!proc.killed && proc.stdin && proc.stdin.writable) {
          proc.stdin.write("ROLLBACK;\n.quit\n");
          proc.stdin.end();
        } else if (!proc.killed) {
          proc.kill("SIGTERM");
        }
      } catch {
        try {
          proc.kill("SIGTERM");
        } catch {
        }
      }

      setTimeout(() => {
        if (!proc.killed) {
          try {
            proc.kill("SIGKILL");
          } catch {
          }
        }
      }, 500).unref();

      return closePromise;
    };

    proc.on("close", () => {
      resolveClose();
      if (!acquired) {
        reject(new Error("sqlite3 process closed before lock was acquired"));
      }
    });

    proc.on("error", (err) => {
      resolveClose();
      if (!acquired) {
        reject(err);
      }
    });

    proc.stdout.on("data", (data) => {
      if (!acquired && data.toString().includes("1")) {
        acquired = true;
        if (durationMs > 0 && Number.isFinite(durationMs)) {
          timer = setTimeout(() => {
            void release();
          }, durationMs);
          timer.unref();
        }
        resolve(release);
      }
    });

    proc.stderr.on("data", (data) => {
      if (!acquired) {
        reject(new Error(`Failed to acquire external lock: ${data.toString()}`));
      }
    });

    proc.stdin.write("BEGIN EXCLUSIVE;\nSELECT 1;\n");
  });
}

export async function createTestDatabase(
  options: CreateTestDatabaseOptions = {}
): Promise<TestDbInstance> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omo-codeg-test-"));
  const dbPath = path.join(tempDir, "test-codeg.db");
  const schemaPath = path.resolve(__dirname, "../fixtures/schema.sql");

  await execFileAsync("sqlite3", [dbPath, `.read ${schemaPath}`]);

  if (options.wal ?? true) {
    await execFileAsync("sqlite3", [dbPath, "PRAGMA journal_mode = WAL;"]);
  }

  if (options.validateSchema ?? true) {
    const validation = await validateSchema(dbPath);
    if (!validation.valid) {
      throw new Error(
        `Schema validation failed: missing indexes ${validation.missingIndexes.join(", ")}`
      );
    }
  }

  const exec = async (sql: string): Promise<void> => {
    await execFileAsync("sqlite3", [dbPath, sql]);
  };

  const query = async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
    const { stdout } = await execFileAsync("sqlite3", [dbPath, "-json", sql]);
    if (!stdout.trim()) {
      return [];
    }
    return JSON.parse(stdout) as T[];
  };

  const getWalPath = (): string => `${dbPath}-wal`;

  const getShmPath = (): string => `${dbPath}-shm`;

  const isWalActive = async (): Promise<boolean> => {
    try {
      const rows = await query<{ journal_mode: string }>("PRAGMA journal_mode;");
      if (rows[0]?.journal_mode?.toLowerCase() === "wal") {
        return true;
      }
    } catch {
    }

    try {
      await fs.access(getWalPath());
      return true;
    } catch {
      return false;
    }
  };

  const spawnRawClient = (clientOptions?: SqliteClientOptions): SqliteClient => {
    return new SqliteClient(dbPath, clientOptions);
  };

  const cleanup = async (): Promise<void> => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
    }
  };

  return {
    dbPath,
    tempDir,
    cleanup,
    query,
    exec,
    getWalPath,
    getShmPath,
    isWalActive,
    spawnRawClient,
    validateSchema: async () => validateSchema(dbPath)
  };
}
