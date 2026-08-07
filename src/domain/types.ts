export type Scope = {
  kind: "global" | "user" | "project" | "workspace" | "agent" | "conversation";
  user_id?: string;
  project_id?: string;
  workspace_id?: string;
  agent_id?: string;
  conversation_id?: string;
};

export type MemoryStatus = "candidate" | "active" | "superseded" | "archived" | "deleted";
export type PrivacyLevel = "normal" | "sensitive" | "secret";

export type MemoryNode = {
  id: string;
  type: string;
  content: string;
  scope: Scope;
  confidence: number;
  status: MemoryStatus;
  privacy_level: PrivacyLevel;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type Source = {
  id: string;
  kind: string;
  external_id?: string | null;
  title?: string | null;
  content_excerpt?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type Edge = {
  id: string;
  from_id: string;
  to_id: string;
  relation: string;
  confidence: number;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type KnowledgeScope = "global" | "project_local";

export type UserProfile = {
  id: string;
  display_name?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ProfileSlotStatus = "active" | "archived" | "deleted";

export type ProfileSlot = {
  id: string;
  user_id: string;
  topic: string;
  sub_topic: string;
  content: string;
  confidence: number;
  status: ProfileSlotStatus;
  knowledge_scope: KnowledgeScope;
  scope_project_id?: string | null;
  privacy_level: PrivacyLevel;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ProfileSlotRevision = {
  id: string;
  slot_id: string;
  previous_content?: string | null;
  next_content: string;
  reason?: string | null;
  candidate_id?: string | null;
  memory_id?: string | null;
  source_id?: string | null;
  created_at: string;
};

export type MemoryRevision = {
  id: string;
  memory_id: string;
  previous_content?: string | null;
  next_content: string;
  previous_scope?: Scope | null;
  next_scope: Scope;
  reason?: string | null;
  created_at: string;
};

export type MemoryFeedback = {
  id: string;
  memory_id: string;
  rating: "correct" | "wrong" | "outdated" | "too_broad" | "too_narrow";
  comment?: string | null;
  action?: string | null;
  created_at: string;
};
