# MCP Setup

The memory system exposes an MCP server over stdio.

The MCP server is a thin adapter over the local HTTP memory service. Start the HTTP service first from the project directory:

```powershell
cd "C:\Users\Aorus\OneDrive\Документы\memaskus"
npm run dev
```

The MCP stdio server itself should be launched with a direct Node command, not through `npm`:

```powershell
C:\Users\Aorus\AppData\Local\OpenAI\Codex\runtimes\cua_node\1b23c930bdf84ed6\bin\node.exe C:\Users\Aorus\OneDrive\Документы\memaskus\dist\src\mcp\server.js
```

If the memory HTTP service runs somewhere other than `http://127.0.0.1:3010`, set `MEMORY_API_URL` for the MCP server process.

## Example MCP Client Config

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "C:\\Users\\Aorus\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\1b23c930bdf84ed6\\bin\\node.exe",
      "args": ["C:\\Users\\Aorus\\OneDrive\\Документы\\memaskus\\dist\\src\\mcp\\server.js"],
      "cwd": "C:\\Users\\Aorus",
      "env": {
        "MEMORY_API_URL": "http://127.0.0.1:3010"
      }
    }
  }
}
```

Do not use `npm run mcp` as an MCP stdio command in Codex. `npm` prints a script banner to stdout, and MCP stdio requires stdout to contain only JSON-RPC messages.

The direct Node command should use an absolute server path. This avoids Windows stdio launch issues with relative paths and Unicode project directories.

## Tools

- `memory_recall`
  Recall memories by query and optional scope.

- `memory_remember`
  Store one explicit memory node.

- `memory_review_conversation`
  Send full dialogue text for source storage, disagreement-driven preference extraction, contradiction checking, and safe graph writes.

- `memory_list_conflicts`
  List open or resolved conflicts.

- `memory_resolve_conflict`
  Resolve a conflict after user clarification with `accept_new`, `keep_existing`, or `mark_compatible`.

- `memory_explain`
  Explain one memory using sources and graph links.

- `memory_graph`
  Return graph nodes and edges for visualization or inspection.

## Important Behavior

MCP does not automatically know a client's full conversation history. The client or agent must pass dialogue text into `memory_review_conversation`.

`memory_review_conversation` supports two analysis modes:

- `agent_supplied` is the default for MCP calls. It lets the current LLM agent do the reasoning using its existing subscription/session, then pass structured disagreement analysis to MCP. The memory service still stores the dialogue source, searches graph memory, returns `conflict_candidates` for agent review, and writes only candidates that have no related memory candidates or have been marked compatible.
- `heuristic` is an explicit local fallback. Pass `"analysis_mode": "heuristic"` when the memory service itself should try to detect user pushback and infer preferences.

In `agent_supplied` mode, the legacy deterministic sentence extractor is not run. The dialogue is saved as a source, but durable memory candidates come only from `agent_analysis`.

Durable memory content should be written in Russian unless the user explicitly asks for another language. This applies to `demonstrated_preferences[].content`, clarification questions, and conflict-resolution notes.

Approved preference metadata includes `confidence_source`:

- `agent_supplied_preference`
- `agent_supplied_disagreement`
- `fallback_inferred`

Example `agent_supplied` payload:

```json
{
  "project_id": "project:agent-memory",
  "text": "Assistant: Я буду автоматически записывать память.\nUser: Нет, стоп. Я хочу подтверждение перед долговременными записями.",
  "analysis_mode": "agent_supplied",
  "agent_analysis": {
    "disagreements": [
      {
        "user_text": "Нет, стоп. Я хочу подтверждение перед долговременными записями.",
        "assistant_context": "Я буду автоматически записывать память.",
        "reason_is_clear": true,
        "inferred_reason": "Пользователь возразил против автоматической долговременной записи в память без явного подтверждения.",
        "demonstrated_preferences": [
          {
            "content": "Пользователь предпочитает явное подтверждение перед долговременной записью в память.",
            "confidence": 0.93
          }
        ],
        "demonstrated_values": [
          "контроль пользователя над постоянным состоянием"
        ],
        "confidence": 0.9
      }
    ]
  }
}
```

The intended end-of-dialogue flow is:

1. Agent calls `memory_review_conversation` with the conversation text.
2. The dialogue is saved as a source.
3. User pushback against assistant proposals is analyzed first for demonstrated preferences and values.
4. If the reason for pushback is unclear, the response includes `preference_review.clarification_questions`; the agent should ask the user before storing that preference.
5. Clear preference candidates are compared with relevant graph memory.
6. If `conflict_candidates` are returned, the agent decides whether they are real conflicts.
7. If a `conflict_candidate` is not a real conflict, the agent calls `memory_resolve_conflict` with `mark_compatible`.
8. If the agent is unsure, it asks the user a focused clarification question and leaves the candidate unresolved until the user answers.
9. If a real conflict is found, the agent asks the user the returned question.
10. After clarification, the agent calls `memory_resolve_conflict`.
11. Only resolved, compatible, or non-conflicting information becomes active graph memory.
