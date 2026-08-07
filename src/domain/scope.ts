import type { Scope } from "./types.js";

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

export function scopeSqlParts(scope?: Scope): { clause: string; params: unknown[] } {
  const requested = scope ?? { kind: "global" as const };
  if (requested.kind === "global") {
    return { clause: "scope_kind = 'global'", params: [] };
  }

  const columnByField = {
    user_id: "scope_user_id",
    project_id: "scope_project_id",
    workspace_id: "scope_workspace_id",
    agent_id: "scope_agent_id",
    conversation_id: "scope_conversation_id"
  } as const;
  const clauses = ["scope_kind = 'global'"];
  const exact: string[] = ["scope_kind = ?"];
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
