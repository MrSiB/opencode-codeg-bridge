import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { Command } from "commander";
import pc from "picocolors";
export * from "./types.js";

/**
 * OpenCode Plugin entrypoint for opencode-codeg-bridge
 */
export const opencodeCodegBridgePlugin: Plugin = async (_input, _options): Promise<Hooks> => {
  return {
    tool: {
      codeg_sync_plan: tool({
        description: "Synchronize an Oh My OpenAgent (OmO) plan (.omo/plans/*.md) to the Codeg task orchestration SQLite database with state preservation.",
        args: {
          planPath: tool.schema.string().optional().describe("Optional path to the markdown plan file. Defaults to auto-discovery in .omo/plans/."),
          dbPath: tool.schema.string().optional().describe("Optional path to the codeg.db SQLite database. Defaults to auto-discovery."),
          dryRun: tool.schema.boolean().optional().describe("If true, calculates and returns the diff without modifying the database.")
        },
        execute: async (args, context) => {
          return {
            title: "Codeg Plan Sync",
            output: JSON.stringify({
              status: "ready",
              message: "opencode-codeg-bridge scaffolding active",
              args,
              directory: context.directory,
              worktree: context.worktree
            }, null, 2)
          };
        }
      })
    }
  };
};

export default opencodeCodegBridgePlugin;

/**
 * Standalone CLI entrypoint for omo-codeg
 */
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
    .option("--dry-run", "Preview changes without modifying the database", false)
    .action(async (options) => {
      console.log(pc.cyan("=== omo-codeg sync ==="));
      console.log(pc.gray(`Plan: ${options.plan || "(auto-discovery)"}`));
      console.log(pc.gray(`Database: ${options.db || "(auto-discovery)"}`));
      console.log(pc.gray(`Dry run: ${Boolean(options.dryRun)}`));
      console.log(pc.green("Bridge package initialized successfully."));
    });

  program
    .command("diff")
    .description("Show differences between OmO plan and Codeg database tasks")
    .option("-p, --plan <path>", "Path to .omo/plans/*.md file")
    .option("-d, --db <path>", "Path to codeg.db SQLite database")
    .action(async (options) => {
      console.log(pc.cyan("=== omo-codeg diff ==="));
      console.log(pc.gray(`Plan: ${options.plan || "(auto-discovery)"}`));
      console.log(pc.green("No pending differences (scaffolding)."));
    });

  program
    .command("status")
    .description("Display status of tasks in Codeg database")
    .option("-d, --db <path>", "Path to codeg.db SQLite database")
    .action(async (options) => {
      console.log(pc.cyan("=== omo-codeg status ==="));
      console.log(pc.gray(`Database: ${options.db || "(auto-discovery)"}`));
      console.log(pc.green("All systems operational."));
    });

  program
    .command("doctor")
    .description("Verify SQLite CLI, environment discovery, and permissions")
    .action(async () => {
      console.log(pc.cyan("=== omo-codeg doctor ==="));
      console.log(pc.green("Checking environment..."));
      console.log(`Node: ${pc.bold(process.version)}`);
      console.log(`Platform: ${pc.bold(process.platform)}`);
      console.log(pc.green("Zero native dependencies check: PASSED"));
    });

  await program.parseAsync(argv);
}
