const summary = document.querySelector("#summary");
const filters = document.querySelector("#filters");
const scopeInput = document.querySelector("#scopeInput");
const projectInput = document.querySelector("#projectInput");
const topicsInput = document.querySelector("#topicsInput");
const statusInput = document.querySelector("#statusInput");
const slotList = document.querySelector("#slotList");
const newSlotButton = document.querySelector("#newSlotButton");
const emptyState = document.querySelector("#emptyState");
const editor = document.querySelector("#editor");
const slotKicker = document.querySelector("#slotKicker");
const slotTitle = document.querySelector("#slotTitle");
const slotStatus = document.querySelector("#slotStatus");
const topicEditor = document.querySelector("#topicEditor");
const subTopicEditor = document.querySelector("#subTopicEditor");
const knowledgeEditor = document.querySelector("#knowledgeEditor");
const projectEditor = document.querySelector("#projectEditor");
const confidenceEditor = document.querySelector("#confidenceEditor");
const privacyEditor = document.querySelector("#privacyEditor");
const contentEditor = document.querySelector("#contentEditor");
const reasonEditor = document.querySelector("#reasonEditor");
const archiveButton = document.querySelector("#archiveButton");
const cancelButton = document.querySelector("#cancelButton");
const revisionPanel = document.querySelector("#revisionPanel");
const revisionList = document.querySelector("#revisionList");
const contextButton = document.querySelector("#contextButton");
const contextPreview = document.querySelector("#contextPreview");

let slots = [];
let selectedSlot = null;
let revisions = [];

function compactText(value, maxLength = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function scopeLabel(slot) {
  return slot.knowledge_scope === "project_local" ? slot.scope_project_id || "project" : "global";
}

function queryParams() {
  const params = new URLSearchParams();
  if (scopeInput.value) {
    params.set("knowledge_scope", scopeInput.value);
  }
  if (projectInput.value.trim() && scopeInput.value !== "global") {
    params.set("project_id", projectInput.value.trim());
  }
  if (topicsInput.value.trim()) {
    params.set("topics", topicsInput.value.trim());
  }
  if (statusInput.value) {
    params.set("status", statusInput.value);
  }
  return params;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    },
    ...options
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}

function renderSlots() {
  slotList.replaceChildren();
  if (!slots.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<h2>No slots</h2><p>No profile memory matches these filters.</p>";
    slotList.append(empty);
    return;
  }

  for (const slot of slots) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `slot-card${selectedSlot?.id === slot.id ? " is-selected" : ""}`;
    button.dataset.slotId = slot.id;

    const scopeClass = slot.knowledge_scope === "project_local" ? "project" : "global";
    const title = document.createElement("div");
    title.className = "slot-card-title";
    const identity = document.createElement("span");
    identity.textContent = `${slot.topic}/${slot.sub_topic}`;
    const confidence = document.createElement("span");
    confidence.textContent = `${Math.round(slot.confidence * 100)}%`;
    title.append(identity, confidence);

    const content = document.createElement("div");
    content.className = "slot-card-content";
    content.textContent = compactText(slot.content);

    const meta = document.createElement("div");
    meta.className = "meta-row";
    const scope = document.createElement("span");
    scope.className = `chip ${scopeClass}`;
    scope.textContent = scopeLabel(slot);
    const privacy = document.createElement("span");
    privacy.className = `chip${slot.privacy_level === "secret" ? " secret" : ""}`;
    privacy.textContent = slot.privacy_level;
    const updated = document.createElement("span");
    updated.className = "chip";
    updated.textContent = new Date(slot.updated_at).toLocaleString();
    meta.append(scope, privacy, updated);

    button.append(title, content, meta);
    button.addEventListener("click", () => selectSlot(slot.id));
    slotList.append(button);
  }
}

function setEditorVisible(visible) {
  emptyState.hidden = visible;
  editor.hidden = !visible;
  revisionPanel.hidden = !visible || !selectedSlot?.id;
}

function fillEditor(slot) {
  selectedSlot = slot;
  revisions = [];
  setEditorVisible(true);
  slotKicker.textContent = slot.id ? slot.id : "New slot";
  slotTitle.textContent = slot.id ? `${slot.topic}/${slot.sub_topic}` : "Create profile memory";
  slotStatus.textContent = slot.status ?? "Draft";
  topicEditor.value = slot.topic ?? "";
  subTopicEditor.value = slot.sub_topic ?? "general";
  knowledgeEditor.value = slot.knowledge_scope ?? (scopeInput.value || "global");
  projectEditor.value = slot.scope_project_id ?? projectInput.value.trim();
  confidenceEditor.value = String(slot.confidence ?? 0.8);
  privacyEditor.value = slot.privacy_level ?? "normal";
  contentEditor.value = slot.content ?? "";
  reasonEditor.value = slot.id ? "manual profile edit" : "manual profile creation";
  topicEditor.disabled = Boolean(slot.id);
  subTopicEditor.disabled = Boolean(slot.id);
  knowledgeEditor.disabled = Boolean(slot.id);
  projectEditor.disabled = Boolean(slot.id);
  archiveButton.hidden = !slot.id || slot.status !== "active";
}

