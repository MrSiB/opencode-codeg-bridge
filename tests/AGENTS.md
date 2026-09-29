# TESTS MODULE KNOWLEDGE BASE

## OVERVIEW
Verifies zero-native bridge correctness, SQLite concurrency safety, and CLI/plugin contract fidelity against real databases.

## STRUCTURE
- `tests/unit/`: Isolated unit suites for parser, sync, sqlite client, retry, discovery, backup, and CLI.
- `tests/e2e/`: Full 8-step lifecycle integration spanning CLI subcommands and OpenCode plugin registration.
- `tests/helpers/`: Test harness utilities (`test-db.ts`) for temp DB lifecycle, WAL activation, and locking.
- `tests/fixtures/`: Realistic test fixtures (`sample-plan.md`, `schema.sql`) matching production Codeg schema.

## WHERE TO LOOK
| Test Suite / Helper | Focus Area | Key Invariants Verified |
|---|---|---|
| `tests/helpers/test-db.ts` | Test DB harness | Isolated temp DB per test, WAL mode check, external lock simulation via subprocess. |
| `tests/unit/sync.test.ts` | Sync engine | Idempotent plan sync, status preservation (running, claimed, review, done), folder mapping. |
| `tests/unit/concurrency.test.ts` | WAL & contention | 10 parallel ops, SQLITE_BUSY backoff, non-blocking reads during writes, data integrity. |
| `tests/unit/sqlite.test.ts` | SQLite CLI client | Process execution, JSON response decoding, transaction rollback, busy lock handling. |
| `tests/unit/parser.test.ts` | Markdown AST parsing | FSM fence isolation, task checklist extraction, unicode slugification, collision safety. |
| `tests/unit/backup.test.ts` | DB backup engine | Hot backup creation via SQLite backup API, rotation retaining 5 newest snapshots. |
| `tests/unit/cli.test.ts` | Standalone CLI | Argument parsing for `doctor`, `sync`, `diff`, `status`, exit codes, JSON output. |
| `tests/unit/plugin.test.ts` | OpenCode plugin | `codeg_sync_plan` tool registration, input schema validation, BridgeError formatting. |
| `tests/e2e/bridge.e2e.test.ts` | End-to-end flow | Complete 8-step lifecycle from `doctor` and dry-run `diff` to real task sync and verify. |

## CONVENTIONS
- Real temporary databases: Each suite spins up a fresh SQLite instance in `os.tmpdir()` using `createTestDatabase()`.
- WAL mode default: Every test database runs `PRAGMA journal_mode = WAL;` with schema validation on creation.
- Subprocess locking: External lock contention is simulated via `simulateExternalLock()` spawning real `sqlite3` CLI processes.
- Vitest globals: Uses Vitest globals (`describe`, `it`, `expect`, `beforeEach`, `afterEach`) with Node 20+ runtime.
- Automatic cleanup: Always register `afterEach(async () => { await testDb.cleanup(); })` to purge temporary directories.

## ANTI-PATTERNS
- Forbidden: In-memory or synthetic mock objects for SQLite. Tests must run against real `sqlite3` files.
- Forbidden: Deleting, skipping, or commenting out failing tests to force green CI builds.
- Forbidden: Omitting temp DB cleanup in `afterEach`, which leaks files in `os.tmpdir()`.
- Forbidden: Hardcoding fixed port numbers or relying on global state across test runs.
- Forbidden: Altering production database paths instead of isolated fixture paths.

## COMMANDS
```bash
npm test                                      # Run all 13 test suites via vitest run
npm run test:watch                            # Run vitest in interactive watch mode
npx vitest run tests/unit/concurrency.test.ts  # Run specific unit test suite
npx vitest run tests/e2e/bridge.e2e.test.ts    # Run E2E lifecycle test suite
```
