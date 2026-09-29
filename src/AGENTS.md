# SRC MODULE KNOWLEDGE BASE

## OVERVIEW
Core domain engine providing zero-native SQLite synchronization between OmO plans and Codeg task state.

## WHERE TO LOOK
| Module/File | Responsibility | Key Exports |
|---|---|---|
| src/backup.ts | Database backup creation, rotation, timestamp formatting | createDatabaseBackup, rotateDatabaseBackups, listDatabaseBackups, formatBackupTimestamp |
| src/cli.ts | CLI commands, argument handling, doctor health diagnostics | runCli, runDoctorChecks |
| src/discovery.ts | Workspace root resolution, Codeg DB detection, plan discovery | discoverEnvironment, findCodegDatabase, resolveWorkspaceFolder, findPlanFile |
| src/errors.ts | Domain error hierarchy, structured CLI error formatting | BridgeError, SqliteCliNotFoundError, SqliteBusyError, SqliteExecutionError, PlanNotFoundError |
| src/index.ts | Public library barrel re-exporting bridge modules | opencodeCodegBridgePlugin, all submodules |
| src/parser.ts | Plan markdown AST parsing, NFKD slugification, deterministic source key hashing | parseMarkdownPlan, calculateSourceKey, parseSourceKey, slugify |
| src/plugin.ts | OpenCode plugin registration, codeg_sync_plan tool definition | opencodeCodegBridgePlugin, formatErrorOutput |
| src/retry.ts | Exponential backoff with jitter for busy SQLite locks | retryAsync, isSqliteBusyError, calculateDelay |
| src/sqlite.ts | Zero-native child_process client wrapping sqlite3 CLI with stdin piping | SqliteClient, execFileAsync, sanitizeSqlText, escapeSqlString |
| src/sync.ts | Plan diffing, transaction batches, status preservation, folder mapping | syncPlanToCodeg, computePlanDiff, findFolder, findOrCreateFolder, escapeSql |
| src/types.ts | Domain data contracts, task statuses, preserved status sets | PRESERVED_STATUSES, TaskStatus, TaskKind, ParsedPlan, TaskDiff, SyncResult |

## CONVENTIONS
- Zero-native execution: Queries run through system sqlite3 CLI via child_process spawn. Don't add native C++ bindings or node-gyp dependencies.
- stdin query piping: Feed SQL via process stdin using -bail and .timeout pragmas. Avoid shell argument size limits and command line process listing leaks.
- Atomic transactions: Group mutations inside BEGIN IMMEDIATE and COMMIT blocks in executeInTransaction(). Apply exponential backoff with random jitter on SQLITE_BUSY locks.
- Status preservation rules: Respect PRESERVED_STATUSES for in-flight tasks (running, in_progress, claimed, review, merging, done, canceled, failed, awaiting_input). Never regress active or terminal work back to todo unless force flag is explicitly passed.
- NFKD slugification: Clean titles with Unicode NFKD normalization, stripping combining marks while retaining Latin and Cyrillic characters. Combine slugs with truncated SHA256 hashes to guarantee deterministic, collision-free source keys.

## ANTI-PATTERNS
- Forbidden native C++ drivers: Avoid better-sqlite3 or native sqlite3 npm packages. Zero native dependencies keep Node 20+ portable across container and host environments.
- Downgrading PRESERVED_STATUSES without force: Don't overwrite claimed, running, or done tasks with plan updates. Unforced syncs must only advance unstarted items or mark additions.
- Mutating folder on inspection: Keep diff inspection, doctor diagnostics, and dry runs read-only with findFolder(). Never trigger findOrCreateFolder() insert operations before write sync execution.
- Unescaped SQL string interpolation: Don't insert raw string parameters into query templates. Sanitize and escape all values through escapeSql() or sanitizeSqlText() before execution.
