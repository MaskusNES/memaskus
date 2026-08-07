const $ = (selector) => document.querySelector(selector);
const state = {
  view: "review",
  candidates: [],
  conflicts: [],
  memories: [],
  selected: null,
  explanation: null
};

const elements = {
  summary: $("#summary"),
  pendingMetric: $("#pendingMetric"),
  conflictMetric: $("#conflictMetric"),
  memoryMetric: $("#memoryMetric"),
  filters: $("#filters"),
  project: $("#projectInput"),
  search: $("#searchInput"),
  queueKicker: $("#queueKicker"),
  queueTitle: $("#queueTitle"),
  queueCount: $("#queueCount"),
  queueList: $("#queueList"),
  empty: $("#emptyState"),
  candidate: $("#candidateDetail"),
  conflict: $("#conflictDetail"),
  memory: $("#memoryDetail"),
  searchDetail: $("#searchDetail"),
  toast: $("#toast")
};

function compact(value, length = 150) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(body?.message ?? body?.error ?? `${response.status} ${response.statusText}`);
  }
  return body;
}

function notify(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

function setDetail(name) {
  elements.empty.hidden = Boolean(name);
  elements.candidate.hidden = name !== "candidate";
  elements.conflict.hidden = name !== "conflict";
  elements.memory.hidden = name !== "memory";
  elements.searchDetail.hidden = name !== "search";
}

function scopeText(item) {
  const scope = item.scope ?? {};
  return scope.project_id ? `project:${scope.project_id}` : scope.conversation_id ? `conversation:${scope.conversation_id}` : scope.kind;
}

function queueItems() {
  if (state.view === "review") return state.candidates;
  if (state.view === "conflicts") return state.conflicts;
  return state.memories;
}

function renderQueue() {
  const items = queueItems();
  elements.queueList.replaceChildren();
  elements.queueCount.textContent = String(items.length);
  const labels = {
    review: ["Review inbox", "Кандидаты"],
    conflicts: ["Conflict center", "Конфликты"],
    explorer: ["Memory explorer", "Память"]
  };
  [elements.queueKicker.textContent, elements.queueTitle.textContent] = labels[state.view];

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<p>Здесь пока ничего нет.</p>";
    elements.queueList.append(empty);
    return;
  }

  for (const item of items) {
    const candidate = state.view === "conflicts" ? item.candidate : item;
    const content = state.view === "conflicts" ? `${item.memory?.content ?? ""} ↔ ${candidate?.content ?? ""}` : item.content;
    const type = state.view === "conflicts" ? "CONFLICT" : item.kind ? `${item.kind.toUpperCase()} · ${item.title}` : item.type;
    const status = item.status;
    const card = document.createElement("button");
    card.type = "button";
    card.className = `queue-card${state.selected?.id === item.id ? " is-selected" : ""}`;
    card.innerHTML = `
      <div class="queue-card-head"><strong></strong><span class="chip"></span></div>
      <p></p>
      <div class="queue-card-meta"><span></span><span></span></div>
    `;
    card.querySelector("strong").textContent = type ?? "Memory";
    card.querySelector(".chip").textContent = status;
    if (status === "blocked" || status === "open") card.querySelector(".chip").classList.add("warning");
    card.querySelector("p").textContent = compact(content);
    card.querySelector(".queue-card-meta span:first-child").textContent =
      state.view === "conflicts" ? item.reason : item.kind ? item.id : scopeText(item);
    card.querySelector(".queue-card-meta span:last-child").textContent = new Date(item.updated_at ?? item.created_at).toLocaleDateString();
    card.addEventListener("click", () => selectItem(item));
    elements.queueList.append(card);
  }
}

function renderCandidate(candidate) {
  setDetail("candidate");
  $("#candidateStatus").textContent = candidate.needs_confirmation ? "нужно подтверждение" : candidate.status;
  $("#candidateType").value = candidate.type;
  $("#candidateConfidence").value = candidate.confidence;
  $("#candidatePrivacy").value = candidate.privacy_level;
  $("#candidateContent").value = candidate.content;
  $("#candidateMeta").textContent = [
    `Источник: ${candidate.source_id ?? "не указан"}`,
    `Автор: ${candidate.speaker_role ?? "unknown"}`,
    `Turn: ${candidate.turn_id ?? "—"}`,
    `Scope: ${scopeText(candidate)}`
  ].join(" · ");
  const editable = candidate.status === "pending";
  $("#candidateForm").querySelectorAll("input, textarea, select").forEach((field) => {
    if (field.id !== "mergeMemoryId") field.disabled = !editable;
  });
  $("#approveCandidate").disabled = candidate.status !== "pending";
  $("#rejectCandidate").disabled = candidate.status !== "pending";
}

