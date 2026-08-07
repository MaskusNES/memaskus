import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { projectExistingPreferencesToProfile } from "../src/domain/profile.js";
import { buildServer } from "../src/server.js";

describe("mutable user profile API", () => {
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

  it("serves the profile dashboard", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/profile"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("User Profile Memory");
  });

  it("updates an existing profile slot instead of creating duplicate active slots", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/profile/slots",
      payload: {
        topic: "github",
        sub_topic: "issue_title_format",
        content: "Issue titles should begin with a component name.",
        confidence: 0.9,
        knowledge_scope: "global"
      }
    });

    expect(first.statusCode).toBe(201);
    const slotId = first.json().id;

    const second = await app.inject({
      method: "POST",
      url: "/v1/profile/slots",
      payload: {
        topic: "github",
        sub_topic: "issue_title_format",
        content: "Issue titles must begin with a bracketed component name.",
        confidence: 0.98,
        knowledge_scope: "global",
        reason: "explicit user correction"
      }
    });

    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(slotId);

    const profile = await app.inject({
      method: "GET",
      url: "/v1/profile?knowledge_scope=global"
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().slots).toHaveLength(1);
    expect(profile.json().slots[0]).toMatchObject({
      id: slotId,
      content: "Issue titles must begin with a bracketed component name.",
      confidence: 0.98
    });

    const details = await app.inject({
      method: "GET",
      url: `/v1/profile/slots/${slotId}`
    });
    expect(details.json().revisions).toHaveLength(2);
  });

  it("builds prompt-ready context from global and matching project-local slots", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/profile/slots",
      payload: {
        topic: "github",
        sub_topic: "issue_title_format",
        content: "Issue titles begin with a component name.",
        confidence: 0.98,
        knowledge_scope: "global"
      }
    });

    await app.inject({
      method: "POST",
      url: "/v1/profile/slots",
      payload: {
        topic: "memory_backend",
        sub_topic: "architecture",
        content: "This project keeps graph memory as evidence and profile slots as the read model.",
        confidence: 0.9,
        knowledge_scope: "project_local",
        project_id: "project:agent-memory"
      }
    });

    await app.inject({
      method: "POST",
      url: "/v1/profile/slots",
      payload: {
        topic: "other_project",
        sub_topic: "note",
        content: "This should not leak into another project context.",
        confidence: 0.9,
        knowledge_scope: "project_local",
        project_id: "project:other"
      }
    });

    const context = await app.inject({
      method: "POST",
      url: "/v1/profile/context",
      payload: {
        project_id: "project:agent-memory",
        prefer_topics: ["github"]
      }
    });

    expect(context.statusCode).toBe(200);
    expect(context.json().context).toContain("Issue titles begin with a component name.");
    expect(context.json().context).toContain("graph memory as evidence");
    expect(context.json().context).not.toContain("another project context");
  });

  it("projects approved preference memories into profile slots during review", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        conversation_id: "conv:profile-projection",
        project_id: "project:agent-memory",
        text: [
          "Assistant: I will use unstructured issue titles.",
          "User: No, issue titles should begin with a bracketed component name."
        ].join("\n"),
        analysis_mode: "agent_supplied",
        agent_analysis: {
          disagreements: [
            {
              user_text: "No, issue titles should begin with a bracketed component name.",
              assistant_context: "I will use unstructured issue titles.",
              reason_is_clear: true,
              inferred_reason: "The user corrected the issue-title convention.",
              demonstrated_preferences: [
                {
                  content: "GitHub issue titles should begin with a bracketed component name.",
                  confidence: 0.98,
                  knowledge_scope: "global",
                  metadata: {
                    domain: "github",
                    policy: "issue_title_format"
                  }
                }
              ],
              demonstrated_values: ["data safety"],
              confidence: 0.98
            }
          ]
        }
      }
    });

    expect(review.statusCode).toBe(201);
    expect(review.json().preference_review.summary.approved_preferences).toBe(1);

    const profile = await app.inject({
      method: "GET",
      url: "/v1/profile?knowledge_scope=global&topics=github"
    });

    expect(profile.statusCode).toBe(200);
    expect(profile.json().slots).toHaveLength(1);
    expect(profile.json().slots[0]).toMatchObject({
      topic: "github",
      sub_topic: "issue_title_format",
      content: "GitHub issue titles should begin with a bracketed component name."
    });
  });

  it("applies agent-supplied profile updates during conversation review", async () => {
    const review = await app.inject({
      method: "POST",
      url: "/v1/review/conversation",
      payload: {
        conversation_id: "conv:direct-profile-update",
        project_id: "project:agent-memory",
        text: "User: Prefix issue titles with the component name.",
        analysis_mode: "agent_supplied",
        agent_analysis: {
          profile_updates: [
            {
              topic: "github",
              sub_topic: "issue_title_format",
              content: "Prefix GitHub issue titles with the component name.",
              confidence: 0.97,
              knowledge_scope: "global",
              reason: "explicit user instruction"
            }
          ]
        }
      }
    });

    expect(review.statusCode).toBe(201);
    expect(review.json().summary.profile_updates).toBe(1);
    expect(review.json().profile_updates[0]).toMatchObject({
      topic: "github",
      sub_topic: "issue_title_format",
      content: "Prefix GitHub issue titles with the component name."
    });

    const context = await app.inject({
      method: "POST",
      url: "/v1/profile/context",
      payload: {
        prefer_topics: ["github"]
      }
    });

    expect(context.json().context).toContain("Prefix GitHub issue titles with the component name.");
  });

  it("migrates existing active preference nodes into profile slots idempotently", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        type: "Preference",
        content: "GitHub issue titles should begin with a bracketed component name.",
        scope: { kind: "global" },
        confidence: 0.98,
        metadata: {
          knowledge_scope: "global",
          domain: "github",
          policy: "issue_title_format"
        },
        source: {
          kind: "manual",
          title: "Existing preference"
        }
      }
    });

    const first = projectExistingPreferencesToProfile(db);
    expect(first).toMatchObject({ scanned: 1, projected: 1, skipped: 0 });

    const profile = await app.inject({
      method: "GET",
      url: "/v1/profile?knowledge_scope=global&topics=github"
    });
    expect(profile.json().slots).toHaveLength(1);
    const slotId = profile.json().slots[0].id;

    const detailsAfterFirstRun = await app.inject({
      method: "GET",
      url: `/v1/profile/slots/${slotId}`
    });
    expect(detailsAfterFirstRun.json().revisions).toHaveLength(1);

    const second = projectExistingPreferencesToProfile(db);
    expect(second).toMatchObject({ scanned: 1, projected: 1, skipped: 0 });

    const profileAfterSecondRun = await app.inject({
      method: "GET",
      url: "/v1/profile?knowledge_scope=global&topics=github"
    });
    expect(profileAfterSecondRun.json().slots).toHaveLength(1);
    expect(profileAfterSecondRun.json().slots[0].id).toBe(slotId);

    const detailsAfterSecondRun = await app.inject({
      method: "GET",
      url: `/v1/profile/slots/${slotId}`
    });
    expect(detailsAfterSecondRun.json().revisions).toHaveLength(1);
  });

  it("keeps an approved preference and its projected profile slot in sync", async () => {
    const ingested = await app.inject({
      method: "POST",
      url: "/v1/ingest/conversation",
      payload: {
        text: "User: I prefer catalog entries sorted alphabetically."
      }
    });
    const candidateId = ingested.json().candidates[0].id as string;
    const approved = await app.inject({
      method: "POST",
      url: `/v1/candidates/${candidateId}/approve`
    });
    expect(approved.statusCode).toBe(201);
    const memoryId = approved.json().id as string;

    let slot = db
      .prepare("SELECT id, content, status FROM profile_slots WHERE json_extract(metadata_json, '$.source_memory_id') = ?")
      .get(memoryId) as { id: string; content: string; status: string };
    expect(slot.content).toBe("I prefer catalog entries sorted alphabetically.");

    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/memories/${memoryId}`,
      payload: { content: "I prefer catalog entries sorted by publication year.", reason: "explicit correction" }
    });
    expect(updated.statusCode).toBe(200);
    slot = db.prepare("SELECT id, content, status FROM profile_slots WHERE id = ?").get(slot.id) as typeof slot;
    expect(slot.content).toBe("I prefer catalog entries sorted by publication year.");

    const archived = await app.inject({
      method: "POST",
      url: `/v1/memories/${memoryId}/archive`,
      payload: { reason: "preference retired" }
    });
    expect(archived.statusCode).toBe(200);
    slot = db.prepare("SELECT id, content, status FROM profile_slots WHERE id = ?").get(slot.id) as typeof slot;
    expect(slot.status).toBe("archived");
  });
});
