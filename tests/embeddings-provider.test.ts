import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIEmbeddingProvider } from "../src/domain/embeddings.js";

describe("OpenAI embedding provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the embeddings endpoint without persisting or exposing the API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      async json() {
        return {
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] }
          ]
        };
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAIEmbeddingProvider(
      "test-api-key",
      "text-embedding-3-small",
      2,
      "https://api.openai.com/v1/"
    );

    await expect(provider.embed(["first", "second"])).resolves.toEqual([
      [1, 0],
      [0, 1]
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(request.headers).toMatchObject({ authorization: "Bearer test-api-key" });
    expect(JSON.parse(request.body as string)).toEqual({
      model: "text-embedding-3-small",
      input: ["first", "second"],
      encoding_format: "float",
      dimensions: 2
    });
  });

  it("rejects malformed embedding responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, async json() { return { data: [] }; } })
    );
    const provider = new OpenAIEmbeddingProvider("test-api-key");

    await expect(provider.embed(["memory"])).rejects.toThrow(/invalid vector payload/);
  });
});
