# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-29T10:45:00+03:00
**Commit:** 0ee5501
**Branch:** main

## OVERVIEW
Standalone, zero-native-dependency OpenCode plugin (`@opencode-ai/plugin`) and CLI tool (`omo-codeg`) that bridges Oh My OpenAgent (OmO) cognitive planning artifacts (`.omo/plans/*.md`) into the Codeg task orchestration SQLite database (`work_task`). Built with Node 20+, TypeScript (ESM NodeNext), Commander, and Vitest.

## STRUCTURE
```
/workspace/opencode-codeg-bridge/
├── bin/
│   ├── omo-codeg              # Shell wrapper loading compiled dist binary
│   └── omo-codeg.ts           # CLI executable entry point with JSON error formatting
├── src/                       # Core domain implementation (see src/AGENTS.md)
│   └── index.ts               # Barrel exports (plugin, CLI, DB client, types)
├── tests/                     # Test infrastructure (see tests/AGENTS.md)
│   ├── e2e/                   # 8-step full bridge lifecycle test
│   ├── fixtures/              # Codeg SeaORM schema.sql & multi-wave plan fixtures
│   ├── helpers/               # Real temporary SQLite test DB harness & lock simulator
│   └── unit/                  # 12 isolated unit test suites
└── package.json               # Pure ESM ("type": "module"), Node engine >=20.0.0
```

## WHERE TO LOOK
| Task | Location | Notes |
|---|---|---|
| OpenCode agent tool integration | `src/plugin.ts` | Registers `codeg_sync_plan`, `codeg_diff_plan`, `codeg_status_plan` |
| CLI commands and health checks | `src/cli.ts` | Commander setup (`sync`, `diff`, `status`, `doctor`) |
| Plan synchronization & diffing | `src/sync.ts` | Idempotent task diff, status preservation, and transaction batching |
| Plan parsing & source keys | `src/parser.ts` | Codeblock fence state machine, Unicode NFKD slugifier, SHA256 key hashing |
| Zero-native SQLite execution | `src/sqlite.ts` | Host `sqlite3` CLI subprocess runner with stdin piping and WAL pragmas |
| Backup creation and rotation | `src/backup.ts` | Hot `.backup` snapshot creation, rolling retention of 5 newest backups |
| Environment auto-detection | `src/discovery.ts` | Auto-detects `codeg.db`, git workspace root, and active plan |
| Concurrency retry & backoff | `src/retry.ts` | Exponential backoff with jitter on `SQLITE_BUSY` errors |
| Error hierarchy & serialization | `src/errors.ts` | `BridgeError` subclasses with `code`, `remediation`, and `toJSON()` |

## CODE MAP
| Symbol | Type | Location | Refs | Role |
|---|---|---|---|---|
| `opencodeCodegBridgePlugin` | Function | `src/plugin.ts` | 3 | Default plugin export; exposes tools and slash commands to OpenCode |
| `runCli` | Function | `src/cli.ts` | 3 | Main CLI runner parsing flags, managing stdout format, and exit codes |
| `syncPlanToCodeg` | Function | `src/sync.ts` | 5 | Core sync pipeline: diffs, hot backup, folder upsert, atomic transaction |
| `computePlanDiff` | Function | `src/sync.ts` | 4 | Identifies task actions (`add`, `update`, `preserve`) against DB rows |
| `SqliteClient` | Class | `src/sqlite.ts` | 6 | Child-process wrapper around `sqlite3` CLI supporting WAL and transactions |
| `parseMarkdownPlan` | Function | `src/parser.ts` | 3 | Parses OmO markdown into structured `ParsedPlan` with waves and metadata |
| `calculateSourceKey` | Function | `src/parser.ts` | 4 | Generates deterministic `<planSlug>:<waveSlug>:<titleSlug>:<hash8>` |
| `createDatabaseBackup` | Function | `src/backup.ts` | 4 | Creates atomic `.bak.<ISO_TIMESTAMP>` file and triggers rotation |
| `discoverEnvironment` | Function | `src/discovery.ts` | 3 | Resolves DB path, active plan, and workspace folder |
| `retryAsync` | Function | `src/retry.ts` | 3 | Retries operations on SQLite lock contention with randomized backoff |
| `BridgeError` | Class | `src/errors.ts` | 10 | Root error class with remediation hints and JSON serialization |

## CONVENTIONS
- Zero native C++ dependencies: Strictly forbidden to use `better-sqlite3`, `node-gyp`, or binary addons. All DB interaction happens via host `sqlite3` CLI.
- Query execution via stdin: All SQL is piped via `stdin` (`input`) to prevent buffer truncation and shell argument limit issues (`ARG_MAX`).
- Status preservation invariant: Tasks in `PRESERVED_STATUSES` (`running`, `in_progress`, `claimed`, `review`, `merging`, `done`, `canceled`, `failed`, `awaiting_input`) are never overwritten or downgraded to `todo` without `--force`.
- Non-mutating read lookups: Diagnostic commands (`diff`, `status`, `doctor`) use `findFolder` and never insert into `folder` table.
- Strict FIFO ordering: New tasks receive monotonically increasing `sort_order` matching Codeg TaskEngine scheduling requirements.
- ESM NodeNext imports: All relative imports must include `.js` extension (e.g., `import { ... } from "./types.js"`).

## ANTI-PATTERNS (THIS PROJECT)
- Do NOT use native SQLite libraries or node-gyp dependencies.
- Do NOT downgrade task statuses from `PRESERVED_STATUSES` during normal sync.
- Do NOT mutate the database during `diff`, `status`, or dry runs.
- Do NOT construct raw SQL without sanitizing single quotes (`escapeSql`) or stripping NUL bytes (`\0`).
- Do NOT use synthetic mocks or in-memory DB stubs in tests; use real SQLite DBs in `tests/helpers/test-db.ts`.

## UNIQUE STYLES
- Dual interface: Exposes both as an OpenCode plugin (`@opencode-ai/plugin`) and as standalone binary (`omo-codeg`).
- Machine/Human dual output: CLI supports colored terminal output (`picocolors`) and structured JSON (`--json`).
- Pre-mutation backup: Sync automatically creates timestamped hot backup before executing write transactions.

## COMMANDS
```bash
npm run build              # Compile TypeScript to dist/ (excludes tests)
npm run typecheck          # Full type checking across src, bin, and tests
npm test                   # Run all 13 Vitest suites (145 tests)
npm run test:watch         # Run tests in watch mode
./bin/omo-codeg doctor     # Verify Node version, sqlite3 CLI, DB and WAL permissions
./bin/omo-codeg sync       # Sync active plan to Codeg SQLite database
./bin/omo-codeg diff       # Preview task changes without mutating DB
./bin/omo-codeg status     # Inspect current task state in Codeg DB
```

## NOTES
- Host system must have `sqlite3` CLI installed (`apt install sqlite3`, `brew install sqlite`, or `apk add sqlite`).
- Active plan resolution checks `.omo/boulder.json` (`active_plan` field) before scanning `.omo/plans/*.md` sorted by modification time.
