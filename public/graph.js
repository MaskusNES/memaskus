const canvas = document.querySelector("#graphCanvas");
const ctx = canvas.getContext("2d");
const form = document.querySelector("#controls");
const projectInput = document.querySelector("#projectInput");
const searchInput = document.querySelector("#searchInput");
const summary = document.querySelector("#graphSummary");
const emptyState = document.querySelector("#emptyState");
const inspector = document.querySelector("#inspector");
const nodeType = document.querySelector("#nodeType");
const nodeDisplayId = document.querySelector("#nodeDisplayId");
const nodeFullId = document.querySelector("#nodeFullId");
const nodeTitle = document.querySelector("#nodeTitle");
const nodeConfidence = document.querySelector("#nodeConfidence");
const nodeScope = document.querySelector("#nodeScope");
const nodeKnowledgeScope = document.querySelector("#nodeKnowledgeScope");
const nodeUpdated = document.querySelector("#nodeUpdated");
const relationList = document.querySelector("#relationList");

const palette = {
  Fact: "#176b87",
  Decision: "#b24a3b",
  Preference: "#7d5fb2",
  Task: "#4f7d41",
  Project: "#30343f",
  Observation: "#8a6f31",
  Artifact: "#2f6975",
  Conversation: "#5f6672",
  default: "#176b87"
};

let graph = { nodes: [], edges: [] };
let displayNodes = [];
let selectedNode = null;
let draggingNode = null;
let pointer = { x: 0, y: 0 };
let animationFrame = null;

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function nodeRadius(node) {
  const degree = graph.edges.filter((edge) => edge.from_id === node.id || edge.to_id === node.id).length;
  return 17 + Math.min(12, degree * 3);
}

function prepareLayout() {
  const rect = canvas.getBoundingClientRect();
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  const radius = Math.max(90, Math.min(rect.width, rect.height) * 0.32);

  displayNodes = graph.nodes.map((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, graph.nodes.length);
    return {
      ...node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      vx: 0,
      vy: 0
    };
  });
}

function visibleNodes() {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) {
    return displayNodes;
  }

  const connected = new Set();
  const matching = new Set(
    displayNodes
      .filter((node) => `${node.type} ${node.content} ${node.id} ${node.display_id}`.toLowerCase().includes(query))
      .map((node) => node.id)
  );

  for (const edge of graph.edges) {
    if (
      matching.has(edge.from_id) ||
      matching.has(edge.to_id) ||
      `${edge.id} ${edge.display_id} ${edge.relation}`.toLowerCase().includes(query)
    ) {
      connected.add(edge.from_id);
      connected.add(edge.to_id);
    }
  }

  return displayNodes.filter((node) => matching.has(node.id) || connected.has(node.id));
}

function visibleEdges(nodes) {
  const ids = new Set(nodes.map((node) => node.id));
  return graph.edges.filter((edge) => ids.has(edge.from_id) && ids.has(edge.to_id));
}

function applyForces(nodes, edges) {
  const rect = canvas.getBoundingClientRect();
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = b.x - a.x || 0.01;
      const dy = b.y - a.y || 0.01;
      const distanceSq = dx * dx + dy * dy;
      const force = Math.min(2600 / distanceSq, 1.4);
      const distance = Math.sqrt(distanceSq);
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  for (const edge of edges) {
    const a = byId.get(edge.from_id);
    const b = byId.get(edge.to_id);
    if (!a || !b) {
      continue;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const target = 150;
    const force = (distance - target) * 0.012;
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  for (const node of nodes) {
    if (node === draggingNode) {
      node.x = pointer.x;
      node.y = pointer.y;
      node.vx = 0;
      node.vy = 0;
      continue;
    }

    node.vx += (rect.width / 2 - node.x) * 0.0015;
    node.vy += (rect.height / 2 - node.y) * 0.0015;
    node.vx *= 0.82;
    node.vy *= 0.82;
    node.x = Math.max(34, Math.min(rect.width - 34, node.x + node.vx));
    node.y = Math.max(34, Math.min(rect.height - 34, node.y + node.vy));
  }
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  const nodes = visibleNodes();
  const edges = visibleEdges(nodes);
  const byId = new Map(displayNodes.map((node) => [node.id, node]));

  applyForces(nodes, edges);
  ctx.clearRect(0, 0, rect.width, rect.height);

  for (const edge of edges) {
    const a = byId.get(edge.from_id);
    const b = byId.get(edge.to_id);
    if (!a || !b) {
      continue;
    }

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = "rgba(23, 32, 42, 0.22)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    ctx.fillStyle = "rgba(23, 32, 42, 0.66)";
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.fillText(`${edge.display_id} ${edge.relation}`, mx + 5, my - 5);
  }

  for (const node of nodes) {
    const radius = nodeRadius(node);
    const selected = selectedNode?.id === node.id;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = palette[node.type] ?? palette.default;
    ctx.fill();
    ctx.lineWidth = selected ? 4 : 2;
    ctx.strokeStyle = selected ? "#111827" : "rgba(255, 255, 255, 0.92)";
    ctx.stroke();

    const label = node.type.slice(0, 2).toUpperCase();
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 12px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, node.x, node.y);

    ctx.fillStyle = selected ? "#111827" : "rgba(23, 32, 42, 0.78)";
    ctx.font = "700 10px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.textBaseline = "top";
    ctx.fillText(node.display_id, node.x, node.y + radius + 4);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }

  animationFrame = requestAnimationFrame(draw);
}

function hitTest(x, y) {
  const nodes = visibleNodes();
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    const dx = x - node.x;
    const dy = y - node.y;
    if (Math.sqrt(dx * dx + dy * dy) <= nodeRadius(node) + 4) {
      return node;
    }
  }
  return null;
}

