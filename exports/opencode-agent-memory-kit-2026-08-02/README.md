# OpenCode Agent Memory Rules Kit

Этот пакет переносит на OpenCode агентную схему работы с уже подключённым
`agent_memory` MCP.

## Предварительное условие

MCP уже настроен отдельно и доступен в OpenCode. Пакет:

- не разворачивает memory service;
- не меняет SSH;
- не редактирует `opencode.json`;
- не создаёт и не переносит credentials;
- не меняет существующие MCP servers.

Он устанавливает только правила поведения агентов, memory-reviewer и удобные
команды.

## Состав

- `INSTALL_PROMPT.md` — промпт установки в OpenCode.
- `VERIFY_PROMPT.md` — read-only проверка после перезапуска.
- `global/AGENTS.md` — глобальная политика bootstrap и работы с памятью.
- `agents/agent-memory-reviewer.md` — специализированный subagent.
- `commands/memory-review.md` — команда `/memory-review`.
- `commands/memory-status.md` — команда `/memory-status`.
- `project/AGENTS.memory-snippet.md` — блок для стабильного project id.
- `docs/SOURCES.md` — официальные источники OpenCode.

## Куда устанавливаются файлы

```text
~/.config/opencode/
  AGENTS.md
  agents/agent-memory-reviewer.md
  commands/memory-review.md
  commands/memory-status.md
```

На Windows `~` означает профиль пользователя, под которым работает OpenCode. В
WSL используется Linux home внутри WSL.

## Установка

1. Распакуйте ZIP на компьютере с OpenCode.
2. Откройте `INSTALL_PROMPT.md` и подставьте абсолютный путь к пакету.
3. Вставьте промпт целиком в OpenCode.
4. Разрешите установщику объединить правила и скопировать agent/commands.
5. Перезапустите OpenCode.
6. Вставьте `VERIFY_PROMPT.md`.

## Логика после установки

```text
OpenCode primary agent
  -> read global and project context from existing agent_memory MCP
  -> work with the user
  -> invoke @agent-memory-reviewer when dialogue must be saved
  -> reviewer performs semantic analysis and conflict review
  -> agent_memory persists and retrieves graph knowledge
```

## Важные правила

- `AGENTS.md` оркестрирует память, но не хранит пользовательские факты.
- `global` и `project_local` остаются отдельными слоями.
- MCP не получает историю разговора автоматически: primary agent передаёт
  reviewer-у полный релевантный диалог с ролями.
- Настоящие противоречия показываются пользователю до разрешения.
- Credentials, токены, пароли и private keys не записываются в graph memory или
  instruction files.
