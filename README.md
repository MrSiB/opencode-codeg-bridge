# @opencode-codeg-bridge

Standalone, zero-native-dependency OpenCode plugin (`@opencode-ai/plugin`) and CLI tool (`omo-codeg`) that bridges Oh My OpenAgent (OmO) cognitive planning artifacts (`.omo/plans/*.md`) directly into the Codeg task orchestration SQLite database (`work_task`).

## Features

- **Zero Native Dependencies**: Zero C++ addons, `node-gyp`, or `better-sqlite3`. Compatible with Node >= 20.
- **OpenCode Plugin**: Exposes the `codeg_sync_plan` tool to OpenCode agents.
- **Standalone CLI**: `omo-codeg` CLI executable for headless tasks, CI/CD, and bash environments.
- **TypeScript & ESM**: Strictly typed with clean builds to `dist/`.

## CLI Usage

```bash
# Display help
omo-codeg --help

# Environment health check
omo-codeg doctor

# Synchronize plan
omo-codeg sync --plan .omo/plans/my_plan.md

# Preview diff
omo-codeg diff --plan .omo/plans/my_plan.md

# View status
omo-codeg status
```

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Build to dist/
npm run build

# Run tests
npm test
```
