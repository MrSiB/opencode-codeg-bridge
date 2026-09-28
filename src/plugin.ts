import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { discoverEnvironment } from "./discovery.js";
import { syncPlanToCodeg, computePlanDiff, findFolder } from "./sync.js";
import { parseMarkdownPlan } from "./parser.js";
import { SqliteClient } from "./sqlite.js";
import fs from "node:fs/promises";

export const opencodeCodegBridgePlugin: Plugin = async (_input, _options): Promise<Hooks> => {
  return {
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
          const env = await discoverEnvironment({
            explicitDbPath: args.dbPath,
            explicitPlanPath: args.planPath,
            explicitWorkspace: args.workspacePath || context.worktree || context.directory
          });

          if (!env.planPath) {
            return {
              title: "Codeg Plan Sync",
              output: JSON.stringify({
                status: "error",
                message: "No active plan found to synchronize."
              })
            };
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
          const env = await discoverEnvironment({
            explicitDbPath: args.dbPath,
            explicitPlanPath: args.planPath,
            explicitWorkspace: args.workspacePath || context.worktree || context.directory
          });

          if (!env.planPath) {
            return {
              title: "Codeg Plan Diff",
              output: JSON.stringify({
                status: "error",
                message: "No active plan found."
              })
            };
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
        }
      }),

      codeg_status_plan: tool({
        description: "List tasks in Codeg SQLite database for the current workspace.",
        args: {
          dbPath: tool.schema.string().optional().describe("Optional path to codeg.db."),
          workspacePath: tool.schema.string().optional().describe("Optional workspace path.")
        },
        execute: async (args, context) => {
          const env = await discoverEnvironment({
            explicitDbPath: args.dbPath,
            explicitWorkspace: args.workspacePath || context.worktree || context.directory
          });

          const client = new SqliteClient(env.dbPath);
          const folder = await findFolder(client, env.workspacePath);
          const tasks = folder
            ? await client.query<{ id: number; title: string; status: string }>(
                `SELECT id, title, status FROM work_task WHERE folder_id = ${folder.id} ORDER BY id ASC;`
              )
            : [];

          return {
            title: "Codeg Task Status",
            output: JSON.stringify({ folderId: folder ? folder.id : null, workspace: env.workspacePath, tasks }, null, 2)
          };
        }
      })
    }
  };
};

export default opencodeCodegBridgePlugin;
