/**
 * Base error class for all opencode-codeg-bridge errors.
 */
export class BridgeError extends Error {
  public readonly code: string;
  public readonly details?: unknown;
  public readonly remediation?: string;

  constructor(
    message: string,
    options?: {
      code?: string;
      details?: unknown;
      remediation?: string;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = options?.code ?? "ERR_BRIDGE";
    this.details = options?.details;
    this.remediation = options?.remediation;

    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }

    // Maintain proper prototype chain across transpilations
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Serializes error to a structured plain JSON object for CLI / IPC output.
   */
  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(this.remediation !== undefined ? { remediation: this.remediation } : {}),
      ...(this.stack !== undefined ? { stack: this.stack } : {})
    };
  }
}

/**
 * Thrown when sqlite3 CLI binary is missing on the host system.
 */
export class SqliteCliNotFoundError extends BridgeError {
  constructor(
    message = "sqlite3 command-line utility not found in PATH",
    options?: {
      details?: unknown;
      remediation?: string;
      cause?: unknown;
    }
  ) {
    const defaultRemediation =
      "Install sqlite3 CLI using your OS package manager: " +
      "'sudo apt-get install -y sqlite3' (Ubuntu/Debian), " +
      "'brew install sqlite' (macOS), or 'apk add sqlite' (Alpine).";

    super(message, {
      code: "ERR_CLI_NOT_FOUND",
      details: options?.details,
      remediation: options?.remediation ?? defaultRemediation,
      cause: options?.cause
    });
  }
}

/**
 * Thrown when SQLite database encounters SQLITE_BUSY or lock timeouts.
 */
export class SqliteBusyError extends BridgeError {
  constructor(
    message = "SQLite database is busy or locked by another process",
    options?: {
      details?: unknown;
      remediation?: string;
      cause?: unknown;
    }
  ) {
    const defaultRemediation =
      "Ensure no long-running transactions hold the database lock. Verify busy_timeout configuration or retry the operation.";

    super(message, {
      code: "ERR_SQLITE_BUSY",
      details: options?.details,
      remediation: options?.remediation ?? defaultRemediation,
      cause: options?.cause
    });
  }
}

/**
 * Thrown when an SQL query or script execution fails.
 */
export class SqliteExecutionError extends BridgeError {
  constructor(
    message: string,
    options?: {
      details?: unknown;
      remediation?: string;
      cause?: unknown;
    }
  ) {
    super(message, {
      code: "ERR_SQLITE_EXEC",
      details: options?.details,
      remediation:
        options?.remediation ??
        "Check SQL syntax, table schema migrations, column names, and constraint invariants.",
      cause: options?.cause
    });
  }
}

/**
 * Thrown when parsing a plan markdown file fails due to invalid syntax or formatting.
 */
export class PlanParseError extends BridgeError {
  constructor(
    message: string,
    options?: {
      details?: unknown;
      remediation?: string;
      cause?: unknown;
    }
  ) {
    super(message, {
      code: "ERR_PLAN_PARSE",
      details: options?.details,
      remediation:
        options?.remediation ??
        "Ensure the plan markdown file contains valid markdown task lists (- [ ] Task description) and proper wave headers (# Wave N).",
      cause: options?.cause
    });
  }
}

/**
 * Thrown when the specified plan markdown file cannot be found.
 */
export class PlanNotFoundError extends BridgeError {
  constructor(
    message: string,
    options?: {
      details?: unknown;
      remediation?: string;
      cause?: unknown;
    }
  ) {
    super(message, {
      code: "ERR_PLAN_NOT_FOUND",
      details: options?.details,
      remediation:
        options?.remediation ??
        "Specify a valid plan path using -p / --plan or ensure a markdown plan exists in .omo/plans/.",
      cause: options?.cause
    });
  }
}

/**
 * Thrown when the target workspace folder cannot be found in Codeg database or filesystem.
 */
export class FolderNotFoundError extends BridgeError {
  constructor(
    message: string,
    options?: {
      details?: unknown;
      remediation?: string;
      cause?: unknown;
    }
  ) {
    super(message, {
      code: "ERR_FOLDER_NOT_FOUND",
      details: options?.details,
      remediation:
        options?.remediation ??
        "Verify CODEG_WORKSPACE environment variable or ensure current working directory is a valid registered folder in Codeg.",
      cause: options?.cause
    });
  }
}

/**
 * Thrown when the Codeg SQLite database file is missing or inaccessible.
 */
export class DatabaseNotFoundError extends BridgeError {
  constructor(
    message: string,
    options?: {
      details?: unknown;
      remediation?: string;
      cause?: unknown;
    }
  ) {
    super(message, {
      code: "ERR_DATABASE_NOT_FOUND",
      details: options?.details,
      remediation:
        options?.remediation ??
        "Verify CODEG_DB_PATH environment variable or ensure Codeg data directory exists (~/.local/share/codeg/ or OS equivalent).",
      cause: options?.cause
    });
  }
}

/**
 * Thrown when a task status transition violates defined state machine invariants.
 */
export class StatusInvariantViolationError extends BridgeError {
  constructor(
    message: string,
    options?: {
      details?: unknown;
      remediation?: string;
      cause?: unknown;
    }
  ) {
    super(message, {
      code: "ERR_STATUS_INVARIANT",
      details: options?.details,
      remediation:
        options?.remediation ??
        "Verify that task status transitions adhere to valid state machine transitions in Codeg.",
      cause: options?.cause
    });
  }
}
