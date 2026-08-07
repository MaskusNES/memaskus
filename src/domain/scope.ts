import type { KnowledgeScope, Scope } from "./types.js";

const identityFields = ["user_id", "project_id", "workspace_id", "agent_id", "conversation_id"] as const;

export function exactScopeMatch(left: Scope, right: Scope): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  return identityFields.every((field) => {
    const expected = right[field];
    return !expected || left[field] === expected;
  });
}

export function scopeVisibleFrom(memoryScope: Scope, requestedScope?: Scope): boolean {
  const requested = requestedScope ?? { kind: "global" as const };
  if (requested.kind === "global") {
    return memoryScope.kind === "global";
  }

  if (memoryScope.kind === "global") {
    return true;
  }

  return exactScopeMatch(memoryScope, requested);
}

export function scopeSqlParts(scope?: Scope, prefix = ""): { clause: string; params: unknown[] } {
  const requested = scope ?? { kind: "global" as const };
  const column = (name: string) => `${prefix}${name}`;
  if (requested.kind === "global") {
    return { clause: `${column("scope_kind")} = 'global'`, params: [] };
  }

  const columnByField = {
    user_id: column("scope_user_id"),
    project_id: column("scope_project_id"),
    workspace_id: column("scope_workspace_id"),
    agent_id: column("scope_agent_id"),
    conversation_id: column("scope_conversation_id")
  } as const;
  const clauses = [`${column("scope_kind")} = 'global'`];
  const exact: string[] = [`${column("scope_kind")} = ?`];
  const params: unknown[] = [requested.kind];
  for (const field of identityFields) {
    if (requested[field]) {
      exact.push(`${columnByField[field]} = ?`);
      params.push(requested[field]);
    }
  }
  clauses.push(`(${exact.join(" AND ")})`);
  return { clause: `(${clauses.join(" OR ")})`, params };
}

export function memoryVisibilitySqlParts(
  scope?: Scope,
  knowledgeScope?: KnowledgeScope,
  prefix = ""
): { clause: string; params: unknown[] } {
  const scopeFilter = scopeSqlParts(scope, prefix);
  const knowledgeColumn = `${prefix}knowledge_scope`;
  if (knowledgeScope === "global") {
    return { clause: `${knowledgeColumn} = 'global'`, params: [] };
  }
  if (knowledgeScope === "project_local") {
    return {
      clause: `${knowledgeColumn} = 'project_local' AND ${scopeFilter.clause}`,
      params: scopeFilter.params
    };
  }
  return scopeFilter;
}
