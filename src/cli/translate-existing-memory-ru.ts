import Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { nowIso } from "../shared/time.js";

const translations = new Map<string, string>([
  [
    "It should be agent-independent, usable by Codex, code, and other systems; storage should be graph-based; and there should be an automatic mechanism that fills memory from dialogues.",
    "Система памяти должна быть независимой от конкретного агента, доступной для Codex, кода и других систем; хранение должно быть графовым; также нужен автоматический механизм наполнения памяти на основе диалогов."
  ],
  [
    "Call memory for project project:agent-memory and check what we decided about storage.",
    "Вызвать память по проекту project:agent-memory и проверить, что было решено про storage."
  ],
  [
    "Explained it is in global ~/.codex/skills, usable from any project after new sessions load it; MCP and memory HTTP service still need to be available.",
    "Было объяснено, что skill лежит в глобальном ~/.codex/skills и доступен из любого проекта после загрузки новой сессии; при этом MCP и HTTP-сервис памяти все равно должны быть доступны."
  ],
  [
    "User wants agents to distinguish clearly between reading existing memory and writing dialogue-derived memory into the graph.",
    "Пользователь хочет, чтобы агенты четко различали чтение существующей памяти и запись новой памяти, извлеченной из диалога, в граф."
  ],
  [
    "User prefers integrations to be verified as actually available in the active agent session before being treated as working.",
    "Пользователь предпочитает считать интеграции рабочими только после проверки, что они реально доступны в активной сессии агента."
  ],
  [
    "User expects failure causes to be diagnosed explicitly when a planned tool or integration is unavailable.",
    "Пользователь ожидает явной диагностики причин сбоя, когда запланированный инструмент или интеграция недоступны."
  ],
  [
    "User wants memory creation from dialogues to prioritize moments where the user disagreed with, corrected, or rejected an LLM implementation proposal.",
    "Пользователь хочет, чтобы создание памяти из диалогов в первую очередь учитывало моменты, где пользователь не согласился, исправил или отверг предложенную LLM реализацию."
  ],
  [
    "User wants unclear preference inferences to trigger clarification instead of being silently written.",
    "Пользователь хочет, чтобы неясные выводы о предпочтениях приводили к уточняющему вопросу, а не записывались молча."
  ],
  [
    "User wants new preference candidates to be compared with existing graph memory before durable writes.",
    "Пользователь хочет, чтобы новые кандидаты предпочтений сравнивались с существующей графовой памятью перед долговременной записью."
  ],
  [
    "User wants conflicts between new dialogue-derived knowledge and existing memory to be shown explicitly and resolved with the user before writing.",
    "Пользователь хочет, чтобы конфликты между новой информацией из диалога и существующей памятью явно показывались и разрешались с пользователем перед записью."
  ],
  [
    "User prefers using the active chat agent's existing subscription/session for semantic dialogue analysis when possible, rather than requiring a separate backend LLM API key.",
    "Пользователь предпочитает по возможности использовать текущую подписку или сессию активного чат-агента для семантического анализа диалога, вместо требования отдельного backend LLM API-ключа."
  ],
  [
    "User is comfortable with MCP receiving structured analysis from the current agent while the MCP service handles storage, retrieval, and conflict gating.",
    "Пользователю подходит схема, где MCP получает структурированный анализ от текущего агента, а MCP-сервис отвечает за хранение, извлечение и проверку конфликтов."
  ],
  [
    "User prefers semantic memory extraction to be LLM/agent-supplied rather than regex-driven by default.",
    "Пользователь предпочитает, чтобы семантическое извлечение памяти по умолчанию выполнялось LLM/агентом, а не regex-логикой."
  ],
  [
    "User accepts regex only as explicit fallback or for technical tokenization, not as the main preference-analysis mechanism.",
    "Пользователь допускает regex только как явный fallback или для технической токенизации, но не как основной механизм анализа предпочтений."
  ],
  [
    "User wants MCP memory review calls to default to agent-supplied semantic analysis, with heuristic extraction enabled only when explicitly requested.",
    "Пользователь хочет, чтобы вызовы MCP memory review по умолчанию использовали семантический анализ от агента, а эвристическое извлечение включалось только по явному запросу."
  ],
  [
    "User prefers agent_memory MCP to be configured globally for all Codex projects rather than separately per project.",
    "Пользователь предпочитает, чтобы agent_memory MCP был настроен глобально для всех проектов Codex, а не отдельно для каждого проекта."
  ],
  [
    "User prefers reusable Codex skills for repeated agent workflows instead of repeating long prompts manually.",
    "Пользователь предпочитает переиспользуемые Codex skills для повторяющихся агентских workflow вместо ручного повторения длинных промптов."
  ],
  [
    "The user corrected a semantic mismatch: recalling existing memory is not the same operation as reviewing a dialogue and writing new graph memory.",
    "Пользователь исправил семантическое несоответствие: извлечение существующей памяти и анализ диалога с записью новой графовой памяти - разные операции."
  ],
  [
    "The user objected because configuration claims were being treated as sufficient even though the active agent session did not expose the expected MCP tool.",
    "Пользователь возразил, потому что заявления о конфигурации считались достаточными, хотя активная сессия агента не показывала ожидаемый MCP tool."
  ],
  [
    "The user wanted disagreement with the assistant to be treated as especially valuable evidence for durable preferences, with explicit clarification and conflict-gating before writes.",
    "Пользователь хотел, чтобы несогласие с агентом считалось особенно ценным свидетельством долговременных предпочтений, с явным уточнением и проверкой конфликтов перед записью."
  ],
  [
    "The user wanted to avoid requiring a separate paid API path for memory analysis when an agent in a subscription-based chat could already perform the reasoning.",
    "Пользователь хотел избежать требования отдельного платного API-пути для анализа памяти, если агент в чате по подписке уже может выполнить рассуждение."
  ],
  [
    "The user was checking whether semantic preference extraction still depended on brittle regex logic after introducing agent-supplied analysis.",
    "Пользователь проверял, зависит ли семантическое извлечение предпочтений от хрупкой regex-логики после введения agent-supplied анализа."
  ],
  [
    "The user confirmed the design choice that MCP calls should default to agent-supplied analysis rather than automatic regex heuristics.",
    "Пользователь подтвердил проектное решение: MCP-вызовы должны по умолчанию использовать agent-supplied анализ, а не автоматические regex-эвристики."
  ],
  [
    "The user wanted the memory review workflow packaged as a reusable Codex skill available across projects.",
    "Пользователь хотел упаковать workflow анализа памяти в переиспользуемый Codex skill, доступный в разных проектах."
  ],
  [
    "The user wanted the infrastructure, not just the instruction, to be globally available so memory can be used from any project without per-project setup.",
    "Пользователь хотел, чтобы глобально доступной была именно инфраструктура, а не только инструкция, чтобы память можно было использовать из любого проекта без отдельной настройки."
  ],
  ["precise operation semantics", "точная семантика операций"],
  ["clarity about durable state changes", "ясность изменений постоянного состояния"],
  ["operational truth over configuration claims", "операционная достоверность важнее заявленной конфигурации"],
  ["transparent diagnosis", "прозрачная диагностика"],
  ["learning from correction", "обучение на исправлениях"],
  ["epistemic humility", "эпистемическая осторожность"],
  ["user control over memory", "контроль пользователя над памятью"],
  ["consistency of persistent knowledge", "согласованность постоянного знания"],
  ["practical cost control", "практический контроль затрат"],
  ["separation of reasoning from storage", "разделение рассуждения и хранения"],
  ["reuse of existing agent capabilities", "переиспользование существующих возможностей агента"],
  ["robust semantic analysis", "устойчивый семантический анализ"],
  ["explicit fallback behavior", "явное fallback-поведение"],
  ["predictable tool behavior", "предсказуемое поведение инструмента"],
  ["LLM-first semantic extraction", "семантическое извлечение с приоритетом LLM"],
  ["workflow reuse", "переиспользование workflow"],
  ["low-friction agent operation", "низкое трение в работе агента"],
  ["cross-project continuity", "непрерывность между проектами"],
  ["reduced setup friction", "снижение трения настройки"],
  ["one statement negates a closely related existing memory", "одно утверждение отрицает близко связанную существующую запись памяти"],
  [
    "User clarified these are not contradictory. The existing memory is about using the active chat agent/subscription for semantic analysis instead of a backend API key; the new memory is about packaging repeated workflows as reusable Codex skills. Keep both.",
    "Пользователь уточнил, что это не противоречие. Существующая запись касается использования активного чат-агента/подписки для семантического анализа вместо backend API-ключа; новая запись касается упаковки повторяющихся workflow в переиспользуемые Codex skills. Нужно оставить обе."
  ]
]);

