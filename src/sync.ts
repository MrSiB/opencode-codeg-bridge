import path from "node:path";
import { SqliteClient } from "./sqlite.js";
import { parseMarkdownPlan } from "./parser.js";
import type { ParsedPlan, SyncResult, TaskDiff } from "./types.js";
import fs from "node:fs/promises";

export interface PlanSyncOptions {
  dbPath: string;
  planPath: string;
  workspacePath: string;
  dryRun?: boolean;
}

interface ExistingTaskRow {
  id: number;
  folder_id: number;
  title: string;
  status: string;
  source_key: string | null;
}

export interface FolderRow {
  id: number;
  name: string;
  path: string;
}

const PRESERVED_STATUSES = new Set([
  "running",
  "in_progress",
  "review",
  "merging",
  "done"
]);

function escapeSqlString(val: string): string {
  return val.replace(/'/g, "''");
}

export async function findFolder(
  client: SqliteClient,
  workspacePath: string
): Promise<FolderRow | null> {
  const normPath = path.resolve(workspacePath);
  const rows = await client.query<FolderRow>(
    `SELECT id, name, path FROM folder WHERE path = '${escapeSqlString(normPath)}';`
  );

  if (rows.length > 0) {
    return rows[0];
  }

  return null;
}

export async function findOrCreateFolder(
  client: SqliteClient,
  workspacePath: string
): Promise<FolderRow> {
  const normPath = path.resolve(workspacePath);
  const folderName = path.basename(normPath) || "workspace";

  await client.exec(`
    INSERT INTO folder (name, path, git_branch, last_opened_at, created_at, updated_at, is_open)
    VALUES ('${escapeSqlString(folderName)}', '${escapeSqlString(normPath)}', 'main', datetime('now'), datetime('now'), datetime('now'), 1)
    ON CONFLICT(path) DO UPDATE SET updated_at = datetime('now');
  `);

  const folder = await findFolder(client, normPath);
  if (!folder) {
    throw new Error(`Failed to find or create folder for path: ${normPath}`);
  }

  return folder;
}

export async function computePlanDiff(
  client: SqliteClient,
  plan: ParsedPlan,
  folderId: number | null
): Promise<TaskDiff[]> {
  if (folderId === null || folderId === undefined) {
    return plan.tasks.map((task) => ({
      action: "create" as const,
      task,
      targetStatus: task.status
    }));
  }

  const existingRows = await client.query<ExistingTaskRow>(
    `SELECT id, folder_id, title, status, source_key FROM work_task WHERE folder_id = ${folderId};`
  );

  const existingByKey = new Map<string, ExistingTaskRow>();
  const existingByTitle = new Map<string, ExistingTaskRow>();

  for (const row of existingRows) {
    if (row.source_key) {
      existingByKey.set(row.source_key, row);
    }
    existingByTitle.set(row.title.trim().toLowerCase(), row);
  }

  const diffs: TaskDiff[] = [];

  for (const task of plan.tasks) {
    const existing = existingByKey.get(task.sourceKey) || existingByTitle.get(task.title.trim().toLowerCase());

    if (!existing) {
      diffs.push({
        action: "create",
        task,
        targetStatus: task.status
      });
      continue;
    }

    let targetStatus = existing.status;
    let action: "preserve" | "update" = "preserve";

    if (task.status === "done" && existing.status !== "done") {
      targetStatus = "done";
      action = "update";
    } else if (task.status === "todo" && !PRESERVED_STATUSES.has(existing.status)) {
      targetStatus = "todo";
    }

    diffs.push({
      action,
      task,
      existingId: existing.id,
      currentStatus: existing.status,
      targetStatus
    });
  }

  return diffs;
}

export async function syncPlanToCodeg(options: PlanSyncOptions): Promise<SyncResult> {
  const client = new SqliteClient(options.dbPath);
  const planContent = await fs.readFile(options.planPath, "utf-8");
  const plan = parseMarkdownPlan(planContent, options.planPath);

  if (options.dryRun) {
    const existingFolder = await findFolder(client, options.workspacePath);
    const diffs = await computePlanDiff(
      client,
      plan,
      existingFolder ? existingFolder.id : null
    );

    let created = 0;
    let updated = 0;
    let preserved = 0;

    for (const diff of diffs) {
      if (diff.action === "create") {
        created++;
      } else if (diff.action === "update") {
        updated++;
      } else {
        preserved++;
      }
    }

    return {
      success: true,
      planSlug: plan.planSlug,
      total: plan.tasks.length,
      created,
      updated,
      preserved,
      dryRun: true,
      diffs
    };
  }

  const folder = await findOrCreateFolder(client, options.workspacePath);
  const folderId = folder.id;
  const diffs = await computePlanDiff(client, plan, folderId);

  let created = 0;
  let updated = 0;
  let preserved = 0;

  for (const diff of diffs) {
    if (diff.action === "create") {
      created++;
    } else if (diff.action === "update") {
      updated++;
    } else {
      preserved++;
    }
  }

  await client.createBackup();

  const sqlCommands: string[] = [];

  for (const diff of diffs) {
    if (diff.action === "create") {
      const taskConfig = JSON.stringify({
        prompt: diff.task.description || diff.task.title,
        wave: diff.task.wave
      });

      sqlCommands.push(`
        INSERT INTO work_task (
          folder_id, title, config, status, source_kind, source_key, source_meta, created_at, updated_at
        ) VALUES (
          ${folderId},
          '${escapeSqlString(diff.task.title)}',
          '${escapeSqlString(taskConfig)}',
          '${diff.targetStatus}',
          'omo_plan',
          '${escapeSqlString(diff.task.sourceKey)}',
          '${escapeSqlString(JSON.stringify({ plan: plan.planSlug, wave: diff.task.wave }))}',
          datetime('now'),
          datetime('now')
        );
      `);
    } else if (diff.action === "update" && diff.existingId) {
      sqlCommands.push(`
        UPDATE work_task
        SET status = '${diff.targetStatus}', updated_at = datetime('now')
        WHERE id = ${diff.existingId};
      `);
    }
  }

  if (sqlCommands.length > 0) {
    await client.executeInTransaction(sqlCommands);
  }

  return {
    success: true,
    planSlug: plan.planSlug,
    total: plan.tasks.length,
    created,
    updated,
    preserved,
    dryRun: false,
    diffs
  };
}
