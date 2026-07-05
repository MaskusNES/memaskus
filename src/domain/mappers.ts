import type { Edge, MemoryNode, Scope, Source } from "./types.js";

type NodeRow = {
  id: string;
  type: string;
  content: string;
  scope_kind: Scope["kind"];
  scope_user_id: string | null;
  scope_project_id: string | null;
  scope_workspace_id: string | null;
  scope_agent_id: string | null;
  confidence: number;
  status: MemoryNode["status"];
  privacy_level: MemoryNode["privacy_level"];
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

type SourceRow = {
  id: string;
  kind: string;
  external_id: string | null;
  title: string | null;
  content_excerpt: string | null;
  metadata_json: string;
  created_at: string;
};

type EdgeRow = {
  id: string;
  from_id: string;
  to_id: string;
  relation: string;
  confidence: number;
  status: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export function mapNode(row: NodeRow): MemoryNode {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    scope: {
      kind: row.scope_kind,
      user_id: row.scope_user_id ?? undefined,
      project_id: row.scope_project_id ?? undefined,
      workspace_id: row.scope_workspace_id ?? undefined,
      agent_id: row.scope_agent_id ?? undefined
    },
    confidence: row.confidence,
    status: row.status,
    privacy_level: row.privacy_level,
    metadata: JSON.parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function mapSource(row: SourceRow): Source {
  return {
    id: row.id,
    kind: row.kind,
    external_id: row.external_id,
    title: row.title,
    content_excerpt: row.content_excerpt,
    metadata: JSON.parse(row.metadata_json),
    created_at: row.created_at
  };
}

export function mapEdge(row: EdgeRow): Edge {
  return {
    id: row.id,
    from_id: row.from_id,
    to_id: row.to_id,
    relation: row.relation,
    confidence: row.confidence,
    status: row.status,
    metadata: JSON.parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
