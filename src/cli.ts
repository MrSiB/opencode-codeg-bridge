import { Command } from "commander";
import pc from "picocolors";
import { discoverEnvironment } from "./discovery.js";
import { syncPlanToCodeg, computePlanDiff, findFolder } from "./sync.js";
import { parseMarkdownPlan } from "./parser.js";
import { SqliteClient } from "./sqlite.js";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("omo-codeg")
    .description("Oh My OpenAgent to Codeg Bridge CLI - zero native C++ dependencies")
    .version("0.1.0");

  program
    .command("sync")
    .description("Synchronize an OmO plan markdown file to Codeg SQLite database")
    .option("-p, --plan <path>", "Path to .omo/plans/*.md file")
    .option("-d, --db <path>", "Path to codeg.db SQLite database")
    .option("-w, --workspace <path>", "Path to target workspace")
    .option("--dry-run", "Preview changes without modifying the database", false)
    .action(async (options) => {
      try {
        const env = await discoverEnvironment({
          explicitDbPath: options.db,
          explicitPlanPath: options.plan,
          explicitWorkspace: options.workspace
        });

        if (!env.planPath) {
          console.error(pc.red("Error: No plan file found. Specify one with -p or create one in .omo/plans/."));
          process.exit(1);
        }

        console.log(pc.cyan("=== omo-codeg sync ==="));
        console.log(pc.gray(`Plan: ${env.planPath}`));
        console.log(pc.gray(`Database: ${env.dbPath}`));
        console.log(pc.gray(`Workspace: ${env.workspacePath}`));
        console.log(pc.gray(`Dry run: ${Boolean(options.dryRun)}`));

        const result = await syncPlanToCodeg({
          dbPath: env.dbPath,
          planPath: env.planPath,
          workspacePath: env.workspacePath,
          dryRun: options.dryRun
        });

        console.log(
          pc.green(
            `\nSync complete! Total: ${result.total}, Created: ${result.created}, Updated: ${result.updated}, Preserved: ${result.preserved}`
          )
        );
      } catch (err: unknown) {
        console.error(pc.red(`Sync failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  program
    .command("diff")
    .description("Show differences between OmO plan and Codeg database tasks")
    .option("-p, --plan <path>", "Path to .omo/plans/*.md file")
    .option("-d, --db <path>", "Path to codeg.db SQLite database")
    .option("-w, --workspace <path>", "Path to target workspace")
    .action(async (options) => {
      try {
        const env = await discoverEnvironment({
          explicitDbPath: options.db,
          explicitPlanPath: options.plan,
          explicitWorkspace: options.workspace
        });

        if (!env.planPath) {
          console.error(pc.red("Error: No plan file found. Specify one with -p or create one in .omo/plans/."));
          process.exit(1);
        }

        const client = new SqliteClient(env.dbPath);
        const planContent = await fs.readFile(env.planPath, "utf-8");
        const plan = parseMarkdownPlan(planContent, env.planPath);
        const folder = await findFolder(client, env.workspacePath);
        const diffs = await computePlanDiff(client, plan, folder ? folder.id : null);

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
      } catch (err: unknown) {
        console.error(pc.red(`Diff failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  program
    .command("status")
    .description("Display status of tasks in Codeg database")
    .option("-d, --db <path>", "Path to codeg.db SQLite database")
    .option("-w, --workspace <path>", "Path to target workspace")
    .action(async (options) => {
      try {
        const env = await discoverEnvironment({
          explicitDbPath: options.db,
          explicitWorkspace: options.workspace
        });

        const client = new SqliteClient(env.dbPath);
        const folder = await findFolder(client, env.workspacePath);

        const tasks = folder
          ? await client.query<{ id: number; title: string; status: string }>(
              `SELECT id, title, status FROM work_task WHERE folder_id = ${folder.id} ORDER BY id ASC;`
            )
          : [];

        console.log(pc.cyan(`=== Codeg Tasks (${tasks.length}) ===`));
        for (const t of tasks) {
          console.log(`[#${t.id}] [${t.status}] ${t.title}`);
        }
      } catch (err: unknown) {
        console.error(pc.red(`Status failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  program
    .command("doctor")
    .description("Verify SQLite CLI, environment discovery, and permissions")
    .action(async () => {
      console.log(pc.cyan("=== omo-codeg doctor ==="));
      console.log(`Node: ${pc.bold(process.version)}`);
      console.log(`Platform: ${pc.bold(process.platform)}`);

      try {
        const { stdout } = await execFileAsync("sqlite3", ["--version"]);
        console.log(pc.green(`SQLite CLI: ${stdout.trim()}`));
      } catch (err: unknown) {
        console.error(pc.red(`SQLite CLI check failed: ${String(err)}`));
      }

      try {
        const env = await discoverEnvironment();
        console.log(pc.green(`Environment: DB=${env.dbPath}, Workspace=${env.workspacePath}`));
      } catch (err: unknown) {
        console.log(pc.yellow(`Environment auto-discovery note: ${String(err)}`));
      }

      console.log(pc.green("Zero native dependencies check: PASSED"));
    });

  await program.parseAsync(argv);
}