function translate(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  if (translations.has(value)) {
    return translations.get(value) as string;
  }

  let translated = value;
  for (const [source, target] of [...translations.entries()].sort((left, right) => right[0].length - left[0].length)) {
    translated = translated.split(source).join(target);
  }
  if (translated !== value) {
    return translated;
  }

  if (value.startsWith("In my existing knowledge base it says:")) {
    return value
      .replace("In my existing knowledge base it says:", "В моей существующей базе знаний сказано:")
      .replace("During this conversation you said:", "В ходе этого диалога было сказано:")
      .replace(
        "These seem to contradict each other. Please explain why this contradiction exists, or confirm that the new information is more correct than the old memory.",
        "Эти утверждения кажутся противоречивыми. Объясни, почему возникло это противоречие, или подтверди, что новая информация точнее старой записи."
      );
  }

  return value;
}

function translateJson(value: unknown): unknown {
  if (typeof value === "string") {
    return translate(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => translateJson(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translateJson(item)]));
  }

  return value;
}

function updateContentTable(db: Database.Database, table: "nodes" | "candidates"): number {
  const rows = db.prepare(`SELECT id, content, metadata_json FROM ${table}`).all() as Array<{
    id: string;
    content: string;
    metadata_json: string;
  }>;
  const update = db.prepare(`UPDATE ${table} SET content = ?, metadata_json = ?, updated_at = ? WHERE id = ?`);
  let changed = 0;

  for (const row of rows) {
    const translatedContent = translate(row.content) as string;
    const translatedMetadata = JSON.stringify(translateJson(JSON.parse(row.metadata_json)));
    if (translatedContent !== row.content || translatedMetadata !== row.metadata_json) {
      update.run(translatedContent, translatedMetadata, nowIso(), row.id);
      changed += 1;
    }
  }

  return changed;
}