function renderRevisions() {
  revisionList.replaceChildren();
  if (!revisions.length) {
    const empty = document.createElement("div");
    empty.className = "revision-item";
    empty.innerHTML = '<div class="revision-meta">No revisions loaded.</div>';
    revisionList.append(empty);
    return;
  }

  for (const revision of revisions) {
    const item = document.createElement("article");
    item.className = "revision-item";
    const meta = [
      new Date(revision.created_at).toLocaleString(),
      revision.reason,
      revision.memory_id ? `memory ${revision.memory_id}` : "",
      revision.candidate_id ? `candidate ${revision.candidate_id}` : ""
    ]
      .filter(Boolean)
      .join(" | ");
    item.innerHTML = `
      <div class="revision-meta"></div>
      <p></p>
    `;
    item.querySelector(".revision-meta").textContent = meta || revision.id;
    item.querySelector("p").textContent = revision.next_content;
    revisionList.append(item);
  }
}

async function loadSlots() {
  summary.textContent = "Loading profile slots...";
  const data = await requestJson(`/v1/profile?${queryParams().toString()}`);
  slots = data.slots ?? [];
  if (selectedSlot?.id) {
    selectedSlot = slots.find((slot) => slot.id === selectedSlot.id) ?? null;
  }
  summary.textContent = `${slots.length} profile slots`;
  renderSlots();
  if (!selectedSlot) {
    setEditorVisible(false);
  }
}

async function selectSlot(id) {
  const data = await requestJson(`/v1/profile/slots/${encodeURIComponent(id)}`);
  revisions = data.revisions ?? [];
  fillEditor(data.slot);
  renderRevisions();
  renderSlots();
}

function newSlot() {
  fillEditor({
    id: "",
    status: "draft",
    topic: topicsInput.value.split(",").map((topic) => topic.trim()).filter(Boolean)[0] ?? "",
    sub_topic: "general",
    content: "",
    confidence: 0.8,
    knowledge_scope: scopeInput.value || "global",
    scope_project_id: projectInput.value.trim(),
    privacy_level: "normal"
  });
  renderRevisions();
}

function editorPayload() {
  const knowledgeScope = knowledgeEditor.value;
  const payload = {
    content: contentEditor.value.trim(),
    confidence: Number(confidenceEditor.value),
    privacy_level: privacyEditor.value,
    reason: reasonEditor.value.trim() || undefined
  };

  if (!selectedSlot?.id) {
    return {
      ...payload,
      topic: topicEditor.value.trim(),
      sub_topic: subTopicEditor.value.trim(),
      knowledge_scope: knowledgeScope,
      project_id: knowledgeScope === "project_local" ? projectEditor.value.trim() : undefined
    };
  }

  return payload;
}

async function saveSlot(event) {
  event.preventDefault();
  const payload = editorPayload();
  if (!payload.content) {
    contentEditor.focus();
    return;
  }

  if (!selectedSlot?.id && (!payload.topic || !payload.sub_topic)) {
    topicEditor.focus();
    return;
  }

  const result = selectedSlot?.id
    ? await requestJson(`/v1/profile/slots/${encodeURIComponent(selectedSlot.id)}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      })
    : await requestJson("/v1/profile/slots", {
        method: "POST",
        body: JSON.stringify(payload)
      });

  await loadSlots();
  await selectSlot(result.slot.id);
  await previewContext();
}

async function archiveSlot() {
  if (!selectedSlot?.id) {
    return;
  }
  const reason = reasonEditor.value.trim() || "manual profile archive";
  await requestJson(`/v1/profile/slots/${encodeURIComponent(selectedSlot.id)}/archive`, {
    method: "POST",
    body: JSON.stringify({ reason })
  });
  selectedSlot = null;
  await loadSlots();
  await previewContext();
}

async function previewContext() {
  const topics = topicsInput.value
    .split(",")
    .map((topic) => topic.trim())
    .filter(Boolean);
  const payload = {
    knowledge_scope: scopeInput.value || undefined,
    project_id: projectInput.value.trim() || undefined,
    topics: topics.length ? topics : undefined,
    prefer_topics: topics.length ? topics : undefined,
    max_items: 40,
    max_chars: 6000
  };
  if (payload.knowledge_scope === "global") {
    delete payload.project_id;
  }
  const data = await requestJson("/v1/profile/context", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  contextPreview.textContent = data.context || "No matching profile context.";
}

filters.addEventListener("submit", async (event) => {
  event.preventDefault();
  selectedSlot = null;
  await loadSlots();
  await previewContext();
});

newSlotButton.addEventListener("click", newSlot);
editor.addEventListener("submit", saveSlot);
archiveButton.addEventListener("click", archiveSlot);
cancelButton.addEventListener("click", () => {
  selectedSlot = null;
  setEditorVisible(false);
  renderSlots();
});
contextButton.addEventListener("click", previewContext);

try {
  await loadSlots();
  await previewContext();
} catch (error) {
  summary.textContent = "Profile UI failed to load.";
  contextPreview.textContent = error instanceof Error ? error.message : String(error);
}
