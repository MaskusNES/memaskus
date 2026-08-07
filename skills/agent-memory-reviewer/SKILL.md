---
name: agent-memory-reviewer
description: Review a current or finished agent conversation and save durable knowledge into the agent_memory graph through MCP. Use when the user asks to save, review, ingest or write a dialogue to memory; mentions graph memory, project memory, agent_memory, conflicts or contradiction review; or asks Codex to remember lessons, decisions, preferences or values demonstrated during a dialogue.
---

# Agent Memory Reviewer

## Goal

Save the full relevant dialogue as source evidence and write only safe,
durable, correctly scoped and non-conflicting knowledge. Semantic interpretation
belongs to the current agent; the memory service owns persistence and conflict
gating.

## Required tools

- `memory_review_conversation`;
- `memory_resolve_conflict` when a returned candidate needs classification;
- optionally `memory_recall` and `memory_graph` for additional context.

If these MCP tools are unavailable, say so clearly and do not claim that the
dialogue was saved.

## Workflow

1. Collect the full relevant dialogue with `User:` and `Assistant:` role labels.
2. Identify durable facts, decisions, preferences, corrections and user
   pushback. Omit one-off remarks and transient execution details.
3. For each correction or disagreement, determine whether the user's reason is
   clear from the dialogue.
4. Extract durable reusable preferences and values only when supported by
   evidence. Do not convert generic dissatisfaction into a preference.
5. Use the language required by the repository instructions; otherwise use the
   user's language.
6. Assign calibrated confidence:
   - `0.90-0.98` for explicit preferences and direct corrections;
   - `0.75-0.89` for strong inference or repeated behavior;
   - `0.55-0.74` for weaker inference that may need confirmation;
   - below `0.55`, ask a clarification question instead of writing memory.
7. Assign `knowledge_scope` to every durable item:
   - `global` only when it should apply across projects and dialogues;
   - `project_local` for project requirements, implementation decisions and
     repository-specific preferences.
8. Never create relationships or resolve conflicts across global and
   project-local graph layers.
9. Call `memory_review_conversation` with the full text,
   `analysis_mode: "agent_supplied"`, the project id from `AGENTS.md`, and
   structured `agent_analysis`.
10. Inspect every returned clarification question, conflict candidate and real
    conflict.
11. Resolve a merely related candidate with `mark_compatible` and a short
    rationale.
12. Show real contradictions to the user. Use `accept_new` or `keep_existing`
    only after the user explicitly chooses.

## Safety

- Never store credentials, access tokens, passwords, private keys, session
  cookies or recovery codes.
- Do not put secrets into the dialogue-review payload, skill files or repository
  instructions.
- Do not say memory is fully updated while clarification questions or real
  conflicts remain unresolved.

## Payload pattern

```json
{
  "project_id": "project:example",
  "conversation_id": "optional-id",
  "text": "User: ...\nAssistant: ...",
  "analysis_mode": "agent_supplied",
  "agent_analysis": {
    "disagreements": [
      {
        "user_text": "No, export the monthly report as PDF.",
        "assistant_context": "I will export the monthly report as HTML.",
        "reason_is_clear": true,
        "inferred_reason": "The user explicitly selected the monthly report format.",
        "demonstrated_preferences": [
          {
            "content": "The user prefers monthly reports in PDF format.",
            "confidence": 0.95,
            "knowledge_scope": "global"
          }
        ],
        "demonstrated_values": ["portable report output"],
        "confidence": 0.93
      }
    ]
  }
}
```

## Report after review

Report only what matters:

- how many durable memories were stored;
- which candidates were marked compatible;
- which clarification questions remain;
- which real conflicts still require user input.
