# Промпт проверки после перезапуска OpenCode

Выполни только read-only проверку общей памяти `agent_memory`.

1. Подтверди, что MCP server `agent_memory` и его tools доступны в этой активной
   сессии. Учитывай, что OpenCode может добавить к именам tools префикс
   `agent_memory_`.
2. Вызови `memory_recall` со следующими параметрами:
   - query: `global user preferences facts operating rules`
   - scope.kind: `global`
   - knowledge_scope: `global`
   - types: `Preference`, `Fact`, `Decision`
   - limit: `50`
   - include_sources: `false`
3. Пустой global result допустим и не означает ошибку подключения.
4. Определи стабильный project id текущего workspace:
   - сначала из `AGENTS.md`;
   - затем по canonical Git remote;
   - если определить нельзя, не выдумывай его и не выполняй project-local вызов.
5. Если project id определён, вызови `memory_context` и `memory_get_profile` для
   `knowledge_scope: project_local`.
6. Ничего не создавай, не обновляй, не архивируй, не удаляй и не разрешай
   конфликты.
7. Сообщи только:
   - состояние MCP;
   - какие read tools реально вызваны;
   - project id, если найден;
   - количество global и project-local результатов;
   - доступность `@agent-memory-reviewer`, `/memory-review` и `/memory-status`.

Если какой-либо tool отсутствует, покажи точное имя доступных tools
`agent_memory` и остановись. Не изменяй MCP-конфигурацию без отдельного запроса.
