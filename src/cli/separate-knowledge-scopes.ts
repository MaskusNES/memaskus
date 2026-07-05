import Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { nowIso } from "../shared/time.js";

const globalDisplayIds = new Set(["N-9j8705", "N-alsy0r", "N-cmw7nk", "N-f0o2w1"]);

function displayId(id: string): string {
  const [prefix, suffix = id] = id.split("_");
  const label = prefix === "node" ? "N" : prefix === "edge" ? "E" : prefix.slice(0, 1).toUpperCase();
  return `${label}-${suffix.slice(0, 6)}`;
}

function knowledgeScope(metadataJson: string): "global" | "project_local" {
  const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
  return metadata.knowledge_scope === "global" ? "global" : "project_local";
}

const db = new Database(process.env.MEMORY_DB_PATH ?? loadConfig().databasePath);
const now = nowIso();
const updateNode = db.prepare("UPDATE nodes SET metadata_json = ?, updated_at = ? WHERE id = ?");
const updateCandidate = db.prepare("UPDATE candidates SET metadata_json = ?, updated_at = ? WHERE id = ?");
const updateEdge = db.prepare("UPDATE edges SET status = 'deleted', metadata_json = ?, updated_at = ? WHERE id = ?");

let globalNodes = 0;
let localNodes = 0;
let candidates = 0;
let deletedCrossScopeEdges = 0;

db.transaction(() => {
  const nodes = db.prepare("SELECT id, metadata_json FROM nodes WHERE status = 'active'").all() as Array<{
    id: string;
    metadata_json: string;
  }>;
  const nodeScopeById = new Map<string, "global" | "project_local">();

  for (const node of nodes) {
    const metadata = JSON.parse(node.metadata_json) as Record<string, unknown>;
    const nextScope = globalDisplayIds.has(displayId(node.id)) ? "global" : "project_local";
    const previousScope = metadata.knowledge_scope;
    metadata.knowledge_scope = nextScope;
    metadata.knowledge_scope_assigned_at = now;
    metadata.knowledge_scope_assignment = globalDisplayIds.has(displayId(node.id))
      ? "user_marked_global"
      : "default_project_local";
    updateNode.run(JSON.stringify(metadata), now, node.id);
    nodeScopeById.set(node.id, nextScope);
    if (previousScope !== nextScope) {
      if (nextScope === "global") {
        globalNodes += 1;
      } else {
        localNodes += 1;
      }
    }
  }

  const candidateRows = db.prepare("SELECT id, metadata_json FROM candidates").all() as Array<{
    id: string;
    metadata_json: string;
  }>;
  const candidateScopeById = new Map<string, "global" | "project_local">();

  for (const node of nodes) {
    const metadata = JSON.parse(node.metadata_json) as Record<string, unknown>;
    if (typeof metadata.approved_from_candidate_id === "string") {
      candidateScopeById.set(metadata.approved_from_candidate_id, nodeScopeById.get(node.id) ?? "project_local");
    }
  }

  for (const candidate of candidateRows) {
    const metadata = JSON.parse(candidate.metadata_json) as Record<string, unknown>;
    const nextScope = candidateScopeById.get(candidate.id);
    if (!nextScope) {
      continue;
    }
    if (metadata.knowledge_scope !== nextScope) {
      metadata.knowledge_scope = nextScope;
      metadata.knowledge_scope_assigned_at = now;
      metadata.knowledge_scope_assignment = "copied_from_approved_node";
      updateCandidate.run(JSON.stringify(metadata), now, candidate.id);
      candidates += 1;
    }
  }

  const edges = db.prepare("SELECT id, from_id, to_id, metadata_json FROM edges WHERE status = 'active'").all() as Array<{
    id: string;
    from_id: string;
    to_id: string;
    metadata_json: string;
  }>;

  for (const edge of edges) {
    const fromScope = nodeScopeById.get(edge.from_id) ?? "project_local";
    const toScope = nodeScopeById.get(edge.to_id) ?? "project_local";
    if (fromScope === toScope) {
      continue;
    }

    const metadata = JSON.parse(edge.metadata_json) as Record<string, unknown>;
    metadata.deleted_reason = "cross_knowledge_scope";
    metadata.deleted_at = now;
    metadata.from_knowledge_scope = fromScope;
    metadata.to_knowledge_scope = toScope;
    updateEdge.run(JSON.stringify(metadata), now, edge.id);
    deletedCrossScopeEdges += 1;
  }
})();

db.close();

console.log(
  JSON.stringify(
    {
      global_nodes_assigned: globalNodes,
      local_nodes_assigned: localNodes,
      candidates_updated: candidates,
      deleted_cross_scope_edges: deletedCrossScopeEdges
    },
    null,
    2
  )
);
