import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

class Element {
  value = "";
  textContent = "";
  innerHTML = "";
  hidden = false;
  required = true;
  disabled = false;
  placeholder = "";
  dataset: Record<string, string> = {};
  children: Element[] = [];
  listeners = new Map<string, (event?: unknown) => unknown>();
  classList = { add() {}, toggle() {} };
  fields = new Map<string, Element>();
  addEventListener(name: string, handler: (event?: unknown) => unknown) { this.listeners.set(name, handler); }
  querySelector(name: string): Element { if (!this.fields.has(name)) this.fields.set(name, new Element()); return this.fields.get(name)!; }
  querySelectorAll() { return []; }
  replaceChildren() { this.children = []; }
  append(...elements: Element[]) { this.children.push(...elements); }
  focus() {}
  setAttribute() {}
}

async function ui(file: string, exports: string, respond: (url: string, options?: RequestInit) => unknown) {
  const elements = new Map<string, Element>();
  const document = { querySelector(name: string) { if (!elements.has(name)) elements.set(name, new Element()); return elements.get(name)!; },
    querySelectorAll() { return []; }, createElement() { return new Element(); } };
  const script = fs.readFileSync(`public/${file}.js`, "utf8");
  const code = script.slice(0, script.lastIndexOf("\ntry {"));
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const result = await vm.runInNewContext(`(async () => { ${code}\nreturn { ${exports} }; })()`, {
    document, URLSearchParams, console, window: { clearTimeout() {}, setTimeout() {}, confirm() { return true; } },
    fetch: async (url: string, options?: RequestInit) => {
      calls.push({ url, options }); const data = respond(url, options);
      return { ok: true, json: async () => data, text: async () => JSON.stringify(data) };
    }
  });
  return { result, calls, elements, get: document.querySelector.bind(document) };
}

const slot = { id: "slot_qa", topic: "qa", sub_topic: "test", content: "[redacted: sensitive memory]", privacy_level: "sensitive", confidence: 0.8, status: "active", knowledge_scope: "global" };
const candidate = { id: "candidate_qa", type: "Fact", content: "[redacted: sensitive memory]", privacy_level: "sensitive", confidence: 0.8, status: "pending", scope: { kind: "global" } };

describe("audit editor and feedback browser handlers", () => {
  it.each(["sensitive", "secret"])("profile %s non-text edits omit content; explicit text replacement is sent", async (privacy_level) => {
    const revisions = [{ id: "r1", next_content: "First", created_at: "2026-01-01" }, { id: "r2", next_content: "Second", created_at: "2026-01-02" }];
    const browser = await ui("profile", "fillEditor, editorPayload, selectSlot", () => ({ slot: { ...slot, privacy_level }, revisions }));
    await browser.result.selectSlot(slot.id);
    expect(browser.get("#revisionList").children).toHaveLength(2);
    expect(browser.get("#revisionList").children[1].querySelector("p").textContent).toBe("Second");
    expect(browser.get("#contentEditor").required).toBe(false);
    browser.get("#confidenceEditor").value = "0.6";
    expect(browser.result.editorPayload()).not.toHaveProperty("content");
    browser.get("#contentEditor").value = "Explicit replacement";
    browser.get("#contentEditor").listeners.get("input")!();
    expect(browser.result.editorPayload().content).toBe("Explicit replacement");
  });

  it.each(["sensitive", "secret"])("candidate %s confidence edits omit content; explicit replacement is sent", async (privacy_level) => {
    const browser = await ui("memory", "renderCandidate, state", (url) => url.startsWith("/v1/explorer") ? { items: [], counts: {} } : { candidates: [], conflicts: [] });
    async function save(replacement?: string) {
      browser.result.state.selected = { ...candidate, privacy_level };
      browser.result.renderCandidate(browser.result.state.selected);
      const editor = browser.get("#candidateContent");
      expect(editor.required).toBe(false);
      if (replacement) { editor.value = replacement; editor.listeners.get("input")!(); }
      browser.get("#candidateConfidence").value = "0.5";
      await browser.get("#candidateForm").listeners.get("submit")!({ preventDefault() {} });
      const call = browser.calls.filter((call) => call.options?.method === "PATCH").at(-1)!;
      return JSON.parse(String(call.options!.body));
    }
    expect(await save()).not.toHaveProperty("content");
    expect((await save("Explicit replacement")).content).toBe("Explicit replacement");
  });

  it("memory feedback refresh keeps the Explorer wrapper and supplies the underlying memory", async () => {
    const memory = { ...candidate, id: "node_qa", content: "Normal feedback memory", privacy_level: "normal", status: "active" };
    const browser = await ui("memory", "state, selectItem", () => ({ memory, why_stored: "Synthetic evidence", sources: [], revisions: [], feedback: {} }));
    browser.result.state.view = "explorer";
    const selected = { kind: "memory", id: memory.id, data: memory };
    browser.result.state.memories = [selected];
    await browser.result.selectItem(selected);
    await browser.get("#feedbackButtons").listeners.get("click")!({ target: { closest() { return { dataset: { rating: "correct" } }; } } });
    expect(browser.calls.some((call) => call.url.endsWith("/feedback") && JSON.parse(String(call.options?.body)).rating === "correct")).toBe(true);
    expect(browser.calls.filter((call) => call.url.endsWith("/explain"))).toHaveLength(2);
    expect(browser.result.state.selected).toBe(selected);
    expect(browser.get("#memoryScopeKind").value).toBe("global");
  });
});
