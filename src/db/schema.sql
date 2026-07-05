CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_user_id TEXT,
  scope_project_id TEXT,
  scope_workspace_id TEXT,
  scope_agent_id TEXT,
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
  confidence REAL NOT NULL,
  risk TEXT NOT NULL,
  needs_confirmation INTEGER NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_nodes_status_scope ON nodes(status, scope_kind, scope_project_id, scope_user_id);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
CREATE INDEX IF NOT EXISTS idx_candidate_conflicts_candidate ON candidate_conflicts(candidate_id, status);
