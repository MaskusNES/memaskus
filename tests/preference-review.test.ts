import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { contradictionReason } from "../src/domain/review.js";
import { buildServer } from "../src/server.js";

describe("disagreement-driven preference review", () => {
  let db: MemoryDb;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = await buildServer(db);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("extracts clear user disagreement into preference memory before ordinary candidates", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        conversation_id: "conv:disagreement",
        project_id: "project:agent-memory",
        text: [
          "Assistant: The MCP is configured, so it should be available now.",
          "User: No, I still do not see the agent_memory tool. Why is it unavailable?"
        ].join("\n")
      }
    });

    expect(review.statusCode).toBe(201);
    const body = review.json();
    expect(body.preference_review.summary).toMatchObject({
      disagreements: 1,
      clear_disagreements: 1,
      unclear_disagreements: 0,
      preference_candidates: 2,
      approved_preferences: 2
    });

    const recall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "реально доступны активной сессии агента",
        scope: { kind: "project", project_id: "project:agent-memory" },
        types: ["Preference"]
      }
    });

    expect(recall.json().results[0].content).toContain("реально доступны");
  });

  it("returns clarification questions for unclear disagreement", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:agent-memory",
        text: ["Assistant: I can implement the MCP adapter this way.", "User: No, stop."].join("\n")
      }
    });

    expect(review.statusCode).toBe(201);
    const body = review.json();
    expect(body.preference_review.summary).toMatchObject({
      disagreements: 1,
      clear_disagreements: 0,
      unclear_disagreements: 1,
      preference_candidates: 0
    });
    expect(body.preference_review.clarification_questions[0]).toContain("Что именно было не так");
  });

  it("blocks preference candidates that conflict with existing preferences", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "Пользователь предпочитает автоматическую запись в память без ручного подтверждения.",
        scope: { kind: "project", project_id: "project:agent-memory" },
        confidence: 0.9
      }
    });

    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:agent-memory",
        text: [
          "Assistant: I will automatically write all extracted memories.",
          "User: No, stop. I want confirmation before durable writes."
        ].join("\n")
      }
    });

    expect(review.statusCode).toBe(201);
    const body = review.json();
    expect(body.preference_review.summary.blocked_preferences).toBeGreaterThanOrEqual(1);
    expect(body.preference_review.conflicts[0].question).toContain("кажутся противоречивыми");
  });

  it("stores agent-supplied preference analysis without relying on heuristic text matching", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:agent-memory",
        analysis_mode: "agent_supplied",
        text: ["Assistant: I can continue with this implementation.", "User: Hm."].join("\n"),
        agent_analysis: {
          disagreements: [
            {
              user_text: "Hm.",
              assistant_context: "I can continue with this implementation.",
              reason_is_clear: true,
              inferred_reason: "The user reacted cautiously because the implementation path lacked an explicit contract.",
              demonstrated_preferences: [
                "User prefers MCP memory write paths to have an explicit structured contract before implementation."
              ],
              demonstrated_values: ["clear integration contracts"]
            }
          ]
        }
      }
    });

    expect(review.statusCode).toBe(201);
    const body = review.json();
    expect(body.preference_review.summary).toMatchObject({
      disagreements: 1,
      clear_disagreements: 1,
      preference_candidates: 1,
      approved_preferences: 1
    });

    const recall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "structured contract before implementation",
        scope: { kind: "project", project_id: "project:agent-memory" },
        types: ["Preference"]
      }
    });

    expect(recall.json().results[0].content).toContain("structured contract");
  });

  it("uses agent-supplied confidence for extracted preferences", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:agent-memory",
        analysis_mode: "agent_supplied",
        text: ["Assistant: I can infer preferences.", "User: Be careful; one of these is only weakly implied."].join("\n"),
        agent_analysis: {
          disagreements: [
            {
              user_text: "Be careful; one of these is only weakly implied.",
              assistant_context: "I can infer preferences.",
              reason_is_clear: true,
              inferred_reason: "The user wants confidence to reflect evidence strength.",
              demonstrated_preferences: [
                {
                  content: "User wants memory confidence to reflect evidence strength rather than a fixed default.",
                  confidence: 0.93
                },
                {
                  content: "User may prefer asking clarification questions for weakly implied memories.",
                  confidence: 0.61
                }
              ],
              demonstrated_values: ["calibrated uncertainty"],
              confidence: 0.77
            }
          ]
        }
      }
    });

    expect(review.statusCode).toBe(201);
    const approved = review.json().preference_review.approved;
    expect(approved.map((memory: { confidence: number }) => memory.confidence).sort()).toEqual([0.61, 0.93]);
    expect(approved.map((memory: { metadata: { confidence_source: string } }) => memory.metadata.confidence_source)).toEqual([
      "agent_supplied_preference",
      "agent_supplied_preference"
    ]);
  });

  it("keeps agent-supplied global preferences out of project-local conflict candidates", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "Пользователь хочет, чтобы сущности памяти были связаны только внутри локального проектного подграфа.",
        scope: { kind: "project", project_id: "project:agent-memory" },
        confidence: 0.9,
        metadata: { knowledge_scope: "project_local" }
      }
    });

    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:agent-memory",
        analysis_mode: "agent_supplied",
        text: [
          "Assistant: I can add a generic agent instruction.",
          "User: This should apply in every project, not only this memory project."
        ].join("\n"),
        agent_analysis: {
          disagreements: [
            {
              user_text: "This should apply in every project, not only this memory project.",
              assistant_context: "I can add a generic agent instruction.",
              reason_is_clear: true,
              inferred_reason: "Пользователь явно уточнил, что предпочтение должно быть глобальным.",
              demonstrated_preferences: [
                {
                  content: "Пользователь хочет, чтобы универсальные инструкции агентам применялись во всех проектах.",
                  confidence: 0.94,
                  knowledge_scope: "global"
                }
              ],
              demonstrated_values: ["сквозная согласованность поведения агентов"]
            }
          ]
        }
      }
    });

    expect(review.statusCode).toBe(201);
    const body = review.json();
    expect(body.preference_review.summary).toMatchObject({
      approved_preferences: 1,
      blocked_preferences: 0,
      preference_conflict_candidates: 0
    });
    expect(body.preference_review.approved[0].metadata.knowledge_scope).toBe("global");
  });

  it("does not run deterministic sentence extraction during agent-supplied review", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:agent-memory",
        analysis_mode: "agent_supplied",
        text: "User: Remember that this sentence would be a deterministic candidate in legacy mode.",
        agent_analysis: {
          disagreements: []
        }
      }
    });

    expect(review.statusCode).toBe(201);
    expect(review.json().summary).toMatchObject({
      extracted_candidates: 0,
      approved: 0,
      blocked: 0
    });

    const recall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: {
        query: "deterministic candidate legacy mode",
        scope: { kind: "project", project_id: "project:agent-memory" }
      }
    });

    expect(recall.json().results).toHaveLength(0);
  });

  it("returns related memory candidates for agent conflict review in agent-supplied mode", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "User prefers manual confirmation before durable memory writes.",
        scope: { kind: "project", project_id: "project:agent-memory" },
        confidence: 0.9
      }
    });

    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:agent-memory",
        analysis_mode: "agent_supplied",
        text: ["Assistant: I can refine memory writes.", "User: Yes, keep explicit confirmation."].join("\n"),
        agent_analysis: {
          disagreements: [
            {
              user_text: "Yes, keep explicit confirmation.",
              assistant_context: "I can refine memory writes.",
              reason_is_clear: true,
              inferred_reason: "The user confirmed the existing preference for confirmation before writes.",
              demonstrated_preferences: ["User prefers explicit confirmation before durable memory writes."],
              demonstrated_values: ["user control over persistent state"]
            }
          ]
        }
      }
    });

    expect(review.statusCode).toBe(201);
    const body = review.json();
    expect(body.preference_review.summary).toMatchObject({
      approved_preferences: 0,
      blocked_preferences: 1,
      preference_conflicts: 0,
      preference_conflict_candidates: 1
    });
    expect(body.conflicts).toHaveLength(0);
    expect(body.conflict_candidates[0].reason).toContain("кандидат на потенциальный конфликт");

    const resolution = await app.inject({
      method: "POST",
      url: `/v1/conflicts/${body.conflict_candidates[0].id}/resolve`,
      payload: {
        action: "mark_compatible",
        note: "The agent determined this reinforces the existing preference rather than contradicting it."
      }
    });

    expect(resolution.statusCode).toBe(200);
    expect(resolution.json().candidate.status).toBe("approved");
  });

  it("does not return different knowledge scopes as conflict candidates", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content:
          "User prefers using the active chat agent's existing subscription/session for semantic dialogue analysis when possible, rather than requiring a separate backend LLM API key.",
        scope: { kind: "project", project_id: "project:agent-memory" },
        confidence: 0.9,
        metadata: { knowledge_scope: "project_local" }
      }
    });

    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:agent-memory",
        analysis_mode: "agent_supplied",
        text: ["Assistant: We can package this workflow.", "User: Let's make a Codex skill."].join("\n"),
        agent_analysis: {
          disagreements: [
            {
              user_text: "Let's make a Codex skill.",
              assistant_context: "We can package this workflow.",
              reason_is_clear: true,
              inferred_reason:
                "The user wanted the memory review workflow packaged as a reusable Codex skill available across projects.",
              demonstrated_preferences: [
                "User prefers reusable Codex skills for repeated semantic dialogue analysis workflows instead of repeating long prompts manually."
              ],
              demonstrated_values: ["workflow reuse", "low-friction agent operation"]
            }
          ]
        }
      }
    });

    expect(review.statusCode).toBe(201);
    const body = review.json();
    expect(body.preference_review.summary).toMatchObject({
      approved_preferences: 1,
      blocked_preferences: 0,
      preference_conflicts: 0,
      preference_conflict_candidates: 0
    });
    expect(body.conflict_candidates).toHaveLength(0);
    expect(body.preference_review.approved[0].metadata.knowledge_scope).toBe("global");
  });

  it("keeps a conflict candidate open when the agent needs user clarification", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "User prefers automatic memory writes for low-risk observations.",
        scope: { kind: "project", project_id: "project:agent-memory" },
        confidence: 0.9
      }
    });

    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:agent-memory",
        analysis_mode: "agent_supplied",
        text: ["Assistant: I can write low-risk observations automatically.", "User: I want manual review sometimes."].join("\n"),
        agent_analysis: {
          disagreements: [
            {
              user_text: "I want manual review sometimes.",
              assistant_context: "I can write low-risk observations automatically.",
              reason_is_clear: true,
              inferred_reason: "The user may want manual review in some memory-write situations.",
              demonstrated_preferences: ["User wants manual review for some memory writes."],
              demonstrated_values: ["user control over persistent state"]
            }
          ]
        }
      }
    });

    const body = review.json();
    expect(body.conflict_candidates).toHaveLength(1);

    const openConflicts = await app.inject({
      method: "GET",
      url: "/v1/conflicts?status=open"
    });
    expect(openConflicts.json().conflicts[0]).toMatchObject({
      id: body.conflict_candidates[0].id,
      status: "open"
    });
    expect(openConflicts.json().conflicts[0].candidate.status).toBe("blocked");
  });

  it("asks for clarification when agent-supplied analysis marks pushback as unclear", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:agent-memory",
        analysis_mode: "agent_supplied",
        text: ["Assistant: I will add the feature.", "User: Not like that."].join("\n"),
        agent_analysis: {
          disagreements: [
            {
              user_text: "Not like that.",
              assistant_context: "I will add the feature.",
              reason_is_clear: false,
              clarification_question: "What specifically should be different about this implementation approach?"
            }
          ]
        }
      }
    });

    expect(review.statusCode).toBe(201);
    const body = review.json();
    expect(body.preference_review.summary).toMatchObject({
      disagreements: 1,
      clear_disagreements: 0,
      preference_candidates: 0
    });
    expect(body.preference_review.clarification_questions[0]).toContain("What specifically should be different");
  });

  it("does not treat different preference layers as heuristic conflicts just because one says instead of", async () => {
    const reason = contradictionReason(
      {
        id: "cand:test",
        type: "Preference",
        content: "User prefers reusable Codex skills for repeated agent workflows instead of repeating long prompts manually.",
        scope: { kind: "project", project_id: "project:agent-memory" },
        confidence: 0.82,
        risk: "low",
        needs_confirmation: false,
        status: "pending",
        source_id: "src:test",
        metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "node:test",
        type: "Preference",
        content:
          "User prefers using the active chat agent's existing subscription/session for semantic dialogue analysis when possible, rather than requiring a separate backend LLM API key.",
        scope: { kind: "project", project_id: "project:agent-memory" },
        confidence: 0.9,
        status: "active",
        privacy_level: "normal",
        metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      }
    );

    expect(reason).toBeNull();
  });
});
