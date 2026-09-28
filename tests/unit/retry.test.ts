import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  retryAsync,
  isSqliteBusyError,
  SqliteBusyError,
  calculateDelay,
  type RetryOptions
} from "../../src/retry.js";

describe("retryAsync utility", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("SqliteBusyError", () => {
    it("instantiates with default message and correct properties", () => {
      const err = new SqliteBusyError();
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(SqliteBusyError);
      expect(err.name).toBe("SqliteBusyError");
      expect(err.message).toContain("busy or locked");
      expect(err.cause).toBeUndefined();
    });

    it("preserves custom message and cause", () => {
      const original = new Error("original lock");
      const err = new SqliteBusyError("Custom busy message", { cause: original });
      expect(err.message).toBe("Custom busy message");
      expect(err.cause).toBe(original);
    });
  });

  describe("isSqliteBusyError", () => {
    it("returns false for non-error or empty values", () => {
      expect(isSqliteBusyError(null)).toBe(false);
      expect(isSqliteBusyError(undefined)).toBe(false);
      expect(isSqliteBusyError("")).toBe(false);
      expect(isSqliteBusyError(0)).toBe(false);
      expect(isSqliteBusyError({})).toBe(false);
      expect(isSqliteBusyError({ message: "" })).toBe(false);
      expect(isSqliteBusyError(new Error("Generic error"))).toBe(false);
    });

    it("returns true for SqliteBusyError instance", () => {
      expect(isSqliteBusyError(new SqliteBusyError())).toBe(true);
    });

    it("detects substrings in message, stderr, stdout, or string error", () => {
      expect(isSqliteBusyError("database is locked")).toBe(true);
      expect(isSqliteBusyError("DATABASE IS LOCKED")).toBe(true);
      expect(isSqliteBusyError("busy")).toBe(true);
      expect(isSqliteBusyError("SQLITE_BUSY")).toBe(true);
      expect(isSqliteBusyError("sqlite_busy")).toBe(true);

      expect(isSqliteBusyError(new Error("Error: database is locked"))).toBe(true);
      expect(isSqliteBusyError(new Error("Sqlite database is busy"))).toBe(true);
      expect(isSqliteBusyError(new Error("Code: SQLITE_BUSY"))).toBe(true);

      expect(isSqliteBusyError({ stderr: "sqlite3: database is locked" })).toBe(true);
      expect(isSqliteBusyError({ stdout: "busy signal received" })).toBe(true);
    });

    it("detects SQLite busy/locked numeric error codes and errno", () => {
      expect(isSqliteBusyError({ code: 5 })).toBe(true);
      expect(isSqliteBusyError({ code: 6 })).toBe(true);
      expect(isSqliteBusyError({ errno: 5 })).toBe(true);
      expect(isSqliteBusyError({ errno: 6 })).toBe(true);
      expect(isSqliteBusyError({ extendedCode: 261 })).toBe(true);
      expect(isSqliteBusyError({ extendedCode: 517 })).toBe(true);
      expect(isSqliteBusyError({ extendedCode: 773 })).toBe(true);
      expect(isSqliteBusyError({ extendedCode: 262 })).toBe(true);
      expect(isSqliteBusyError({ extendedCode: 518 })).toBe(true);

      expect(isSqliteBusyError({ code: 1 })).toBe(false);
      expect(isSqliteBusyError({ errno: 2 })).toBe(false);
      expect(isSqliteBusyError({ extendedCode: 999 })).toBe(false);
    });

    it("detects SQLite busy/locked string error codes", () => {
      expect(isSqliteBusyError({ code: "SQLITE_BUSY" })).toBe(true);
      expect(isSqliteBusyError({ code: "sqlite_busy" })).toBe(true);
      expect(isSqliteBusyError({ code: "SQLITE_LOCKED" })).toBe(true);
      expect(isSqliteBusyError({ code: "SQLITE_BUSY_RECOVERY" })).toBe(true);
      expect(isSqliteBusyError({ code: "SQLITE_BUSY_SNAPSHOT" })).toBe(true);
      expect(isSqliteBusyError({ code: "SQLITE_BUSY_TIMEOUT" })).toBe(true);
      expect(isSqliteBusyError({ code: "SQLITE_LOCKED_SHAREDCACHE" })).toBe(true);
      expect(isSqliteBusyError({ code: "SQLITE_LOCKED_VTAB" })).toBe(true);

      expect(isSqliteBusyError({ code: "ENOENT" })).toBe(false);
      expect(isSqliteBusyError({ code: "SQLITE_ERROR" })).toBe(false);
    });
  });

  describe("calculateDelay", () => {
    it("computes exponential delay plus randomized jitter correctly", () => {
      const minDelayMs = 50;
      const maxDelayMs = 500;

      // With random = 0 (no jitter)
      expect(calculateDelay(0, minDelayMs, maxDelayMs, () => 0)).toBe(50);
      expect(calculateDelay(1, minDelayMs, maxDelayMs, () => 0)).toBe(100);
      expect(calculateDelay(2, minDelayMs, maxDelayMs, () => 0)).toBe(200);
      expect(calculateDelay(3, minDelayMs, maxDelayMs, () => 0)).toBe(400);
      // Cap at maxDelayMs
      expect(calculateDelay(4, minDelayMs, maxDelayMs, () => 0)).toBe(500);
      expect(calculateDelay(5, minDelayMs, maxDelayMs, () => 0)).toBe(500);

      // With random = 1 (max jitter = minDelayMs / 2 = 25)
      expect(calculateDelay(0, minDelayMs, maxDelayMs, () => 1)).toBe(75);
      expect(calculateDelay(1, minDelayMs, maxDelayMs, () => 1)).toBe(125);
      expect(calculateDelay(3, minDelayMs, maxDelayMs, () => 1)).toBe(425);
      expect(calculateDelay(4, minDelayMs, maxDelayMs, () => 1)).toBe(525);
    });

    it("uses default Math.random when random function is omitted", () => {
      vi.spyOn(Math, "random").mockReturnValue(0.4);
      const delay = calculateDelay(0, 100, 1000);
      expect(delay).toBe(100 + 0.4 * 50);
    });
  });

  describe("retryAsync", () => {
    it("succeeds on first attempt without delay or retry", async () => {
      const fn = vi.fn().mockResolvedValue("immediate success");
      const sleep = vi.fn().mockResolvedValue(undefined);

      const result = await retryAsync(fn, { sleep });

      expect(result).toBe("immediate success");
      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("succeeds after N failures simulating temporary SQLite busy contention", async () => {
      const busyError = new Error("SQLITE_BUSY: database is locked");
      let attemptsCount = 0;
      const fn = vi.fn().mockImplementation(async () => {
        attemptsCount++;
        if (attemptsCount <= 3) {
          throw busyError;
        }
        return `success on attempt ${attemptsCount}`;
      });

      const sleepDelays: number[] = [];
      const sleep = vi.fn().mockImplementation(async (ms: number) => {
        sleepDelays.push(ms);
      });

      const result = await retryAsync(fn, {
        maxAttempts: 5,
        minDelayMs: 50,
        maxDelayMs: 500,
        sleep
      });

      expect(result).toBe("success on attempt 4");
      expect(fn).toHaveBeenCalledTimes(4);
      expect(sleep).toHaveBeenCalledTimes(3);
      expect(sleepDelays).toHaveLength(3);
    });

    it("throws immediately on non-retryable error without retrying", async () => {
      const fatalError = new Error("Table users does not exist");
      const fn = vi.fn().mockRejectedValue(fatalError);
      const sleep = vi.fn().mockResolvedValue(undefined);

      await expect(retryAsync(fn, { sleep })).rejects.toThrow("Table users does not exist");
      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("supports custom shouldRetry predicate", async () => {
      const customError = { message: "custom transient error" };
      let count = 0;
      const fn = vi.fn().mockImplementation(async () => {
        count++;
        if (count < 2) {
          throw customError;
        }
        return "custom retry success";
      });
      const sleep = vi.fn().mockResolvedValue(undefined);

      const result = await retryAsync(fn, {
        shouldRetry: (err) => (err as { message?: string })?.message === "custom transient error",
        sleep
      });

      expect(result).toBe("custom retry success");
      expect(fn).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it("throws SqliteBusyError preserving cause after exhausting all 5 attempts with correct delays", async () => {
      const busyError = new Error("database is locked");
      const fn = vi.fn().mockRejectedValue(busyError);

      const capturedDelays: number[] = [];
      const sleep = vi.fn().mockImplementation(async (ms: number) => {
        capturedDelays.push(ms);
      });

      // Mock random to fixed 0 for deterministic delay verification
      vi.spyOn(Math, "random").mockReturnValue(0);

      const options: RetryOptions = {
        maxAttempts: 5,
        minDelayMs: 50,
        maxDelayMs: 500,
        sleep
      };

      let thrownError: unknown;
      try {
        await retryAsync(fn, options);
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(SqliteBusyError);
      const busyErr = thrownError as SqliteBusyError;
      expect(busyErr.name).toBe("SqliteBusyError");
      expect(busyErr.message).toContain("after 5 attempts");
      expect(busyErr.cause).toBe(busyError);

      expect(fn).toHaveBeenCalledTimes(5);
      expect(sleep).toHaveBeenCalledTimes(4);

      // Delays for attempt 0, 1, 2, 3 with minDelayMs=50, maxDelayMs=500, random=0:
      // 0: min(500, 50 * 1) + 0 = 50
      // 1: min(500, 50 * 2) + 0 = 100
      // 2: min(500, 50 * 4) + 0 = 200
      // 3: min(500, 50 * 8) + 0 = 400
      expect(capturedDelays).toEqual([50, 100, 200, 400]);
    });

    it("uses default options (maxAttempts 5, minDelayMs 50, maxDelayMs 500) and default sleep", async () => {
      vi.useFakeTimers();
      try {
        const busyError = new Error("SQLITE_BUSY");
        let calls = 0;
        const fn = vi.fn().mockImplementation(async () => {
          calls++;
          if (calls < 2) {
            throw busyError;
          }
          return "ok after 1 retry";
        });

        const promise = retryAsync(fn);

        // Advance timers to trigger the sleep timeout
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe("ok after 1 retry");
        expect(calls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("throws SqliteBusyError immediately if maxAttempts is 0 or negative", async () => {
      const fn = vi.fn().mockResolvedValue("never called");
      await expect(retryAsync(fn, { maxAttempts: 0 })).rejects.toThrow(SqliteBusyError);
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