function renderConflict(conflict) {
  setDetail("conflict");
  $("#existingMemoryText").textContent = conflict.memory?.content ?? "Запись недоступна";
  $("#newMemoryText").textContent = conflict.candidate?.content ?? "Кандидат недоступен";
  $("#conflictReason").textContent = conflict.question || conflict.reason;
  $("#conflictNote").value = "";
}

function evidenceItems(container, items, format) {
  container.replaceChildren();
  if (!items?.length) {
    const empty = document.createElement("div");
    empty.className = "evidence-item";
    empty.textContent = "Нет данных.";
    container.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "evidence-item";
    row.textContent = format(item);
    container.append(row);
  }
}

async function renderMemory(memory) {
  setDetail("memory");
  const detail = await requestJson(`/v1/memories/${encodeURIComponent(memory.id)}/explain`);
  state.explanation = detail;
  $("#memoryKicker").textContent = memory.id;
  $("#memoryTitle").textContent = memory.type;
  $("#memoryStatus").textContent = memory.status;
  $("#whyStored").textContent = detail.why_stored;
  $("#memoryType").value = memory.type;
  $("#memoryConfidence").value = memory.confidence;
  $("#memoryPrivacy").value = memory.privacy_level;
  $("#memoryScopeKind").value = memory.scope.kind === "project" ? "project" : "global";
  $("#memoryProject").value = memory.scope.project_id ?? elements.project.value.trim();
  $("#memoryContent").value = memory.content;
  $("#memoryReason").value = "manual correction";
  const editable = memory.status === "active" && !memory.content.startsWith("[redacted:");
  $("#memoryForm").querySelectorAll("input:not(#memoryType), textarea, select").forEach((field) => {
    field.disabled = !editable;
  });
  $("#archiveMemory").disabled = memory.status !== "active";
  $("#deleteMemory").disabled = memory.status === "deleted";
  evidenceItems($("#sourceList"), detail.sources, (source) => `${source.kind}: ${source.title ?? source.external_id ?? source.id}`);
  evidenceItems(
    $("#revisionList"),
    detail.revisions,
    (revision) => `${new Date(revision.created_at).toLocaleString()} — ${revision.reason ?? "изменение"}: ${compact(revision.next_content, 90)}`
  );
}

function renderSearchResult(item) {
  setDetail("search");
  $("#searchKind").textContent = item.kind;
  $("#searchTitle").textContent = item.title;
  $("#searchStatus").textContent = item.status;
  $("#searchContent").textContent = item.content || "Нет текстового содержимого.";
  const data = item.data ?? {};
  $("#searchMetadata").textContent = [
    `ID: ${item.id}`,
    data.knowledge_scope ? `Knowledge: ${data.knowledge_scope}` : "",
    data.scope_project_id ? `Project: ${data.scope_project_id}` : "",
    data.external_id ? `External ID: ${data.external_id}` : "",
    `Updated: ${new Date(item.updated_at).toLocaleString()}`
  ].filter(Boolean).join(" · ");
}

async function selectItem(item) {
  state.selected = item;
  renderQueue();
  if (state.view === "review") renderCandidate(item);
  if (state.view === "conflicts") renderConflict(item);
  if (state.view === "explorer") {
    if (item.kind === "memory") await renderMemory(item.data);
    else if (item.kind === "candidate") renderCandidate(item.data);
    else if (item.kind === "conflict") renderConflict(item.data);
    else renderSearchResult(item);
  }
}