function scopeLabel(scope) {
  if (scope.project_id) {
    return `project:${scope.project_id}`;
  }
  if (scope.user_id) {
    return `user:${scope.user_id}`;
  }
  return scope.kind;
}

function relationText(edge, node) {
  const otherId = edge.from_id === node.id ? edge.to_id : edge.from_id;
  const other = displayNodes.find((candidate) => candidate.id === otherId);
  const direction = edge.from_id === node.id ? "out" : "in";
  return `${edge.display_id} ${direction} ${edge.relation} ${other?.display_id ?? otherId} ${other?.type ?? "node"}: ${
    other?.content ?? otherId
  }`;
}

function inspectNode(node) {
  selectedNode = node;
  emptyState.hidden = true;
  inspector.hidden = false;
  nodeType.textContent = node.type;
  nodeDisplayId.textContent = node.display_id;
  nodeFullId.textContent = node.id;
  nodeTitle.textContent = node.content;
  nodeConfidence.textContent = `${Math.round(node.confidence * 100)}%`;
  nodeScope.textContent = scopeLabel(node.scope);
  nodeKnowledgeScope.textContent = node.knowledge_scope;
  nodeUpdated.textContent = new Date(node.updated_at).toLocaleString();

  const relations = graph.edges.filter((edge) => edge.from_id === node.id || edge.to_id === node.id);
  relationList.replaceChildren(
    ...(relations.length
      ? relations.map((edge) => {
          const item = document.createElement("li");
          item.textContent = relationText(edge, node);
          return item;
        })
      : [document.createElement("li")])
  );

  if (!relations.length) {
    relationList.firstElementChild.textContent = "No graph links yet.";
  }
}

async function loadGraph() {
  const params = new URLSearchParams();
  if (projectInput.value.trim()) {
    params.set("project_id", projectInput.value.trim());
  }
  params.set("limit", "500");

  const response = await fetch(`/v1/graph?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Graph request failed: ${response.status}`);
  }

  graph = await response.json();
  selectedNode = null;
  emptyState.hidden = false;
  inspector.hidden = true;
  prepareLayout();
  summary.textContent = `${graph.nodes.length} nodes, ${graph.edges.length} edges`;
}

function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

canvas.addEventListener("pointerdown", (event) => {
  pointer = pointerPosition(event);
  draggingNode = hitTest(pointer.x, pointer.y);
  if (draggingNode) {
    canvas.setPointerCapture(event.pointerId);
    inspectNode(draggingNode);
  }
});

canvas.addEventListener("pointermove", (event) => {
  pointer = pointerPosition(event);
});

canvas.addEventListener("pointerup", () => {
  draggingNode = null;
});

canvas.addEventListener("pointercancel", () => {
  draggingNode = null;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadGraph();
});

searchInput.addEventListener("input", () => {
  selectedNode = null;
  emptyState.hidden = false;
  inspector.hidden = true;
});

window.addEventListener("resize", () => {
  resizeCanvas();
  prepareLayout();
});

resizeCanvas();
await loadGraph();
draw();
