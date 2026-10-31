// Can also be pasted into the browser console on /memory after removing `export`.
export async function runAuditPreviewQA(baseUrl = location.origin) {
  const prefix = `audit-qa-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const scope = { kind: "project", project_id: "project:qa" };
  const memories = [];
  const slots = [];
  const checks = [];
  async function request(method, path, payload, expected = 200) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      ...(payload === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
    });
    if (response.status !== expected) throw new Error(`${method} ${path}: HTTP ${response.status}, expected ${expected}`);
    return response.json();
  }
  function check(name, condition) {
    if (!condition) throw new Error(`Failed QA check: ${name}`);
    checks.push(name);
  }
  async function create(content, privacy_level = "normal") {
    const result = await request("POST", "/v1/memories", { type: "Fact", content, scope, privacy_level }, 201);
    memories.push(result.id); return result.id;
  }
  try {
    await request("GET", "/health"); await request("GET", "/ready");
    for (const page of ["/memory", "/profile", "/graph"]) {
      check(`UI ${page}`, (await fetch(`${baseUrl}${page}`)).status === 200);
    }
    const id = await create(`${prefix} normal evidence`);
    const recall = await request("POST", "/v1/recall", { query: prefix, scope, include_sources: true });
    check("same-scope recall", recall.results.some((item) => item.id === id));
    const foreign = await request("POST", "/v1/recall", { query: prefix, scope: { kind: "project", project_id: `${prefix}-other` } });
    check("project isolation", !foreign.results.some((item) => item.id === id));
    const explorer = await request("GET", `/v1/explorer?project_id=project:qa&q=${encodeURIComponent(prefix)}`);
    check("Explorer", explorer.items.some((item) => item.id === id));
    await request("POST", "/v1/memories", { type: "Fact", content: '{"password":"synthetic12345678"}', scope }, 400);
    checks.push("quoted credentials rejected");
    for (const privacy_level of ["sensitive", "secret"]) {
      const protectedText = `${prefix} protected ${privacy_level}`;
      const privateId = await create(protectedText, privacy_level);
      await request("PATCH", `/v1/memories/${privateId}`, { content: `${prefix} public replacement`, privacy_level: "normal" });
      const detail = await request("GET", `/v1/memories/${privateId}/explain`);
      check(`historical ${privacy_level}`, !JSON.stringify(detail).includes(protectedText));
      const slot = await request("POST", "/v1/profile/slots", { topic: "qa", sub_topic: `${prefix}-${privacy_level}`,
        content: protectedText, knowledge_scope: "project_local", project_id: "project:qa", privacy_level }, 201);
      slots.push(slot.id);
      await request("PATCH", `/v1/profile/slots/${slot.id}`, { confidence: 0.6 });
      await request("PATCH", `/v1/profile/slots/${slot.id}`, { content: `${prefix} public slot`, privacy_level: "normal" });
      const slotDetail = await request("GET", `/v1/profile/slots/${slot.id}`);
      check(`profile historical ${privacy_level}`, !JSON.stringify(slotDetail).includes(protectedText));
      await request("PATCH", `/v1/profile/slots/${slot.id}`, { content: "Invalid replacement", memory_id: `${prefix}-missing` }, 400);
      const unchanged = await request("GET", `/v1/profile/slots/${slot.id}`);
      check(`profile atomicity ${privacy_level}`, JSON.stringify(unchanged) === JSON.stringify(slotDetail));
    }
    await request("POST", `/v1/memories/${id}/feedback`, { rating: "correct" }, 201);
    check("feedback persisted", (await request("GET", `/v1/memories/${id}/explain`)).feedback.length === 1);
    await request("POST", `/v1/memories/${id}/archive`, {});
    check("archive excluded", !(await request("POST", "/v1/recall", { query: prefix, scope })).results.some((item) => item.id === id));
    return { passed: true, checks };
  } finally {
    for (const id of memories) await request("DELETE", `/v1/memories/${id}`);
    for (const id of slots) await request("POST", `/v1/profile/slots/${id}/archive`, {});
  }
}
