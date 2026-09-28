import { Command } from "commander";
import pc from "picocolors";
import { discoverEnvironment } from "./discovery.js";
import { syncPlanToCodeg, computePlanDiff, findFolder } from "./sync.js";
import { parseMarkdownPlan } from "./parser.js";
import { SqliteClient } from "./sqlite.js";
import type {
  DoctorReport,
  DoctorCheckResult,
  CliSyncOutput,
  CliDiffOutput,
  CliStatusOutput,
  CliErrorResponse
} from "./types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DoctorOptions {
  db?: string;
  workspace?: string;
}

export async function runDoctorChecks(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheckResult[] = [];

  const nodeVer = process.version;
  const majorMatch = process.versions.node.split(".")[0];
  const major = parseInt(majorMatch, 10);
  if (major >= 20) {
    checks.push({
      name: "node_version",
      status: "pass",
      message: `Node.js version ${nodeVer} satisfies >= 20.0.0`
    });
  } else {
    checks.push({
      name: "node_version",
      status: "fail",
      message: `Node.js version ${nodeVer} is unsupported. Required Node.js >= 20.0.0.`,
      remediation: "Upgrade Node.js to version 20 or higher."
    });
  }

  try {
    const { stdout } = await execFileAsync("sqlite3", ["--version"]);
    const versionStr = stdout.trim();
    checks.push({
      name: "sqlite3_cli",
      status: "pass",
      message: `sqlite3 CLI utility is available: ${versionStr}`,
      details: { version: versionStr }
    });
  } catch (err: unknown) {
    checks.push({
      name: "sqlite3_cli",
      status: "fail",
      message: "sqlite3 command-line utility not found in PATH or failed to execute.",
      remediation:
        "Install sqlite3 using: 'apt install sqlite3' (Debian/Ubuntu), 'apk add sqlite3' (Alpine), or 'brew install sqlite' (macOS).",
      details: err instanceof Error ? err.message : String(err)
    });
  }

  let resolvedDbPath: string | null = null;
  try {
    const env = await discoverEnvironment({
      explicitDbPath: options.db,
      explicitWorkspace: options.workspace
    });
    resolvedDbPath = path.resolve(env.dbPath);
    await fs.access(resolvedDbPath, fs.constants.F_OK | fs.constants.R_OK);
    const stat = await fs.stat(resolvedDbPath);
    if (!stat.isFile()) {
      throw new Error(`Path '${resolvedDbPath}' is not a regular file`);
    }
    checks.push({
      name: "database_accessibility",
      status: "pass",
      message: `Codeg database accessible at ${resolvedDbPath}`,
      details: { dbPath: resolvedDbPath, size: stat.size }
    });
  } catch (err: unknown) {
    checks.push({
      name: "database_accessibility",
      status: "fail",
      message: `Codeg database file not accessible: ${err instanceof Error ? err.message : String(err)}`,
      remediation:
        "Ensure Codeg database file exists and is accessible, or specify path via --db <path> or CODEG_DB_PATH environment variable.",
      details: err instanceof Error ? err.message : String(err)
    });
  }

  const dbCheckPassed = checks.find((c) => c.name === "database_accessibility")?.status === "pass";
  if (dbCheckPassed && resolvedDbPath) {
    const dir = path.dirname(resolvedDbPath);
    try {
      await fs.access(resolvedDbPath, fs.constants.W_OK);
      await fs.access(dir, fs.constants.W_OK);

      await execFileAsync("sqlite3", [resolvedDbPath, "PRAGMA journal_mode = WAL; PRAGMA user_version;"]);

      checks.push({
        name: "wal_shm_permissions",
        status: "pass",
        message: `Write permissions and WAL/SHM file creation verified for ${resolvedDbPath}`,
        details: { dbPath: resolvedDbPath, directory: dir }
      });
    } catch (err: unknown) {
      checks.push({
        name: "wal_shm_permissions",
        status: "fail",
        message: `Write permission or WAL/SHM creation check failed: ${err instanceof Error ? err.message : String(err)}`,
        remediation: `Grant write permissions to the database file '${resolvedDbPath}' and its directory '${dir}' (e.g. chmod u+w).`,
        details: err instanceof Error ? err.message : String(err)
      });
    }
  } else {
    checks.push({
      name: "wal_shm_permissions",
      status: "fail",
      message: "Cannot check WAL/SHM permissions because database is inaccessible.",
      remediation: "Resolve database accessibility check first by providing a valid database path via --db <path>."
    });
  }

  const passed = checks.filter((c) => c.status === "pass").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const ok = failed === 0;

  return {
    ok,
    nodeVersion: process.version,
    platform: process.platform,
    checks,
    summary: {
      passed,
      warnings,
      failed
    }
  };
}

