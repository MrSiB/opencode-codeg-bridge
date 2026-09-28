import { describe, it, expect } from "vitest";
import {
  BridgeError,
  SqliteCliNotFoundError,
  SqliteBusyError,
  SqliteExecutionError,
  PlanParseError,
  PlanNotFoundError,
  FolderNotFoundError,
  DatabaseNotFoundError,
  StatusInvariantViolationError
} from "../../src/errors.js";

describe("BridgeError Hierarchy and Specifications", () => {
  describe("BridgeError Base Class", () => {
    it("should instantiate with standard Error properties", () => {
      const err = new BridgeError("Something went wrong");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err.name).toBe("BridgeError");
      expect(err.message).toBe("Something went wrong");
      expect(err.code).toBe("ERR_BRIDGE");
      expect(err.details).toBeUndefined();
      expect(err.remediation).toBeUndefined();
      expect(err.stack).toBeDefined();
    });

    it("should accept custom code, details, remediation, and cause", () => {
      const causeErr = new Error("Underlying IO error");
      const err = new BridgeError("Failed operation", {
        code: "ERR_CUSTOM_OP",
        details: { file: "test.md", line: 42 },
        remediation: "Check permissions",
        cause: causeErr
      });

      expect(err.code).toBe("ERR_CUSTOM_OP");
      expect(err.details).toEqual({ file: "test.md", line: 42 });
      expect(err.remediation).toBe("Check permissions");
      expect(err.cause).toBe(causeErr);
    });

    it("should serialize properly to JSON via toJSON()", () => {
      const err = new BridgeError("Operation timeout", {
        code: "ERR_TIMEOUT",
        details: { timeoutMs: 5000 },
        remediation: "Increase timeout limit"
      });

      const json = err.toJSON();
      expect(json.name).toBe("BridgeError");
      expect(json.code).toBe("ERR_TIMEOUT");
      expect(json.message).toBe("Operation timeout");
      expect(json.details).toEqual({ timeoutMs: 5000 });
      expect(json.remediation).toBe("Increase timeout limit");
      expect(json.stack).toBeDefined();

      const stringified = JSON.stringify(err);
      const parsed = JSON.parse(stringified);
      expect(parsed.name).toBe("BridgeError");
      expect(parsed.code).toBe("ERR_TIMEOUT");
      expect(parsed.message).toBe("Operation timeout");
      expect(parsed.details).toEqual({ timeoutMs: 5000 });
      expect(parsed.remediation).toBe("Increase timeout limit");
    });
  });

  describe("SqliteCliNotFoundError", () => {
    it("should inherit from BridgeError and Error with code ERR_CLI_NOT_FOUND", () => {
      const err = new SqliteCliNotFoundError();
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err).toBeInstanceOf(SqliteCliNotFoundError);
      expect(err.name).toBe("SqliteCliNotFoundError");
      expect(err.code).toBe("ERR_CLI_NOT_FOUND");
      expect(err.message).toContain("sqlite3 command-line utility not found");
      expect(err.remediation).toContain("apt-get install");
      expect(err.remediation).toContain("brew install");
    });

    it("should allow overriding message and remediation", () => {
      const err = new SqliteCliNotFoundError("Custom binary missing", {
        remediation: "Custom remediation guide",
        details: { binary: "sqlite3" }
      });
      expect(err.message).toBe("Custom binary missing");
      expect(err.remediation).toBe("Custom remediation guide");
      expect(err.details).toEqual({ binary: "sqlite3" });
      expect(err.code).toBe("ERR_CLI_NOT_FOUND");
    });
  });

  describe("SqliteBusyError", () => {
    it("should inherit from BridgeError with code ERR_SQLITE_BUSY", () => {
      const err = new SqliteBusyError();
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err).toBeInstanceOf(SqliteBusyError);
      expect(err.name).toBe("SqliteBusyError");
      expect(err.code).toBe("ERR_SQLITE_BUSY");
      expect(err.message).toContain("busy or locked");
      expect(err.remediation).toContain("busy_timeout");
    });

    it("should serialize with custom details and cause", () => {
      const cause = new Error("SQLITE_BUSY: database is locked");
      const err = new SqliteBusyError("Database locked during write", {
        details: { table: "work_task", attempts: 5 },
        cause
      });
      expect(err.code).toBe("ERR_SQLITE_BUSY");
      expect(err.details).toEqual({ table: "work_task", attempts: 5 });
      expect(err.cause).toBe(cause);
      const json = err.toJSON();
      expect(json.code).toBe("ERR_SQLITE_BUSY");
      expect(json.details).toEqual({ table: "work_task", attempts: 5 });
    });
  });

  describe("SqliteExecutionError", () => {
    it("should inherit from BridgeError with code ERR_SQLITE_EXEC", () => {
      const err = new SqliteExecutionError("syntax error in SQL statement", {
        details: { query: "SELEC * FROM folder;" }
      });
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err).toBeInstanceOf(SqliteExecutionError);
      expect(err.name).toBe("SqliteExecutionError");
      expect(err.code).toBe("ERR_SQLITE_EXEC");
      expect(err.message).toBe("syntax error in SQL statement");
      expect(err.remediation).toBeDefined();
      expect(err.details).toEqual({ query: "SELEC * FROM folder;" });
    });
  });

  describe("PlanParseError", () => {
    it("should inherit from BridgeError with code ERR_PLAN_PARSE", () => {
      const err = new PlanParseError("Failed to parse plan structure", {
        details: { planPath: "/path/to/plan.md", line: 15 }
      });
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err).toBeInstanceOf(PlanParseError);
      expect(err.name).toBe("PlanParseError");
      expect(err.code).toBe("ERR_PLAN_PARSE");
      expect(err.message).toBe("Failed to parse plan structure");
      expect(err.remediation).toContain("markdown task lists");
      expect(err.details).toEqual({ planPath: "/path/to/plan.md", line: 15 });
    });
  });

  describe("PlanNotFoundError", () => {
    it("should inherit from BridgeError with code ERR_PLAN_NOT_FOUND", () => {
      const err = new PlanNotFoundError("Plan file not found: non-existent.md", {
        details: { searchedPaths: [".omo/plans/non-existent.md"] }
      });
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err).toBeInstanceOf(PlanNotFoundError);
      expect(err.name).toBe("PlanNotFoundError");
      expect(err.code).toBe("ERR_PLAN_NOT_FOUND");
      expect(err.message).toContain("Plan file not found");
      expect(err.remediation).toContain("--plan");
      expect(err.details).toEqual({ searchedPaths: [".omo/plans/non-existent.md"] });
    });
  });

  describe("FolderNotFoundError", () => {
    it("should inherit from BridgeError with code ERR_FOLDER_NOT_FOUND", () => {
      const err = new FolderNotFoundError("Codeg folder record not found", {
        details: { workspacePath: "/workspace/unknown" }
      });
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err).toBeInstanceOf(FolderNotFoundError);
      expect(err.name).toBe("FolderNotFoundError");
      expect(err.code).toBe("ERR_FOLDER_NOT_FOUND");
      expect(err.message).toBe("Codeg folder record not found");
      expect(err.remediation).toContain("CODEG_WORKSPACE");
      expect(err.details).toEqual({ workspacePath: "/workspace/unknown" });
    });
  });

  describe("DatabaseNotFoundError", () => {
    it("should inherit from BridgeError with code ERR_DATABASE_NOT_FOUND", () => {
      const err = new DatabaseNotFoundError("Codeg database not found at /path/db.sqlite", {
        details: { dbPath: "/path/db.sqlite" }
      });
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err).toBeInstanceOf(DatabaseNotFoundError);
      expect(err.name).toBe("DatabaseNotFoundError");
      expect(err.code).toBe("ERR_DATABASE_NOT_FOUND");
      expect(err.message).toContain("Codeg database not found");
      expect(err.remediation).toContain("CODEG_DB_PATH");
      expect(err.details).toEqual({ dbPath: "/path/db.sqlite" });
    });
  });

  describe("StatusInvariantViolationError", () => {
    it("should inherit from BridgeError with code ERR_STATUS_INVARIANT", () => {
      const err = new StatusInvariantViolationError(
        "Invalid transition from 'done' to 'todo'",
        {
          details: { from: "done", to: "todo", taskId: 123 }
        }
      );
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err).toBeInstanceOf(StatusInvariantViolationError);
      expect(err.name).toBe("StatusInvariantViolationError");
      expect(err.code).toBe("ERR_STATUS_INVARIANT");
      expect(err.message).toBe("Invalid transition from 'done' to 'todo'");
      expect(err.remediation).toContain("state machine transitions");
      expect(err.details).toEqual({ from: "done", to: "todo", taskId: 123 });
    });
  });

  describe("Type and Subclass Discrimination", () => {
    it("should catch specialized errors with instanceof in try/catch blocks", () => {
      function throwError(type: string): never {
        if (type === "cli") throw new SqliteCliNotFoundError();
        if (type === "busy") throw new SqliteBusyError();
        if (type === "exec") throw new SqliteExecutionError("SQL fail");
        if (type === "parse") throw new PlanParseError("Parse fail");
        if (type === "plan_not_found") throw new PlanNotFoundError("Plan not found");
        if (type === "folder_not_found") throw new FolderNotFoundError("Folder not found");
        if (type === "db_not_found") throw new DatabaseNotFoundError("DB not found");
        if (type === "status") throw new StatusInvariantViolationError("Status fail");
        throw new BridgeError("Generic bridge error");
      }

      const types = [
        { type: "cli", expectedClass: SqliteCliNotFoundError, expectedCode: "ERR_CLI_NOT_FOUND" },
        { type: "busy", expectedClass: SqliteBusyError, expectedCode: "ERR_SQLITE_BUSY" },
        { type: "exec", expectedClass: SqliteExecutionError, expectedCode: "ERR_SQLITE_EXEC" },
        { type: "parse", expectedClass: PlanParseError, expectedCode: "ERR_PLAN_PARSE" },
        { type: "plan_not_found", expectedClass: PlanNotFoundError, expectedCode: "ERR_PLAN_NOT_FOUND" },
        { type: "folder_not_found", expectedClass: FolderNotFoundError, expectedCode: "ERR_FOLDER_NOT_FOUND" },
        { type: "db_not_found", expectedClass: DatabaseNotFoundError, expectedCode: "ERR_DATABASE_NOT_FOUND" },
        { type: "status", expectedClass: StatusInvariantViolationError, expectedCode: "ERR_STATUS_INVARIANT" },
        { type: "other", expectedClass: BridgeError, expectedCode: "ERR_BRIDGE" }
      ];

      for (const item of types) {
        try {
          throwError(item.type);
        } catch (e: unknown) {
          expect(e).toBeInstanceOf(BridgeError);
          expect(e).toBeInstanceOf(item.expectedClass);
          if (e instanceof BridgeError) {
            expect(e.code).toBe(item.expectedCode);
          }
        }
      }
    });
  });
});
