# MCP Setup

Agent Memory exposes a stdio MCP adapter. The adapter is intentionally thin: it
validates tool input and calls the HTTP service, which remains the owner of all
storage and domain logic.

## Local setup

Install, build and start the HTTP service:

```bash
npm ci
npm run build
npm start
```

Configure an MCP client with:

```text
command: node
args:
  - /absolute/path/to/memaskus/dist/mcp/server.js
env:
  MEMORY_API_URL: http://127.0.0.1:3010
  MEMORY_API_KEY: <optional, must match the HTTP service>
```

Use an absolute path because MCP clients often start child processes from a
different working directory. Restart the client after changing its MCP config.

## Remote setup over SSH

The recommended remote architecture keeps HTTP private to the VPS:

```text
MCP client
    |
    | stdio over SSH
    v
node /opt/agent-memory/current/dist/mcp/server.js
    |
    | http://127.0.0.1:39110
    v
agent-memory.service -> /var/lib/agent-memory/memory.sqlite
```

Generic stdio command:

```bash
ssh -i /path/to/ssh-key -o BatchMode=yes user@memory-host \
  "cd /opt/agent-memory/current && MEMORY_API_URL=http://127.0.0.1:39110 /usr/bin/node dist/mcp/server.js"
```

Use a restricted deployment account where possible. Never commit the SSH key,
host credentials or `MEMORY_API_KEY`.

To view the UI without exposing the HTTP port:

```bash
ssh -N -L 3010:127.0.0.1:39110 user@memory-host
```

Then open <http://127.0.0.1:3010/memory>, `/profile` or `/graph`.

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_context` | Build compact prompt-ready profile context. |
| `memory_get_profile` | Read mutable user profile slots. |
| `memory_recall` | Hybrid source-backed recall by query and scope. |
| `memory_list` | Explicitly list/search memories. |
| `memory_remember` | Create one explicit active memory. |
| `memory_update` | Correct an active memory and preserve a revision. |
| `memory_feedback` | Mark memory correct, wrong, outdated or mis-scoped. |
| `memory_review_conversation` | Review a dialogue and gate conflicts. |
| `memory_list_candidates` | List pending or blocked candidates. |
| `memory_approve_candidate` | Promote a candidate to active memory. |
| `memory_reject_candidate` | Reject a candidate. |
| `memory_merge_candidate` | Merge a candidate into an existing memory. |
| `memory_list_conflicts` | List open or resolved conflicts. |
| `memory_resolve_conflict` | Accept new, keep existing or mark compatible. |
| `memory_explain` | Show sources, revisions and graph links. |
| `memory_graph` | Return a graph snapshot. |
| `memory_archive` | Archive while preserving audit history. |
| `memory_delete` | Forget user-visible content and direct evidence. |

## Recommended agent workflow

1. At task startup, call `memory_context` for profile preferences and
   `memory_recall` for task-specific facts.
2. Keep `global` and `project_local` knowledge in separate layers.
3. Use `memory_remember` only for an explicit safe instruction to remember.
4. Review full dialogue text with `memory_review_conversation` before durable
   dialogue-derived writes.
5. Mark merely related conflict candidates compatible; ask the user to resolve
   real contradictions.
6. Never send credentials, tokens or private keys to memory tools.

MCP does not automatically receive a client's conversation history. The client
or agent must explicitly provide the relevant dialogue to
`memory_review_conversation`.

## Semantic recall

Embeddings are configured on the HTTP service, not on the MCP adapter:

```dotenv
MEMORY_EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=<from-a-secret-store>
MEMORY_EMBEDDING_MODEL=text-embedding-3-small
```

Only `normal` memories are sent to the embedding provider. Provider failures
degrade to local FTS5, graph and feedback retrieval.

## Troubleshooting

- Confirm the HTTP service: `curl http://127.0.0.1:3010/ready`.
- Run the configured `node .../dist/mcp/server.js` command manually.
- Check that `MEMORY_API_URL` points to the HTTP service from the MCP process.
- If API protection is enabled, pass the same `MEMORY_API_KEY` to both processes.
- Use an absolute script path and rebuild after code changes.
- Keep stdout reserved for MCP messages; application diagnostics belong on stderr.
