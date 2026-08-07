# Agent Memory

[![CI](https://github.com/MaskusNES/memaskus/actions/workflows/ci.yml/badge.svg)](https://github.com/MaskusNES/memaskus/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Общая, независимая от конкретного AI-агента память с HTTP API, MCP-адаптером,
графом знаний, проверяемыми источниками и управляемым жизненным циклом.

Agent Memory позволяет Codex, Claude Code и другим MCP-клиентам читать и
обновлять одно хранилище долговременных фактов, решений, предпочтений и задач.
Проект local-first: для базовой установки достаточно Node.js и одного файла
SQLite.

> Статус проекта: **alpha**. API и схема данных уже покрыты тестами, но до версии
> 1.0 возможны несовместимые изменения. Сервис рассчитан на одного доверенного
> пользователя или небольшую доверенную среду, а не на публичный multi-tenant SaaS.

![Архитектура Agent Memory](assets/agent-memory-business-architecture.png)

## Возможности

- единая память для любых клиентов через HTTP и MCP;
- типизированные узлы памяти и связи между ними;
- области видимости: global, user, project, workspace, agent и conversation;
- раздельные слои глобальных и проектных знаний;
- полнотекстовый поиск FTS5 с локальным token fallback;
- ограниченное распространение релевантности по графу до двух переходов;
- опциональный семантический поиск через подключаемый embedding-провайдер;
- ранжирование по тексту, смыслу, графу, confidence, свежести и feedback;
- источники, evidence и объяснение происхождения каждой записи;
- кандидаты памяти, ревью диалогов и разрешение противоречий;
- изменяемый профиль пользователя с историей версий;
- архивирование, исправление и удаление памяти;
- встроенные Memory, Profile и Graph UI;
- версионируемые миграции, проверяемые резервные копии и systemd-конфигурация;
- метрики качества поиска: Hit Rate, Recall, MRR и nDCG.

## Как устроен поиск

```mermaid
flowchart LR
  Q["Запрос и scope"] --> F["SQLite FTS5"]
  Q --> S["Semantic embeddings (опционально)"]
  F --> R["Общие seed-узлы"]
  S --> R
  R --> G["Граф до 2 hops"]
  G --> X["Scope и privacy filters"]
  X --> W["Confidence + recency + feedback"]
  W --> O["Ранжированные результаты с sources"]
```

Если embedding-провайдер не настроен или временно недоступен, recall продолжает
работать локально через FTS5, граф и feedback.

## Требования

- Node.js 22 или новее;
- npm 10 или новее;
- Git;
- Linux, macOS или Windows.

`better-sqlite3` обычно устанавливается из готового бинарного пакета. На редкой
платформе без подходящего бинарника могут понадобиться Python и C/C++ build tools.

## Быстрый старт

```bash
git clone https://github.com/MaskusNES/memaskus.git
cd memaskus
npm ci
npm run dev
```

При первом запуске сервис создаст `data/memory.sqlite` и автоматически применит
все миграции. По умолчанию он слушает только `127.0.0.1:3010`.

Проверка:

```bash
curl http://127.0.0.1:3010/health
curl http://127.0.0.1:3010/ready
```

Интерфейсы:

- Memory UI: <http://127.0.0.1:3010/memory>
- Profile UI: <http://127.0.0.1:3010/profile>
- Graph UI: <http://127.0.0.1:3010/graph>

Во втором терминале можно записать и найти первую память:

```bash
npm run memory -- remember "Use SQLite for the first release" --type Decision --project project:demo
npm run memory -- recall "Which database should we use?" --project project:demo --sources
```

## Production-сборка

```bash
npm ci
npm run build
npm test
npm start
```

Для запуска с файлом окружения используйте встроенную поддержку Node.js:

```bash
cp .env.example .env
npm run build
node --env-file=.env dist/index.js
```

Приложение само не загружает `.env`; переменные должны передаваться оболочкой,
process manager, контейнером или флагом `node --env-file`.

## Конфигурация

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Адрес HTTP-сервера. Для non-loopback обязателен API key. |
| `PORT` | `3010` | Порт HTTP-сервера. |
| `MEMORY_DB_PATH` | `data/memory.sqlite` | Путь к SQLite базе. |
| `MEMORY_API_KEY` | не задан | Защищает `/v1/*`; передаётся как `x-memory-api-key` или Bearer token. |
| `MEMORY_API_URL` | `http://127.0.0.1:3010` | Адрес API для CLI и MCP-процесса. |
| `MEMORY_EMBEDDING_PROVIDER` | выключен | `openai` для семантического recall; `none` или пустое значение для local-only. |
| `OPENAI_API_KEY` | не задан | Нужен только при `MEMORY_EMBEDDING_PROVIDER=openai`. |
| `MEMORY_EMBEDDING_MODEL` | `text-embedding-3-small` | Модель embeddings. |
| `MEMORY_EMBEDDING_DIMENSIONS` | размер модели | Необязательное сокращение размерности. |
| `MEMORY_EMBEDDING_TIMEOUT_MS` | `15000` | Таймаут запроса к провайдеру. |
| `MEMORY_EMBEDDING_BASE_URL` | OpenAI API | Необязательный совместимый endpoint. |

Полный безопасный пример находится в [.env.example](.env.example).

### Включение семантического поиска

```bash
export MEMORY_EMBEDDING_PROVIDER=openai
export OPENAI_API_KEY="set-this-in-your-secret-store"
export MEMORY_EMBEDDING_MODEL=text-embedding-3-small
npm start
```

Векторы создаются лениво и кэшируются в SQLite. Записи с уровнем
`sensitive` или `secret` никогда не передаются embedding-провайдеру. При
изменении, архивировании или удалении записи её сохранённый вектор очищается.

## MCP

Сначала запустите HTTP-сервис и соберите проект:

```bash
npm run build
npm start
```

Затем настройте любой MCP-клиент на stdio-процесс:

```text
command: node
args: ["/absolute/path/to/memaskus/dist/mcp/server.js"]
env:
  MEMORY_API_URL: http://127.0.0.1:3010
  MEMORY_API_KEY: <тот же ключ, если включён>
```

Основные MCP tools:

- `memory_context`, `memory_get_profile`, `memory_recall`, `memory_list`;
- `memory_remember`, `memory_update`, `memory_feedback`;
- `memory_review_conversation`;
- `memory_list_candidates`, `memory_approve_candidate`,
  `memory_reject_candidate`, `memory_merge_candidate`;
- `memory_list_conflicts`, `memory_resolve_conflict`;
- `memory_explain`, `memory_graph`, `memory_archive`, `memory_delete`.

Локальная и удалённая конфигурация описаны в [mcp-setup.md](mcp-setup.md),
а отдельный пример для Claude Code — в
[claude-code-memory-setup.md](claude-code-memory-setup.md).

## HTTP API

| Метод | Endpoint | Назначение |
| --- | --- | --- |
| `GET` | `/health`, `/ready` | Liveness и readiness. |
| `GET`, `POST` | `/v1/memories` | Список и создание памяти. |
| `PATCH`, `DELETE` | `/v1/memories/:id` | Исправление или удаление памяти. |
| `GET` | `/v1/memories/:id/explain` | Источники, revisions и связи. |
| `POST` | `/v1/memories/:id/feedback` | Оценка качества памяти. |
| `POST` | `/v1/memories/:id/archive` | Архивирование с сохранением истории. |
| `POST` | `/v1/recall` | Гибридный поиск. |
| `POST` | `/v1/links` | Создание графовой связи. |
| `GET` | `/v1/graph` | Снимок графа. |
| `POST` | `/v1/ingest/conversation` | Детерминированное извлечение кандидатов. |
| `POST` | `/v1/review/conversation` | Ревью диалога и conflict gating. |
| `GET` | `/v1/candidates` | Кандидаты на запись. |
| `POST` | `/v1/candidates/:id/{approve,reject,merge}` | Решение по кандидату. |
| `GET`, `POST` | `/v1/conflicts`, `/v1/conflicts/:id/resolve` | Просмотр и разрешение конфликтов. |
| `GET`, `POST` | `/v1/profile`, `/v1/profile/slots` | Mutable profile layer. |
| `POST` | `/v1/profile/context` | Компактный контекст для агента. |

Пример прямого HTTP-запроса:

```bash
curl -X POST http://127.0.0.1:3010/v1/recall \
  -H "content-type: application/json" \
  -d '{
    "query": "current storage decisions",
    "scope": {"kind": "project", "project_id": "project:demo"},
    "knowledge_scope": "project_local",
    "types": ["Decision", "Fact"],
    "limit": 10,
    "include_sources": true
  }'
```

## CLI

```bash
npm run memory -- --help
npm run memory -- remember --help
```

Доступны команды `remember`, `recall`, `explain`, `link`, `ingest`, `review`,
`candidates`, `approve`, `reject`, `conflicts` и `resolve-conflict`. CLI обращается
к `MEMORY_API_URL` и использует `MEMORY_API_KEY`, если он задан.

## Оценка качества retrieval

Dataset — JSON-массив запросов с ожидаемыми ID:

```json
[
  {
    "id": "storage-decision",
    "query": "Which database did we choose?",
    "scope": { "kind": "project", "project_id": "project:demo" },
    "knowledge_scope": "project_local",
    "expected_ids": ["node_example"]
  }
]
```

Запуск:

```bash
npm run memory:eval -- --dataset ./evals/retrieval.json --db ./data/memory.sqlite --limit 10
```

## Резервные копии

Не копируйте работающий SQLite-файл обычной файловой командой. Используйте
встроенный online backup:

```bash
npm run build
node dist/cli/backup-database.js backup data/memory.sqlite backups/memory.sqlite.bak
node dist/cli/backup-database.js verify backups/memory.sqlite.bak
```

Каталоги `data/`, `backups/` и `.env` исключены из Git.

## Развёртывание на VPS

Готовые systemd unit и безопасные скрипты находятся в [deploy](deploy).
Пошаговая инструкция: [remote-memory-vps-setup.md](remote-memory-vps-setup.md).

Рекомендуемая схема — держать HTTP-сервис на loopback-интерфейсе VPS, а MCP
запускать через SSH. Если API всё же публикуется в сеть, используйте TLS,
firewall/reverse proxy и уникальный `MEMORY_API_KEY`.

## Безопасность и приватность

- очевидные API keys, токены и private keys отклоняются или редактируются;
- `sensitive` и `secret` content скрывается из публичных ответов;
- глобальный и project-local слои не смешиваются автоматически;
- реальные противоречия требуют явного решения пользователя;
- база SQLite **не зашифрована** — защищайте файл правами ОС и шифрованием диска;
- встроенный API key — базовый барьер, а не полноценная multi-user IAM-система.

Подробнее и порядок сообщения об уязвимостях: [SECURITY.md](SECURITY.md).

## Разработка

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Правила оформления изменений находятся в [CONTRIBUTING.md](CONTRIBUTING.md),
история релизов — в [CHANGELOG.md](CHANGELOG.md).

## Структура проекта

```text
src/db/       SQLite connection, schema, migrations and backup
src/domain/   graph, recall, privacy, profile and lifecycle logic
src/routes/   Fastify HTTP routes
src/mcp/      MCP stdio adapter over HTTP
src/cli/      operational and maintenance commands
public/       built-in Memory, Profile and Graph UI
deploy/       systemd installation and restore scripts
tests/        integration, security and retrieval tests
```

## Roadmap

- стабильный API-контракт 1.0 и OpenAPI-схема;
- фоновые очереди embeddings для больших баз;
- vector index вместо линейного cosine scan;
- дополнительные embedding-провайдеры;
- улучшенное entity resolution и relation-specific graph ranking;
- контейнерный deployment и наблюдаемость;
- SDK для TypeScript и Python.

## Лицензия

[MIT](LICENSE) © 2026 MaskusNES contributors.
