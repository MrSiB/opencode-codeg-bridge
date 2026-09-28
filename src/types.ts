export type TaskKind = "IMPL" | "PLAN";

/**
 * Task statuses synchronized with Codeg SeaORM task status enumeration:
 * "todo" | "queued" | "preparing" | "running" | "awaiting_input" | "review" | "merging" | "done" | "failed" | "canceled"
 */
export type TaskStatus =
  | "todo"
  | "queued"
  | "preparing"
  | "running"
  | "awaiting_input"
  | "review"
  | "merging"
  | "done"
  | "failed"
  | "canceled";

/**
 * Parsed components of a task source_key.
 * Used for deterministic identity, idempotency, and wave tracking across synchronizations.
 */
export interface SourceKeyComponents {
  planSlug: string;
  waveSlug?: string;
  titleSlug?: string;
  hash8: string;
  disambiguationIndex: number;
}

export interface PlanTask {
  id?: string;
  title: string;
  description?: string;
  kind?: TaskKind;
  status: TaskStatus;
  sourceKey: string;
  where?: string;
  what?: string;
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

/**
 * Status of individual doctor check.
 */
export type DoctorCheckStatus = "pass" | "warn" | "fail";

/**
 * Result of a single doctor health check.
 */
export interface DoctorCheckResult {
  name: string;
  status: DoctorCheckStatus;
  message: string;
  details?: unknown;
  remediation?: string;
}

/**
 * Aggregated doctor health check report.
 */
export interface DoctorReport {
  ok: boolean;
  nodeVersion: string;
  platform: string;
  checks: DoctorCheckResult[];
  summary: {
    passed: number;
    warnings: number;
    failed: number;
  };
}

/**
 * Standard structured JSON CLI responses.
 */
export interface CliSuccessResponse<T = unknown> {
  success: true;
  data: T;
  timestamp: string;
}

export interface CliErrorResponse {
  success: false;
  error: {
    name: string;
    code: string;
    message: string;
    remediation?: string;
    details?: unknown;
  };
  timestamp: string;
}

export type CliResponse<T = unknown> = CliSuccessResponse<T> | CliErrorResponse;

export interface CliSyncOutput {
  planSlug: string;
  total: number;
  created: number;
  updated: number;
  preserved: number;
  dryRun: boolean;
  diffs: TaskDiff[];
}

export interface CliDiffOutput {
  planSlug: string;
  planTitle: string;
  diffs: TaskDiff[];
}

export interface CliStatusOutput {
  folderId: number;
  workspacePath: string;
  tasks: Array<{
    id: number;
    title: string;
    status: TaskStatus | string;
    sourceKey?: string | null;
  }>;
}
