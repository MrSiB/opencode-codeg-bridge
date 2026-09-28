import type { Plugin, Hooks, Config } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { discoverEnvironment } from "./discovery.js";
import { syncPlanToCodeg, computePlanDiff, findFolder } from "./sync.js";
import { parseMarkdownPlan } from "./parser.js";
import { SqliteClient } from "./sqlite.js";
import { BridgeError, PlanNotFoundError } from "./errors.js";
import fs from "node:fs/promises";

export interface PluginCommandDefinition {
  description: string;
  template: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
}

export interface BridgePluginHooks extends Hooks {
  command?: Record<string, PluginCommandDefinition>;
}

export function formatErrorOutput(title: string, err: unknown): { title: string; output: string } {
  if (err instanceof BridgeError) {
    return {
      title,
      output: JSON.stringify(
        {
          status: "error",
          error: err.message,
          code: err.code,
          remediation: err.remediation
        },
        null,
        2
      )
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  const code = (err as any)?.code ?? "ERR_INTERNAL";
  const remediation = (err as any)?.remediation;

  return {
    title,
    output: JSON.stringify(
      {
        status: "error",
        error: message,
        code,
        remediation
      },
      null,
      2
    )
  };
}

export const opencodeCodegBridgePlugin: Plugin = async (_input, _options): Promise<Hooks> => {
  const commandDefinition: PluginCommandDefinition = {
    description: "Synchronize current OmO plan to Codeg task orchestration database",
    template:
      "Synchronize the current plan to Codeg task orchestration database using the codeg_sync_plan tool. Arguments: $ARGUMENTS"
  };

  const hooks: BridgePluginHooks = {
    config: async (cfg: Config) => {
      if (!cfg.command) {
        cfg.command = {};
      }
      cfg.command["codeg-sync"] = commandDefinition;
    },
    command: {
      "codeg-sync": commandDefinition,
      "/codeg-sync": commandDefinition
    },
    "command.execute.before": async (input, _output) => {
      if (input.command === "codeg-sync" || input.command === "/codeg-sync") {
        // Slash command hook handler
      }
    },
    tool: {
      codeg_sync_plan: tool({
        description:
          "Synchronize an Oh My OpenAgent (OmO) plan (.omo/plans/*.md) to the Codeg task orchestration SQLite database with status preservation.",
        args: {
          planPath: tool.schema
            .string()
            .optional()
            .describe("Optional path to markdown plan. Defaults to auto-discovery in .omo/plans/."),
          dbPath: tool.schema
            .string()
            .optional()
            .describe("Optional path to codeg.db. Defaults to auto-discovery."),
          workspacePath: tool.schema
            .string()
            .optional()
            .describe("Optional workspace path. Defaults to auto-discovery."),
          dryRun: tool.schema
            .boolean()
            .optional()
            .describe("If true, previews changes without modifying the database."),
          force: tool.schema
            .boolean()
            .optional()
            .describe("If true, forces overwrite/reset of task statuses from plan.")
        },
        execute: async (args, context) => {
          try {
            const env = await discoverEnvironment({
              explicitDbPath: args.dbPath,
              explicitPlanPath: args.planPath,
              explicitWorkspace: args.workspacePath || context?.worktree || context?.directory
            });

            if (!env.planPath) {
              throw new PlanNotFoundError("No active plan found to synchronize.");
            }

            const result = await syncPlanToCodeg({
              dbPath: env.dbPath,
              planPath: env.planPath,
              workspacePath: env.workspacePath,
              dryRun: args.dryRun,
              force: args.force
            });

            return {
              title: "Codeg Plan Sync",
              output: JSON.stringify(result, null, 2)
            };
          } catch (err) {
            return formatErrorOutput("Codeg Plan Sync", err);
          }
        }
      }),

      codeg_diff_plan: tool({
        description: "Preview diff between OmO plan and Codeg database tasks.",
        args: {
          planPath: tool.schema.string().optional().describe("Optional path to plan."),
          dbPath: tool.schema.string().optional().describe("Optional path to codeg.db."),
          workspacePath: tool.schema.string().optional().describe("Optional workspace path."),
          force: tool.schema.boolean().optional().describe("If true, previews diff with forced overwrite.")
        },
        execute: async (args, context) => {
          try {
            const env = await discoverEnvironment({
              explicitDbPath: args.dbPath,
              explicitPlanPath: args.planPath,
              explicitWorkspace: args.workspacePath || context?.worktree || context?.directory
            });

            if (!env.planPath) {
              throw new PlanNotFoundError("No active plan found.");
            }

            const client = new SqliteClient(env.dbPath);
            const planContent = await fs.readFile(env.planPath, "utf-8");
            const plan = parseMarkdownPlan(planContent, env.planPath);
            const folder = await findFolder(client, env.workspacePath);
            const diffs = await computePlanDiff(client, plan, folder ? folder.id : null, { force: args.force });

            return {
              title: `Codeg Plan Diff: ${plan.planTitle}`,
              output: JSON.stringify({ plan: plan.planSlug, diffs }, null, 2)
            };
          } catch (err) {
            return formatErrorOutput("Codeg Plan Diff", err);
          }
        }
      }),

      codeg_status_plan: tool({
        description: "List tasks in Codeg SQLite database for the current workspace.",
        args: {
          dbPath: tool.schema.string().optional().describe("Optional path to codeg.db."),
          workspacePath: tool.schema.string().optional().describe("Optional workspace path.")
        },
        execute: async (args, context) => {
          try {
            const env = await discoverEnvironment({
              explicitDbPath: args.dbPath,
              explicitWorkspace: args.workspacePath || context?.worktree || context?.directory
            });

            const client = new SqliteClient(env.dbPath);
            const folder = await findFolder(client, env.workspacePath);
            const tasks = folder
              ? await client.query<{ id: number; title: string; status: string; source_key?: string }>(
                  `SELECT id, title, status, source_key FROM work_task WHERE folder_id = ${folder.id} ORDER BY id ASC;`
                )
              : [];

            return {
              title: "Codeg Task Status",
              output: JSON.stringify(
                { folderId: folder ? folder.id : null, workspace: env.workspacePath, tasks },
                null,
                2
              )
            };
          } catch (err) {
            return formatErrorOutput("Codeg Task Status", err);
          }
        }
      })
    }
  };

  return hooks;
};

export default opencodeCodegBridgePlugin;
