import { SqliteClient } from "./sqlite.js";
import { escapeSql } from "./sync.js";
import type { ConversationRecord, CreateChildConversationParams } from "./types.js";

export type { ConversationRecord, CreateChildConversationParams };

/**
 * Finds a conversation by its external_id.
 */
export async function findConversationByExternalId(
  client: SqliteClient,
  externalId: string
): Promise<ConversationRecord | null> {
  const query = `SELECT id, folder_id, title, agent_type, status, model, git_branch, external_id, parent_id, message_count, created_at, updated_at, parent_tool_use_id, delegation_call_id, kind, origin_cwd FROM conversation WHERE external_id = '${escapeSql(
    externalId
  )}' LIMIT 1;`;

  const rows = await client.query<ConversationRecord>(query);
  return rows[0] ?? null;
}

/**
 * Creates a child conversation row with parent tool / delegation link.
 * external_id is left NULL initially to respect the UNIQUE constraint idx_conversation_external_agent.
 */
export async function createChildConversation(
  client: SqliteClient,
  params: CreateChildConversationParams
): Promise<number> {
  if (!params.parentToolUseId || params.parentToolUseId.trim() === "") {
    throw new Error("parentToolUseId must be non-empty");
  }
  if (!params.delegationCallId || params.delegationCallId.trim() === "") {
    throw new Error("delegationCallId must be non-empty");
  }

  const folderId = Number(params.folderId);
  const titleVal = params.title !== undefined && params.title !== null
    ? `'${escapeSql(params.title)}'`
    : "NULL";
  const agentTypeVal = `'${escapeSql(params.agentType)}'`;
  const statusVal = `'${escapeSql(params.status ?? "in_progress")}'`;
  const modelVal = params.model !== undefined && params.model !== null
    ? `'${escapeSql(params.model)}'`
    : "NULL";
  const parentIdVal = params.parentId !== undefined && params.parentId !== null
    ? Number(params.parentId)
    : "NULL";
  const parentToolUseIdVal = `'${escapeSql(params.parentToolUseId)}'`;
  const delegationCallIdVal = `'${escapeSql(params.delegationCallId)}'`;
  const kindVal = `'${escapeSql(params.kind ?? "delegate")}'`;
  const originCwdVal = params.originCwd !== undefined && params.originCwd !== null
    ? `'${escapeSql(params.originCwd)}'`
    : "NULL";

  const sql = `INSERT INTO conversation (folder_id, title, agent_type, status, model, external_id, parent_id, message_count, created_at, updated_at, parent_tool_use_id, delegation_call_id, title_locked, kind, origin_cwd) VALUES (${folderId}, ${titleVal}, ${agentTypeVal}, ${statusVal}, ${modelVal}, NULL, ${parentIdVal}, 0, datetime('now'), datetime('now'), ${parentToolUseIdVal}, ${delegationCallIdVal}, 0, ${kindVal}, ${originCwdVal}); SELECT last_insert_rowid() AS id;`;

  const rows = await client.query<{ id: number }>(sql);
  const insertedId = rows[0]?.id;
  if (insertedId === undefined || insertedId === null) {
    throw new Error("Failed to retrieve last_insert_rowid() for child conversation");
  }

  return Number(insertedId);
}

/**
 * Updates external_id and updated_at timestamp for a conversation.
 */
export async function updateConversationExternalId(
  client: SqliteClient,
  id: number,
  externalId: string
): Promise<void> {
  const sql = `UPDATE conversation SET external_id = '${escapeSql(
    externalId
  )}', updated_at = datetime('now') WHERE id = ${Number(id)};`;
  await client.exec(sql);
}

/**
 * Updates status and updated_at timestamp for a conversation.
 */
export async function updateConversationStatus(
  client: SqliteClient,
  id: number,
  status: string
): Promise<void> {
  const sql = `UPDATE conversation SET status = '${escapeSql(
    status
  )}', updated_at = datetime('now') WHERE id = ${Number(id)};`;
  await client.exec(sql);
}

/**
 * Reconciles stale subagent sessions by marking in_progress delegate conversations older than threshold as failed.
 * Returns the number of affected rows.
 */
export async function reconcileStaleSubagents(
  client: SqliteClient,
  olderThanMinutes: number = 30
): Promise<number> {
  const minutes = Math.max(1, Math.floor(olderThanMinutes));
  const sql = `UPDATE conversation SET status = 'failed', updated_at = datetime('now') WHERE kind = 'delegate' AND status = 'in_progress' AND updated_at < datetime('now', '-${minutes} minutes'); SELECT changes() AS affected;`;
  const rows = await client.query<{ affected: number }>(sql);
  return Number(rows[0]?.affected ?? 0);
}
