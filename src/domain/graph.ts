import type { MemoryDb } from "../db/connection.js";
import { knowledgeScope } from "./links.js";
import { mapEdge, mapNode } from "./mappers.js";
import { redactedContent } from "./privacy.js";
import type { Scope } from "./types.js";

export type GraphQuery = {
  project_id?: string;
  status?: string;
  limit?: number;
};

function displayId(id: string): string {
  const [prefix, suffix = id] = id.split("_");
  const label = prefix === "node" ? "N" : prefix === "edge" ? "E" : prefix.slice(0, 1).toUpperCase();
  return `${label}-${suffix.slice(0, 6)}`;
}

function scopeMatches(scope: Scope, projectId?: string): boolean {
  if (!projectId) {
    return true;
  }

  return scope.kind === "global" || scope.project_id === projectId;
}

export function getGraph(db: MemoryDb, query: GraphQuery = {}) {
  const status = query.status ?? "active";
  const limit = query.limit ?? 200;
  const nodeRows = db.prepare("SELECT * FROM nodes WHERE status = ? ORDER BY updated_at DESC LIMIT ?").all(status, limit);
  const nodes = nodeRows.map((row) => mapNode(row as never)).filter((node) => scopeMatches(node.scope, query.project_id));
  const nodeIds = new Set(nodes.map((node) => node.id));

  const edgeRows = db.prepare("SELECT * FROM edges WHERE status = 'active'").all();
  const edges = edgeRows
    .map((row) => mapEdge(row as never))
    .filter((edge) => nodeIds.has(edge.from_id) && nodeIds.has(edge.to_id));

  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      display_id: displayId(node.id),
      type: node.type,
      content: redactedContent(node),
      knowledge_scope: knowledgeScope(node),
      scope: node.scope,
      confidence: node.confidence,
      status: node.status,
      created_at: node.created_at,
      updated_at: node.updated_at
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      display_id: displayId(edge.id),
      from_id: edge.from_id,
      to_id: edge.to_id,
      relation: edge.relation,
      confidence: edge.confidence
    }))
  };
}
