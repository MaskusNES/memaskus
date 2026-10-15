import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("renders the Explorer total beyond the item limit, including after filtering and tab changes", async () => {
  function element() {
    return {
      textContent: "", value: "", hidden: false, dataset: { view: "" },
      classList: { add() {}, toggle() {} },
      listeners: {} as Record<string, (...args: any[]) => any>,
      addEventListener(event: string, handler: (...args: any[]) => any) { this.listeners[event] = handler; },
      replaceChildren() {}, append() {}, setAttribute() {},
      querySelector() { return element(); }
    };
  }
  const elements = new Map<string, ReturnType<typeof element>>();
  const select = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector)!;
  };
  const tabs = ["review", "conflicts", "explorer"].map((view) => Object.assign(element(), { dataset: { view } }));
  let items = Array.from({ length: 200 }, (_, i) => ({
    id: `node_${i}`, kind: "memory", title: "Fact", content: "fixture", status: "active"
  }));
  let total = 220;
  const urls: string[] = [];
  const script = readFileSync(new URL("../public/memory.js", import.meta.url), "utf8");
  await runInNewContext(`(async () => {${script}\n})()`, {
    document: {
      querySelector: select,
      querySelectorAll: (selector: string) => selector === ".tab" ? tabs : [],
      createElement: element
    },
    URLSearchParams,
    fetch: async (url: string) => {
      urls.push(url);
      const body = url.startsWith("/v1/explorer") ? { items, counts: { memories: total } }
        : url.startsWith("/v1/candidates") ? { candidates: [] } : { conflicts: [] };
      return { ok: true, text: async () => JSON.stringify(body) };
    }
  });
  tabs[2]!.listeners.click!();
  expect(select("#queueCount").textContent).toBe("220");
  expect(select("#memoryMetric").textContent).toBe("220");
  items = [];
  select("#projectInput").value = "project:qa";
  select("#searchInput").value = "absent";
  await select("#filters").listeners.submit!({ preventDefault() {} });
  expect(urls.at(-1)).toContain("project_id=project%3Aqa&q=absent");
  expect(select("#queueCount").textContent).toBe("220");
  tabs[0]!.listeners.click!();
  expect(select("#queueCount").textContent).toBe("0");
  tabs[2]!.listeners.click!();
  expect(select("#queueCount").textContent).toBe("220");
  total = 0;
  await select("#filters").listeners.submit!({ preventDefault() {} });
  expect(select("#queueCount").textContent).toBe("0");
});