function handleCliError(err: unknown, isJson: boolean): never {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as any)?.code || "ERR_CLI";
  const remediation = (err as any)?.remediation;
  const details = (err as any)?.details;
  const name = err instanceof Error ? err.name : "Error";

  if (isJson) {
    const errorPayload: CliErrorResponse = {
      success: false,
      error: {
        name,
        code,
        message,
        ...(remediation ? { remediation } : {}),
        ...(details ? { details } : {})
      },
      timestamp: new Date().toISOString()
    };
    console.log(JSON.stringify(errorPayload, null, 2));
  } else {
    console.error(pc.red(`Error: ${message}`));
    if (remediation) {
      console.error(pc.yellow(`Remediation: ${remediation}`));
    }
  }
  process.exit(1);
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("omo-codeg")
    .description("Oh My OpenAgent to Codeg Bridge CLI - zero native C++ dependencies")
    .version("0.1.0")
    .option("--json", "Output strictly valid JSON", false);

  program
    .command("sync")
    .description("Synchronize an OmO plan markdown file to Codeg SQLite database")
    .option("-p, --plan <path>", "Path to .omo/plans/*.md file")
    .option("-d, --db <path>", "Path to codeg.db SQLite database")
    .option("-w, --workspace <path>", "Path to target workspace")
    .option("--dry-run", "Preview changes without modifying the database", false)
    .option("-f, --force", "Force reset task statuses from plan", false)
    .option("--json", "Output strictly valid JSON", false)
    .action(async (options, cmd) => {
      const isJson = Boolean(cmd.optsWithGlobals().json || program.opts().json);
      try {
        const env = await discoverEnvironment({
          explicitDbPath: options.db,
          explicitPlanPath: options.plan,
          explicitWorkspace: options.workspace
        });

        if (!env.planPath) {
          throw Object.assign(
            new Error("No plan file found. Specify one with -p or create one in .omo/plans/."),
            {
              code: "ERR_PLAN_NOT_FOUND",
              remediation: "Provide a plan path via -p / --plan or ensure a markdown plan exists in .omo/plans/."
            }
          );
        }

        if (!isJson) {
          console.log(pc.cyan("=== omo-codeg sync ==="));
          console.log(pc.gray(`Plan: ${env.planPath}`));
          console.log(pc.gray(`Database: ${env.dbPath}`));
          console.log(pc.gray(`Workspace: ${env.workspacePath}`));
          console.log(pc.gray(`Dry run: ${Boolean(options.dryRun)}`));
          console.log(pc.gray(`Force: ${Boolean(options.force)}`));
        }

        const result = await syncPlanToCodeg({
          dbPath: env.dbPath,
          planPath: env.planPath,
          workspacePath: env.workspacePath,
          dryRun: options.dryRun,
          force: Boolean(options.force)
        });

        if (isJson) {
          const syncOutput: CliSyncOutput = {
            planSlug: result.planSlug,
            total: result.total,
            created: result.created,
            updated: result.updated,
            preserved: result.preserved,
            dryRun: result.dryRun,
            diffs: result.diffs
          };
          console.log(
            JSON.stringify(
              {
                success: true,
                data: syncOutput,
                ...syncOutput,
                timestamp: new Date().toISOString()
              },
              null,
              2
            )
          );
        } else {
          console.log(
            pc.green(
              `\nSync complete! Total: ${result.total}, Created: ${result.created}, Updated: ${result.updated}, Preserved: ${result.preserved}`
            )
          );
        }
      } catch (err: unknown) {
        handleCliError(err, isJson);
      }
    });

  program
    .command("diff")
    .description("Show differences between OmO plan and Codeg database tasks")
    .option("-p, --plan <path>", "Path to .omo/plans/*.md file")
    .option("-d, --db <path>", "Path to codeg.db SQLite database")
    .option("-w, --workspace <path>", "Path to target workspace")
    .option("-f, --force", "Force diff preview considering plan task statuses", false)
    .option("--json", "Output strictly valid JSON", false)
    .action(async (options, cmd) => {
      const isJson = Boolean(cmd.optsWithGlobals().json || program.opts().json);
      try {
        const env = await discoverEnvironment({
          explicitDbPath: options.db,
          explicitPlanPath: options.plan,
          explicitWorkspace: options.workspace
        });

        if (!env.planPath) {
          throw Object.assign(
            new Error("No plan file found. Specify one with -p or create one in .omo/plans/."),
            {
              code: "ERR_PLAN_NOT_FOUND",
              remediation: "Provide a plan path via -p / --plan or ensure a markdown plan exists in .omo/plans/."
            }
          );
        }

        const client = new SqliteClient(env.dbPath);
        const planContent = await fs.readFile(env.planPath, "utf-8");
        const plan = parseMarkdownPlan(planContent, env.planPath);
        const folder = await findFolder(client, env.workspacePath);
        const diffs = await computePlanDiff(client, plan, folder ? folder.id : null, {
          force: Boolean(options.force)
        });

        if (isJson) {
          const diffOutput: CliDiffOutput = {
            planSlug: plan.planSlug,
            planTitle: plan.planTitle,
            diffs
          };
          console.log(
            JSON.stringify(
              {
                success: true,
                data: diffOutput,
                plan: plan.planSlug,
                planSlug: plan.planSlug,
                planTitle: plan.planTitle,
                diffs,
                timestamp: new Date().toISOString()
              },
              null,
              2
            )
          );
        } else {
          console.log(pc.cyan(`=== Diff: ${plan.planTitle} ===`));
          for (const diff of diffs) {
            const prefix =
              diff.action === "create"
                ? pc.green("[+] CREATE")
                : diff.action === "update"
                ? pc.yellow("[~] UPDATE")
                : pc.blue("[=] PRESERVE");
            console.log(`${prefix} ${diff.task.title} (target status: ${diff.targetStatus})`);
          }
        }
      } catch (err: unknown) {
        handleCliError(err, isJson);
      }
    });

  program
    .command("status")
    .description("Display status of tasks in Codeg database")
    .option("-d, --db <path>", "Path to codeg.db SQLite database")
    .option("-w, --workspace <path>", "Path to target workspace")
    .option("--json", "Output strictly valid JSON", false)
    .action(async (options, cmd) => {
      const isJson = Boolean(cmd.optsWithGlobals().json || program.opts().json);
      try {
        const env = await discoverEnvironment({
          explicitDbPath: options.db,
          explicitWorkspace: options.workspace
        });

        const client = new SqliteClient(env.dbPath);
        const folder = await findFolder(client, env.workspacePath);

        const tasks = folder
          ? await client.query<{ id: number; title: string; status: string; source_key?: string | null }>(
              `SELECT id, title, status, source_key FROM work_task WHERE folder_id = ${folder.id} ORDER BY id ASC;`
            )
          : [];

        if (isJson) {
          const statusOutput: CliStatusOutput = {
            folderId: folder ? folder.id : 0,
            workspacePath: env.workspacePath,
            tasks: tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              sourceKey: t.source_key ?? null
            }))
          };
          console.log(
            JSON.stringify(
              {
                success: true,
                data: statusOutput,
                folderId: folder ? folder.id : null,
                workspace: env.workspacePath,
                workspacePath: env.workspacePath,
                tasks: statusOutput.tasks,
                timestamp: new Date().toISOString()
              },
              null,
              2
            )
          );
        } else {
          console.log(pc.cyan(`=== Codeg Tasks (${tasks.length}) ===`));
          for (const t of tasks) {
            console.log(`[#${t.id}] [${t.status}] ${t.title}`);
          }
        }
      } catch (err: unknown) {
        handleCliError(err, isJson);
      }
    });

  program
    .command("doctor")
    .description("Verify SQLite CLI, environment discovery, and permissions")
    .option("-d, --db <path>", "Path to codeg.db SQLite database")
    .option("-w, --workspace <path>", "Path to target workspace")
    .option("--json", "Output strictly valid JSON", false)
    .action(async (options, cmd) => {
      const isJson = Boolean(cmd.optsWithGlobals().json || program.opts().json);
      try {
        const report = await runDoctorChecks({
          db: options.db,
          workspace: options.workspace
        });

        if (isJson) {
          console.log(
            JSON.stringify(
              {
                success: report.ok,
                data: report,
                ...report,
                timestamp: new Date().toISOString()
              },
              null,
              2
            )
          );
        } else {
          console.log(pc.cyan("=== omo-codeg doctor ==="));
          console.log(`Node: ${pc.bold(report.nodeVersion)}`);
          console.log(`Platform: ${pc.bold(report.platform)}`);

          for (const check of report.checks) {
            const statusTag =
              check.status === "pass"
                ? pc.green("[PASS]")
                : check.status === "warn"
                ? pc.yellow("[WARN]")
                : pc.red("[FAIL]");
            console.log(`${statusTag} ${check.name}: ${check.message}`);
            if (check.remediation) {
              console.log(pc.yellow(`  Remediation: ${check.remediation}`));
            }
          }

          console.log(
            pc.gray(
              `\nSummary: ${report.summary.passed} passed, ${report.summary.warnings} warnings, ${report.summary.failed} failed`
            )
          );

          if (report.ok) {
            console.log(pc.green("Zero native dependencies check: PASSED"));
            console.log(pc.green("All health checks passed successfully!"));
          } else {
            console.error(pc.red("Doctor checks failed. Please address the remediation steps above."));
          }
        }

        if (!report.ok) {
          process.exit(1);
        }
      } catch (err: unknown) {
        handleCliError(err, isJson);
      }
    });

  await program.parseAsync(argv);
}
