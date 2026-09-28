export type TaskKind = "IMPL" | "PLAN";

export type TaskStatus = "todo" | "in_progress" | "claimed" | "done" | "cancelled";

export interface PlanTask {
  id: string;
  title: string;
  kind: TaskKind;
  status: TaskStatus;
  sourceKey: string;
  where?: string;
  how?: string;
  why?: string;
  expectedResult?: string;
  rawText?: string;
  wave?: number;
  order: number;
}

export interface PlanWave {
  wave: number;
  title: string;
  tasks: PlanTask[];
}

export interface ParsedPlan {
  slug: string;
  title: string;
  path: string;
  tasks: PlanTask[];
  waves: PlanWave[];
}

export interface CodegTaskRow {
  id: string;
  folder_id: string;
  title: string;
  status: TaskStatus;
  source_kind: string;
  source_key: string;
  config: string;
  sort_order: number;
  created_at?: number;
  updated_at?: number;
}

export interface SyncOptions {
  planPath?: string;
  dbPath?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

export interface SyncDiff {
  toInsert: PlanTask[];
  toUpdate: Array<{ task: PlanTask; existing: CodegTaskRow }>;
  unchanged: Array<{ task: PlanTask; existing: CodegTaskRow }>;
  orphaned: CodegTaskRow[];
}

export interface SyncResult {
  success: boolean;
  planSlug: string;
  folderId: string;
  dbPath: string;
  inserted: number;
  updated: number;
  preserved: number;
  orphaned: number;
  diff: SyncDiff;
  error?: string;
}
