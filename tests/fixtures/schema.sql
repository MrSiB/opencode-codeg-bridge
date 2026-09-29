-- Minimal schema fixture matching Codeg SQLite schema for testing
CREATE TABLE IF NOT EXISTS folder (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR NOT NULL,
  path VARCHAR NOT NULL UNIQUE,
  git_branch VARCHAR NULL,
  default_agent_type VARCHAR NULL,
  last_opened_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT NULL,
  is_open BOOLEAN NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  color VARCHAR NOT NULL DEFAULT 'inherit',
  parent_id INTEGER NULL,
  kind TEXT NOT NULL DEFAULT 'regular',
  alias VARCHAR NULL,
  group_id INTEGER NULL
);

CREATE TABLE IF NOT EXISTS work_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  config TEXT NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'todo',
  failure_reason VARCHAR NULL,
  last_error TEXT NULL,
  run_seq INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  worktree_folder_id INTEGER NULL,
  conversation_id INTEGER NULL,
  connection_id VARCHAR NULL,
  base_branch VARCHAR NULL,
  base_sha VARCHAR NULL,
  work_branch VARCHAR NULL,
  merge_state TEXT NULL,
  cleanup_state VARCHAR NULL,
  verdict VARCHAR NULL,
  result_summary TEXT NULL,
  files_changed INTEGER NULL,
  additions INTEGER NULL,
  deletions INTEGER NULL,
  merge_commit VARCHAR NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  settled_at TEXT NULL,
  finished_at TEXT NULL,
  deleted_at TEXT NULL,
  pending_merge TEXT NULL,
  preflight TEXT NULL,
  archived_at TEXT NULL,
  scheduled_at TEXT NULL,
  source_kind TEXT NULL,
  source_key TEXT NULL,
  source_meta TEXT NULL,
  completion_kind TEXT NULL,
  FOREIGN KEY (folder_id) REFERENCES folder (id)
);

CREATE INDEX IF NOT EXISTS idx_work_task_folder ON work_task (folder_id);
CREATE INDEX IF NOT EXISTS idx_work_task_status ON work_task (status);
CREATE INDEX IF NOT EXISTS idx_work_task_source_key ON work_task (source_key);

CREATE TABLE IF NOT EXISTS work_task_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  kind VARCHAR NOT NULL,
  actor VARCHAR NOT NULL,
  payload TEXT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES work_task (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_work_task_event_task_created ON work_task_event (task_id, created_at);

CREATE TABLE IF NOT EXISTS conversation (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL,
  title VARCHAR NULL,
  agent_type VARCHAR NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'in_progress',
  model VARCHAR NULL,
  git_branch VARCHAR NULL,
  external_id VARCHAR NULL,
  parent_id INTEGER NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT NULL,
  parent_tool_use_id TEXT NULL,
  delegation_call_id TEXT NULL,
  title_locked BOOLEAN NOT NULL DEFAULT 0,
  pinned_at TEXT NULL,
  kind TEXT NOT NULL DEFAULT 'regular',
  origin_cwd TEXT NULL,
  FOREIGN KEY (folder_id) REFERENCES folder (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_folder_id ON conversation (folder_id);
CREATE INDEX IF NOT EXISTS idx_conversation_deleted_created ON conversation (deleted_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_external_agent ON conversation (external_id, agent_type);
CREATE INDEX IF NOT EXISTS idx_conversation_parent_tool_use_id ON conversation (parent_tool_use_id);
CREATE INDEX IF NOT EXISTS idx_conversation_delegation_call_id ON conversation (delegation_call_id);
CREATE INDEX IF NOT EXISTS idx_conversation_parent_id ON conversation (parent_id);
