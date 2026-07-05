export type Scope = {
  kind: "global" | "user" | "project" | "workspace" | "agent" | "conversation";
  user_id?: string;
  project_id?: string;
  workspace_id?: string;
  agent_id?: string;
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
