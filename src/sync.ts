import path from "node:path";
import { SqliteClient } from "./sqlite.js";
import { parseMarkdownPlan, parseSourceKey } from "./parser.js";
import type { ParsedPlan, SyncResult, TaskDiff, PlanSyncOptions, PlanDiffOptions } from "./types.js";
import { PRESERVED_STATUSES } from "./types.js";
import fs from "node:fs/promises";

export { PRESERVED_STATUSES, type PlanSyncOptions, type PlanDiffOptions };

interface ExistingTaskRow {
  id: number;
  folder_id: number;
  title: string;
  status: string;
  source_key: string | null;
  source_meta: string | null;
}

export interface FolderRow {
  id: number;
  name: string;
  path: string;
}

function escapeSqlString(val: string): string {
  return val.replace(/'/g, "''");
}

function isEligibleForTitleFallback(row: ExistingTaskRow, currentPlanSlug: string): boolean {
  if (!row.source_key || row.source_key.trim() === "") {
    return true;
  }

  if (row.source_meta && row.source_meta.trim() !== "") {
    try {
      const meta = JSON.parse(row.source_meta);
      if (meta && typeof meta === "object") {
        const metaPlan = meta.plan || meta.planSlug || meta.slug;
        if (typeof metaPlan === "string" && metaPlan === currentPlanSlug) {
          return true;
        }
      }
    } catch {
      if (row.source_meta.trim() === currentPlanSlug) {
        return true;
      }
    }
  }

  const parsedKey = parseSourceKey(row.source_key);
  if (parsedKey && parsedKey.planSlug === currentPlanSlug) {
    return true;
  }

  return false;
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
  folderId: number | null,
  options?: PlanDiffOptions | boolean
): Promise<TaskDiff[]> {
  const force = typeof options === "boolean" ? options : Boolean(options?.force);

  if (folderId === null || folderId === undefined) {
    return plan.tasks.map((task) => ({
      action: "create" as const,
      task,
      targetStatus: task.status
    }));
  }

  const existingRows = await client.query<ExistingTaskRow>(
    `SELECT id, folder_id, title, status, source_key, source_meta FROM work_task WHERE folder_id = ${folderId};`
  );

  const existingByKey = new Map<string, ExistingTaskRow>();
  const existingByTitle = new Map<string, ExistingTaskRow[]>();

  for (const row of existingRows) {
    if (row.source_key && row.source_key.trim() !== "") {
      existingByKey.set(row.source_key, row);
    }
    if (isEligibleForTitleFallback(row, plan.planSlug)) {
      const normTitle = row.title.trim().toLowerCase();
      const list = existingByTitle.get(normTitle) || [];
      list.push(row);
      existingByTitle.set(normTitle, list);
    }
  }

  const diffs: TaskDiff[] = [];
  const matchedRowIds = new Set<number>();

  for (const task of plan.tasks) {
    let existing: ExistingTaskRow | undefined;

    if (task.sourceKey && existingByKey.has(task.sourceKey)) {
      const candidate = existingByKey.get(task.sourceKey)!;
      if (!matchedRowIds.has(candidate.id)) {
        existing = candidate;
        matchedRowIds.add(existing.id);
      }
    }

    if (!existing) {
      const normTitle = task.title.trim().toLowerCase();
      const candidates = existingByTitle.get(normTitle) || [];
      const fallback = candidates.find((r) => !matchedRowIds.has(r.id));
      if (fallback) {
        existing = fallback;
        matchedRowIds.add(existing.id);
      }
    }

    if (!existing) {
      diffs.push({
        action: "create",
        task,
        targetStatus: task.status
      });
      continue;
    }

    let targetStatus = existing.status;
    let action: "create" | "update" | "preserve" = "preserve";

    if (force) {
      if (existing.status !== task.status) {
        targetStatus = task.status;
        action = "update";
      } else {
        targetStatus = existing.status;
        action = "preserve";
      }
    } else {
      if (task.status === "done" && existing.status !== "done") {
        targetStatus = "done";
        action = "update";
      } else if (PRESERVED_STATUSES.has(existing.status)) {
        targetStatus = existing.status;
        action = "preserve";
      } else if (existing.status !== task.status) {
        targetStatus = task.status;
        action = "update";
      } else {
        targetStatus = existing.status;
        action = "preserve";
      }
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
      existingFolder ? existingFolder.id : null,
      { force: options.force }
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
  const diffs = await computePlanDiff(client, plan, folderId, { force: options.force });

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
