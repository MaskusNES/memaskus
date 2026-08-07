CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_user_id TEXT,
  scope_project_id TEXT,
  scope_workspace_id TEXT,
  scope_agent_id TEXT,
  scope_conversation_id TEXT,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  privacy_level TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (from_id) REFERENCES nodes(id),
  FOREIGN KEY (to_id) REFERENCES nodes(id)
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  external_id TEXT,
  title TEXT,
  content_excerpt TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_sources (
  node_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  evidence_text TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (node_id, source_id),
  FOREIGN KEY (node_id) REFERENCES nodes(id),
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_user_id TEXT,
  scope_project_id TEXT,
  scope_workspace_id TEXT,
  scope_agent_id TEXT,
  scope_conversation_id TEXT,
  confidence REAL NOT NULL,
  risk TEXT NOT NULL,
  needs_confirmation INTEGER NOT NULL,
  privacy_level TEXT NOT NULL DEFAULT 'normal',
  speaker_role TEXT,
  turn_id TEXT,
  status TEXT NOT NULL,
  source_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS candidate_conflicts (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  question TEXT NOT NULL,
  resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id),
  FOREIGN KEY (memory_id) REFERENCES nodes(id)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_slots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  sub_topic TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  knowledge_scope TEXT NOT NULL,
  scope_project_id TEXT,
  privacy_level TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS profile_slot_sources (
  slot_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  evidence_text TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (slot_id, source_id),
  FOREIGN KEY (slot_id) REFERENCES profile_slots(id),
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS profile_slot_revisions (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL,
  previous_content TEXT,
  next_content TEXT NOT NULL,
  reason TEXT,
  candidate_id TEXT,
  memory_id TEXT,
  source_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (slot_id) REFERENCES profile_slots(id),
  FOREIGN KEY (candidate_id) REFERENCES candidates(id),
  FOREIGN KEY (memory_id) REFERENCES nodes(id),
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  previous_content TEXT,
  next_content TEXT NOT NULL,
  previous_scope_json TEXT,
  next_scope_json TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES nodes(id)
);

CREATE TABLE IF NOT EXISTS memory_feedback (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  rating TEXT NOT NULL,
  comment TEXT,
  action TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES nodes(id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_status_scope ON nodes(status, scope_kind, scope_project_id, scope_user_id);
CREATE INDEX IF NOT EXISTS idx_nodes_scope_conversation ON nodes(scope_conversation_id);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
CREATE INDEX IF NOT EXISTS idx_candidates_scope_conversation ON candidates(scope_conversation_id);
CREATE INDEX IF NOT EXISTS idx_candidate_conflicts_candidate ON candidate_conflicts(candidate_id, status);
CREATE INDEX IF NOT EXISTS idx_profile_slots_lookup ON profile_slots(user_id, status, knowledge_scope, scope_project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_slots_active_identity
  ON profile_slots(user_id, topic, sub_topic, knowledge_scope, COALESCE(scope_project_id, ''))
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_memory_revisions_memory ON memory_revisions(memory_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_feedback_memory ON memory_feedback(memory_id, created_at);
