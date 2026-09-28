import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TestDbInstance {
  dbPath: string;
  tempDir: string;
  cleanup: () => Promise<void>;
  query: <T = Record<string, unknown>>(sql: string) => Promise<T[]>;
  exec: (sql: string) => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDbInstance> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omo-codeg-test-"));
  const dbPath = path.join(tempDir, "test-codeg.db");
  const schemaPath = path.resolve(__dirname, "../fixtures/schema.sql");
  const schemaSql = await fs.readFile(schemaPath, "utf-8");

  await execFileAsync("sqlite3", [dbPath, `.read ${schemaPath}`]);

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

  const cleanup = async (): Promise<void> => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore errors on cleanup
    }
  };

  return {
    dbPath,
    tempDir,
    cleanup,
    query,
    exec
  };
}
