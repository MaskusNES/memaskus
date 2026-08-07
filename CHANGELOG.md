# Changelog

Все заметные изменения проекта будут документироваться в этом файле. Формат
основан на [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), версии
следуют [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-07

### Added

- HTTP API, CLI и MCP stdio adapter для общей памяти агентов.
- SQLite graph store с версиями схемы и автоматическими миграциями.
- Source-backed memory, candidates, conflict review и mutable profile layer.
- Memory, Profile и Graph UI.
- Гибридный recall через FTS5, token fallback, graph traversal и feedback.
- Опциональные OpenAI embeddings с безопасной локальной деградацией.
- Retrieval evaluation с Hit Rate, Recall, MRR и nDCG.
- Backup verification, systemd deployment и privacy hardening.
