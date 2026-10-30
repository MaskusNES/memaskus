# Issue 6: технический аудит

## Совместимость базы

Прежний неизменённый загрузчик отклоняет `user_version > 5`. Поэтому расширение
ревизий аддитивно: `schema_migrations.version=6`, совместимый `user_version=5`.
Добавлены только столбцы `previous_privacy_level` / `next_privacy_level` у двух
таблиц истории. Существующие строки сохраняются; неизвестная приватность старых
значений считается `secret`. Новые значения получают независимые уровни.
Загрузчик старого релиза, его схема и функция времени зафиксированы без изменений
в `tests/fixtures/previous-release/`. Автотест создаёт старую заполненную базу,
обновляет её, открывает прежним загрузчиком и снова новым. Совместимость открытия
не означает переноса новых гарантий приватности в старый исполняемый код.

## Покрытие и повторный Critic

Архивные идентификаторы в исходной задаче не приложены; ниже тематические ID,
использованные в повторном независимом Critic-ревью. Номера не являются номерами
GitHub issues. Issues #4/#5 не изменялись.

| ID | Проверка | Регрессия |
|---|---|---|
| JSON credentials | Кавычки password/api_key, источники, публичные ответы | audit-regressions |
| PEM | Полный и незавершённый блок | audit-regressions |
| Shared sources | Смешанные слои/приватность и legacy evidence | audit-regressions |
| History privacy | История после замены защищённого текста публичным | audit-regressions |
| Database rollback | Добавочная миграция и прежний загрузчик | audit-regressions + fixture |
| Merge forgetting | Все merge, производные, независимый evidence | audit-regressions |
| Profile ownership | PATCH/archive/DELETE прежнего владельца | audit-regressions |
| Multiple projections | accept_new заменяет несколько активных проекций | audit-regressions |
| Global supersession | Разные физические проекты без межслойных связей | audit-regressions |
| Atomic profile PATCH | Неизвестные source_id/memory_id, снимок таблиц | audit-regressions |
| Protected editors | Нетекстовые правки и явная замена sensitive/secret | audit-ui |
| Explorer search-before-pagination | Сохранено целевое поведение; >200, %, _, публичные поля и counts | audit-regressions + memory-list-search |
| CLI POST | approve/reject, настоящий HTTP и ошибки | audit-regressions |
| Embedding race | DELETE/archive/content/sensitive/secret во время await | audit-regressions |
| UI state/history | История после fillEditor; feedback сохраняет wrapper | audit-ui |
| Edge scope mutation | Атомарное отклонение смены слоя/проекта, explain/graph/recall | audit-regressions |

В исходном дереве Explorer фактически ограничивал память первыми 200 записями до
поиска; существующие тесты проверяли поиск только на коротком списке. Теперь весь
видимый активный набор проходит публичную проекцию и поиск до общего limit.
Семантика остальных счётчиков сохранена, включая bounded sources.

Critic воспроизвёл на синтетических данных и помог закрыть дополнительные случаи:
legacy evidence с полным диалогом, surviving evidence после забывания, история
независимого владельца, required у защищённого редактора и повторяющиеся source IDs
за пределами первой страницы.

## Preview QA

`tests/preview-audit-qa.mjs` содержит сценарий same-origin fetch без ключей и shell.
После выкладки проверяемого SHA открыть preview `/memory`, вставить функцию в
консоль браузера, убрав `export`, и выполнить `await runAuditPreviewQA()`.
Используются только синтетические записи `project:qa`, после проверки они
забываются/архивируются. Проверяются страницы, recall, изоляция, Explorer,
credentials, приватность истории, атомарность профиля, feedback и archive.
Миграции, CLI, гонки и обработчики UI дополнительно проверяются автотестами.

В рабочей песочнице preview `/health` доступен, но выкладка этой сборки в его
каталог и управление systemd недоступны. Поэтому результат QA размещённого preview
для нового SHA здесь не заявляется. Оркестратору нужно выложить сборку и выполнить
сценарий выше. Production требует отдельного одобрения проверенного SHA.

## Результат локальной проверки

- `npm ci --prefer-offline --no-audit --no-fund` с заданными cache/devdir: успешно.
- `npm run typecheck`: успешно.
- `npm test`: 22 файла, 143 теста успешно; из них 31 новая регрессия.
- `python3 tests/deploy-installer.test.py`: все три сценария успешно.
- `npm run build`: успешно.
- Сценарий `runAuditPreviewQA` против собранного `dist`, настоящего HTTP-сервера
  на случайном loopback-порту и отдельной in-memory БД: 15 проверок успешно.
  Это локальная проверка сборки, а не QA размещённого preview.
- Итоговый независимый Critic: открытых дефектов по 16 тематическим ID нет.
- `git diff --check`: успешно. Коммиты, push, переключение веток и production
  deployment не выполнялись; installer и systemd units не менялись.
