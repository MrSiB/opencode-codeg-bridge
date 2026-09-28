import { SqliteBusyError } from "./errors.js";

export { SqliteBusyError };

export interface RetryOptions {
  maxAttempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const SQLITE_BUSY_CODES = new Set<string | number>([
  "SQLITE_BUSY",
  "SQLITE_BUSY_RECOVERY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_BUSY_TIMEOUT",
  "SQLITE_LOCKED",
  "SQLITE_LOCKED_SHAREDCACHE",
  "SQLITE_LOCKED_VTAB",
  5, // SQLITE_BUSY
  6, // SQLITE_LOCKED
  261, // SQLITE_BUSY_RECOVERY
  517, // SQLITE_BUSY_SNAPSHOT
  773, // SQLITE_BUSY_TIMEOUT
  262, // SQLITE_LOCKED_SHAREDCACHE
  518, // SQLITE_LOCKED_VTAB
]);

export function isSqliteBusyError(err: unknown): boolean {
  if (!err) {
    return false;
  }

  if (err instanceof SqliteBusyError) {
    return true;
  }

  if (typeof err === "object") {
    const errorObj = err as {
      code?: unknown;
      errno?: unknown;
      extendedCode?: unknown;
    };

    if (typeof errorObj.code === "string" && SQLITE_BUSY_CODES.has(errorObj.code.toUpperCase())) {
      return true;
    }
    if (typeof errorObj.code === "number" && SQLITE_BUSY_CODES.has(errorObj.code)) {
      return true;
    }
    if (typeof errorObj.errno === "number" && SQLITE_BUSY_CODES.has(errorObj.errno)) {
      return true;
    }
    if (typeof errorObj.extendedCode === "number" && SQLITE_BUSY_CODES.has(errorObj.extendedCode)) {
      return true;
    }
  }

  let text = "";
  if (typeof err === "string") {
    text = err;
  } else if (typeof err === "object") {
    const errorObj = err as {
      message?: unknown;
      stderr?: unknown;
      stdout?: unknown;
    };
    const parts: string[] = [];
    if (typeof errorObj.message === "string") parts.push(errorObj.message);
    if (typeof errorObj.stderr === "string") parts.push(errorObj.stderr);
    if (typeof errorObj.stdout === "string") parts.push(errorObj.stdout);
    text = parts.join(" ");
  }

  if (!text) {
    return false;
  }

  const lower = text.toLowerCase();
  return (
    lower.includes("database is locked") ||
    lower.includes("busy") ||
    text.includes("SQLITE_BUSY") ||
    lower.includes("sqlite_busy")
  );
}

export function calculateDelay(
  attempt: number,
  minDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random
): number {
  return Math.min(maxDelayMs, minDelayMs * 2 ** attempt) + random() * (minDelayMs / 2);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryAsync<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 5;
  const minDelayMs = options?.minDelayMs ?? 50;
  const maxDelayMs = options?.maxDelayMs ?? 500;
  const shouldRetry = options?.shouldRetry ?? isSqliteBusyError;
  const sleep = options?.sleep ?? defaultSleep;

  if (maxAttempts <= 0) {
    throw new SqliteBusyError(
      `SQLite database is busy or locked after ${maxAttempts} attempts`
    );
  }

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!shouldRetry(err)) {
        throw err;
      }

      attempt++;
      if (attempt >= maxAttempts) {
        throw new SqliteBusyError(
          `SQLite database is busy or locked after ${maxAttempts} attempts`,
          { cause: err }
        );
      }

      const delay = calculateDelay(attempt - 1, minDelayMs, maxDelayMs, Math.random);
      await sleep(delay);
    }
  }
}