async function loadAll(preserveSelection = false) {
  const project = elements.project.value.trim();
  const q = elements.search.value.trim();
  const explorerParams = new URLSearchParams({ limit: "200" });
  if (project) explorerParams.set("project_id", project);
  if (q) explorerParams.set("q", q);
  const [candidateData, conflictData, explorerData] = await Promise.all([
    requestJson("/v1/candidates?status=pending,blocked"),
    requestJson("/v1/conflicts?status=open"),
    requestJson(`/v1/explorer?${explorerParams.toString()}`)
  ]);
  state.candidates = candidateData.candidates ?? [];
  state.conflicts = conflictData.conflicts ?? [];
  state.memories = explorerData.items ?? [];
  elements.pendingMetric.textContent = String(state.candidates.length);
  elements.conflictMetric.textContent = String(state.conflicts.length);
  elements.memoryMetric.textContent = String(explorerData.counts?.memories ?? 0);
  elements.summary.textContent = `${state.candidates.length} кандидатов · ${state.conflicts.length} конфликтов · ${explorerData.counts?.memories ?? 0} активных`;
  if (!preserveSelection) {
    state.selected = null;
    setDetail(null);
  } else if (state.selected) {
    const fresh = queueItems().find((item) => item.id === state.selected.id);
    state.selected = fresh ?? null;
    if (!fresh) setDetail(null);
  }
  renderQueue();
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.view = tab.dataset.view;
    state.selected = null;
    setDetail(null);
    document.querySelectorAll(".tab").forEach((candidate) => {
      const active = candidate === tab;
      candidate.classList.toggle("is-active", active);
      candidate.setAttribute("aria-selected", String(active));
    });
    renderQueue();
  });
});

elements.filters.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadAll();
});

$("#candidateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await requestJson(`/v1/candidates/${encodeURIComponent(state.selected.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      type: $("#candidateType").value.trim(),
      content: $("#candidateContent").value.trim(),
      confidence: Number($("#candidateConfidence").value),
      privacy_level: $("#candidatePrivacy").value
    })
  });
  notify("Правка кандидата сохранена.");
  await loadAll();
});

$("#approveCandidate").addEventListener("click", async () => {
  await requestJson(`/v1/candidates/${encodeURIComponent(state.selected.id)}/approve`, { method: "POST", body: "{}" });
  notify("Кандидат добавлен в память.");
  await loadAll();
});

$("#rejectCandidate").addEventListener("click", async () => {
  await requestJson(`/v1/candidates/${encodeURIComponent(state.selected.id)}/reject`, { method: "POST", body: "{}" });
  notify("Кандидат отклонён.");
  await loadAll();
});

$("#mergeCandidate").addEventListener("click", async () => {
  const memoryId = $("#mergeMemoryId").value.trim();
  if (!memoryId) return;
  await requestJson(`/v1/candidates/${encodeURIComponent(state.selected.id)}/merge`, {
    method: "POST",
    body: JSON.stringify({ memory_id: memoryId })
  });
  notify("Кандидат объединён с существующей памятью.");
  await loadAll();
});

document.querySelectorAll("[data-conflict-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    await requestJson(`/v1/conflicts/${encodeURIComponent(state.selected.id)}/resolve`, {
      method: "POST",
      body: JSON.stringify({
        action: button.dataset.conflictAction,
        note: $("#conflictNote").value.trim() || undefined
      })
    });
    notify("Конфликт разрешён.");
    await loadAll();
  });
});

$("#memoryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const scopeKind = $("#memoryScopeKind").value;
  const scope = scopeKind === "project"
    ? { kind: "project", project_id: $("#memoryProject").value.trim() }
    : { kind: "global" };
  await requestJson(`/v1/memories/${encodeURIComponent(state.selected.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      content: $("#memoryContent").value.trim(),
      confidence: Number($("#memoryConfidence").value),
      privacy_level: $("#memoryPrivacy").value,
      scope,
      reason: $("#memoryReason").value.trim() || "manual correction"
    })
  });
  notify("Память исправлена, предыдущая версия сохранена.");
  await loadAll();
});

$("#archiveMemory").addEventListener("click", async () => {
  await requestJson(`/v1/memories/${encodeURIComponent(state.selected.id)}/archive`, {
    method: "POST",
    body: JSON.stringify({ reason: "manual archive from memory center" })
  });
  notify("Память перемещена в архив.");
  await loadAll();
});

$("#deleteMemory").addEventListener("click", async () => {
  if (!window.confirm("Забыть эту память? Содержимое и прямые источники будут удалены.")) return;
  await requestJson(`/v1/memories/${encodeURIComponent(state.selected.id)}`, {
    method: "DELETE",
    body: JSON.stringify({ reason: "manual forget from memory center" })
  });
  notify("Память удалена.");
  await loadAll();
});

$("#feedbackButtons").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-rating]");
  if (!button) return;
  await requestJson(`/v1/memories/${encodeURIComponent(state.selected.id)}/feedback`, {
    method: "POST",
    body: JSON.stringify({ rating: button.dataset.rating })
  });
  notify("Оценка сохранена.");
  await renderMemory(state.selected);
});

try {
  await loadAll();
} catch (error) {
  elements.summary.textContent = "Не удалось загрузить память.";
  notify(error instanceof Error ? error.message : String(error));
}
