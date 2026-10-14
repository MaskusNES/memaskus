import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHttpClient } from "../src/shared/http-client.js";

afterEach(() => vi.unstubAllEnvs());

describe("shared CLI and MCP HTTP client", () => {
  it.each([
    { "X-Memory-Api-Key": "override", "x-custom": "value" },
    new Headers({ "X-Memory-Api-Key": "override", "x-custom": "value" }),
    [["X-Memory-Api-Key", "override"], ["x-custom", "value"]] as [string, string][]
  ])("preserves all supported header formats and explicit authentication", async (headers) => {
    vi.stubEnv("MEMORY_API_KEY", "default-key");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true}'));
    const client = createMemoryHttpClient("http://localhost:39110/", fetchImpl);
    expect(await client.request("/v1/recall", { method: "POST", headers, body: "{}" })).toEqual({ ok: true });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://localhost:39110/v1/recall");
    const sent = new Headers(options?.headers);
    expect(sent.get("x-memory-api-key")).toBe("override");
    expect(sent.get("x-custom")).toBe("value");
    expect(sent.get("content-type")).toBe("application/json");
    expect(options?.body).toBe("{}");
  });

  it("uses configured endpoint and API key, and accepts empty responses", async () => {
    vi.stubEnv("MEMORY_API_URL", "http://localhost:39110");
    vi.stubEnv("MEMORY_API_KEY", "test-key");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    expect(await createMemoryHttpClient(undefined, fetchImpl).request("/v1/memories/id")).toBeNull();
    expect(fetchImpl.mock.calls[0][0]).toBe("http://localhost:39110/v1/memories/id");
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("x-memory-api-key")).toBe("test-key");
  });

  it("preserves structured API errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    await expect(createMemoryHttpClient(undefined, fetchImpl).request("/v1/recall")).rejects.toThrow("unauthorized");
  });

  it("reports non-JSON proxy failures without echoing response contents", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>private proxy details</html>", { status: 502 }));
    await expect(createMemoryHttpClient(undefined, fetchImpl).request("/v1/recall")).rejects.toThrow("Memory API returned non-JSON response (HTTP 502)");
  });
});
