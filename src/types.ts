export type TaskKind = "IMPL" | "PLAN";

export type TaskStatus = "todo" | "in_progress" | "running" | "claimed" | "review" | "merging" | "done" | "cancelled";

export interface PlanTask {
  id?: string;
  title: string;
  description?: string;
  kind?: TaskKind;
  status: TaskStatus;
  sourceKey: string;
  where?: string;
  how?: string;
  why?: string;
  expectedResult?: string;
  rawText?: string;
  wave?: string | number;
  order: number;
}

export interface PlanWave {
  wave: number | string;
  title: string;
  tasks: PlanTask[];
}

export interface ParsedPlan {
  slug: string;
  planSlug: string;
  title: string;
  planTitle: string;
  path: string;
  planPath: string;
  tasks: PlanTask[];
  waves?: PlanWave[];
}

export interface CodegTaskRow {
  id: number;
  folder_id: number;
  title: string;
  status: TaskStatus;
  source_kind?: string;
  source_key?: string;
  config?: string;
  sort_order?: number;
  created_at?: string;
  updated_at?: string;
}

export interface TaskDiff {
  action: "create" | "update" | "preserve";
  task: PlanTask;
  existingId?: number;
  currentStatus?: string;
  targetStatus: string;
}

export interface SyncResult {
  success: boolean;
  planSlug: string;
  total: number;
  created: number;
  updated: number;
  preserved: number;
  dryRun: boolean;
  diffs: TaskDiff[];
  error?: string;
}
