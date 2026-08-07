# Участие в разработке

Спасибо за интерес к Agent Memory. Обсуждение архитектуры, исправления,
документация и небольшие воспроизводимые улучшения приветствуются.

## Перед началом

1. Для крупной функции сначала создайте issue и согласуйте границы изменения.
2. Для уязвимости не создавайте публичный issue — следуйте [SECURITY.md](SECURITY.md).
3. Не добавляйте базы данных, резервные копии, реальные диалоги, credentials или
   другие пользовательские данные.

## Локальная разработка

```bash
git clone https://github.com/MaskusNES/memaskus.git
cd memaskus
npm ci
npm run typecheck
npm test
npm run build
```

Для разработки сервера:

```bash
npm run dev
```

## Pull request

- держите PR небольшим и сфокусированным;
- опишите проблему, выбранное решение и пользовательский эффект;
- добавьте или обновите тесты для изменённого поведения;
- обновите README и другие инструкции, если меняется внешний контракт;
- сохраняйте обратную совместимость либо явно укажите breaking change;
- убедитесь, что `typecheck`, тесты и production build проходят локально;
- не включайте сгенерированный `dist/`, `data/`, `backups/`, `.env` и логи.

## Стиль проекта

- TypeScript в strict mode;
- ESM imports с `.js` suffix в исходном коде;
- thin HTTP/MCP adapters, бизнес-правила в `src/domain`;
- parameterized SQL вместо конкатенации пользовательского ввода;
- явное scope и `knowledge_scope` для операций с памятью;
- безопасная деградация внешних интеграций без потери локального recall.

## Изменения схемы

При изменении SQLite-схемы:

1. увеличьте `CURRENT_SCHEMA_VERSION`;
2. добавьте идемпотентную миграцию;
3. сохраните данные старой схемы;
4. добавьте migration test и проверку future schema rejection;
5. проверьте backup/restore path.

## Commit messages

Желателен формат Conventional Commits:

```text
feat: add relation-specific graph weights
fix: preserve scope during candidate merge
docs: explain remote MCP setup
```