function updateNodeSources(db: Database.Database): number {
  const rows = db.prepare("SELECT node_id, source_id, evidence_text FROM node_sources").all() as Array<{
    node_id: string;
    source_id: string;
    evidence_text: string | null;
  }>;
  const update = db.prepare("UPDATE node_sources SET evidence_text = ? WHERE node_id = ? AND source_id = ?");
  let changed = 0;

  for (const row of rows) {
    const translatedEvidence = translate(row.evidence_text);
    if (translatedEvidence !== row.evidence_text) {
      update.run(translatedEvidence, row.node_id, row.source_id);
      changed += 1;
    }
  }

  return changed;
}

function updateConflicts(db: Database.Database): number {
  const rows = db.prepare("SELECT id, reason, question, resolution FROM candidate_conflicts").all() as Array<{
    id: string;
    reason: string;
    question: string;
    resolution: string | null;
  }>;
  const update = db.prepare(
    "UPDATE candidate_conflicts SET reason = ?, question = ?, resolution = ?, updated_at = ? WHERE id = ?"
  );
  let changed = 0;

  for (const row of rows) {
    const reason = translate(row.reason) as string;
    const question = translate(row.question) as string;
    const resolution = translate(row.resolution);
    if (reason !== row.reason || question !== row.question || resolution !== row.resolution) {
      update.run(reason, question, resolution, nowIso(), row.id);
      changed += 1;
    }
  }

  return changed;
}

const db = new Database(process.env.MEMORY_DB_PATH ?? loadConfig().databasePath);
const result = db.transaction(() => ({
  nodes: updateContentTable(db, "nodes"),
  candidates: updateContentTable(db, "candidates"),
  node_sources: updateNodeSources(db),
  candidate_conflicts: updateConflicts(db)
}))();

db.close();
console.log(JSON.stringify(result, null, 2));
