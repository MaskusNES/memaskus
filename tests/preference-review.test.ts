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

  it("asks for clarification instead of inventing a preference in heuristic mode", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        conversation_id: "conv:disagreement",
        project_id: "project:demo",
        text: ["Assistant: The cover will be blue.", "User: No, that is not what I asked for."].join("\n")
      }
    });

    expect(review.statusCode).toBe(201);
    const body = review.json();
    expect(body.preference_review.summary).toMatchObject({
      disagreements: 1,
      clear_disagreements: 0,
      unclear_disagreements: 1,
      preference_candidates: 0,
      approved_preferences: 0
    });
    expect(body.preference_review.clarification_questions[0]).toContain("What preference or value");
  });

  it("stores explicit agent-supplied analysis without heuristic text matching", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:demo",
        analysis_mode: "agent_supplied",
        text: ["Assistant: I will export HTML.", "User: Please export PDF instead."].join("\n"),
        agent_analysis: {
          disagreements: [
            {
              user_text: "Please export PDF instead.",
              assistant_context: "I will export HTML.",
              reason_is_clear: true,
              inferred_reason: "The requested artifact format is PDF.",
              demonstrated_preferences: ["Demo user prefers PDF exports for monthly reports."],
              demonstrated_values: ["portable report output"]
            }
          ]
        }
      }
    });

    expect(review.statusCode).toBe(201);
    expect(review.json().preference_review.summary).toMatchObject({
      disagreements: 1,
      clear_disagreements: 1,
      preference_candidates: 1,
      approved_preferences: 1
    });
  });

  it("uses preference-level confidence supplied by the analyzing agent", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:demo",
        analysis_mode: "agent_supplied",
        text: "User: Use the compact table; a dark header might also be useful.",
        agent_analysis: {
          disagreements: [
            {
              user_text: "Use the compact table; a dark header might also be useful.",
              reason_is_clear: true,
              inferred_reason: "The first choice is explicit and the second is tentative.",
              demonstrated_preferences: [
                { content: "Monthly reports use compact tables.", confidence: 0.93 },
                { content: "Dark headers may improve visual contrast.", confidence: 0.61 }
              ],
              demonstrated_values: ["readable layouts"],
              confidence: 0.77
            }
          ]
        }
      }
    });

    const approved = review.json().preference_review.approved;
    expect(approved.map((memory: { confidence: number }) => memory.confidence).sort()).toEqual([0.61, 0.93]);
    expect(approved.map((memory: { metadata: { confidence_source: string } }) => memory.metadata.confidence_source)).toEqual([
      "agent_supplied_preference",
      "agent_supplied_preference"
    ]);
  });

  it("blocks a heuristic contradiction with an existing preference", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "Demo user prefers concise release reports.",
        scope: { kind: "project", project_id: "project:demo" },
        confidence: 0.9
      }
    });

    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:demo",
        analysis_mode: "agent_supplied",
        text: "User: Release reports should be detailed.",
        agent_analysis: {
          disagreements: [
            {
              user_text: "Release reports should be detailed.",
              reason_is_clear: true,
              inferred_reason: "The report should include full detail.",
              demonstrated_preferences: ["Demo user prefers detailed release reports."],
              demonstrated_values: ["complete release information"]
            }
          ]
        }
      }
    });

    const body = review.json();
    expect(body.preference_review.summary.blocked_preferences).toBe(1);
    expect(body.conflict_candidates).toHaveLength(1);
  });

  it("keeps global and project-local preference layers separate", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "Demo project timestamps use the local timezone.",
        scope: { kind: "project", project_id: "project:demo" },
        confidence: 0.9,
        metadata: { knowledge_scope: "project_local" }
      }
    });

    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:demo",
        analysis_mode: "agent_supplied",
        text: "User: Across all projects, archive timestamps should use UTC.",
        agent_analysis: {
          disagreements: [
            {
              user_text: "Across all projects, archive timestamps should use UTC.",
              reason_is_clear: true,
              inferred_reason: "This convention applies globally.",
              demonstrated_preferences: [
                {
                  content: "Demo user prefers UTC archive timestamps across all projects.",
                  knowledge_scope: "global"
                }
              ],
              demonstrated_values: ["consistent timestamps"]
            }
          ]
        }
      }
    });

    const body = review.json();
    expect(body.conflict_candidates).toHaveLength(0);
    expect(body.preference_review.approved[0].metadata.knowledge_scope).toBe("global");
  });

  it("returns related records as conflict candidates for agent review", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "Demo user prefers changelog entries grouped by component.",
        scope: { kind: "project", project_id: "project:demo" },
        confidence: 0.9
      }
    });

    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:demo",
        analysis_mode: "agent_supplied",
        text: "User: Keep grouping changelog entries by component.",
        agent_analysis: {
          disagreements: [
            {
              user_text: "Keep grouping changelog entries by component.",
              reason_is_clear: true,
              inferred_reason: "The existing grouping convention was reaffirmed.",
              demonstrated_preferences: ["Demo user prefers changelog entries grouped by component."],
              demonstrated_values: ["navigable release notes"]
            }
          ]
        }
      }
    });

    const body = review.json();
    expect(body.conflict_candidates).toHaveLength(1);

    const resolution = await app.inject({
      method: "POST",
      url: `/v1/conflicts/${body.conflict_candidates[0].id}/resolve`,
      payload: { action: "mark_compatible", note: "The new observation reinforces the existing preference." }
    });

    expect(resolution.statusCode).toBe(200);
    expect(resolution.json().candidate.status).toBe("approved");
  });

  it("does not run deterministic extraction during agent-supplied review", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        project_id: "project:demo",
        analysis_mode: "agent_supplied",
        text: "User: Remember that the sample catalog has seven sections.",
        agent_analysis: { disagreements: [] }
      }
    });

    expect(review.statusCode).toBe(201);
    expect(review.json().summary).toMatchObject({ extracted_candidates: 0, approved: 0, blocked: 0 });
  });

  it("does not infer a conflict from unrelated uses of 'instead of'", () => {
    const reason = contradictionReason(
      {
        id: "cand:test",
        type: "Preference",
        content: "Demo user prefers PDF reports instead of HTML reports.",
        scope: { kind: "project", project_id: "project:demo" },
        confidence: 0.82,
        risk: "low",
        needs_confirmation: false,
        privacy_level: "normal",
        status: "pending",
        source_id: "src:test",
        metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "node:test",
        type: "Preference",
        content: "Demo user prefers UTC timestamps instead of local timestamps.",
        scope: { kind: "project", project_id: "project:demo" },
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
