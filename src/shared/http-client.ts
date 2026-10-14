export type MemoryHttpClient = {
  request(path: string, options?: RequestInit): Promise<unknown>;
};

export function createMemoryHttpClient(baseUrl: string = process.env.MEMORY_API_URL ?? "http://127.0.0.1:3010", fetchImpl: typeof fetch = fetch): MemoryHttpClient {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const apiKey = process.env.MEMORY_API_KEY;

  return {
    async request(path: string, options: RequestInit = {}) {
      const headers = new Headers(options.headers);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      if (apiKey && !headers.has("x-memory-api-key")) headers.set("x-memory-api-key", apiKey);
      const response = await fetchImpl(`${normalizedBaseUrl}${path}`, {
        ...options,
        headers
      });

      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          // Proxies may return HTML; do not leak their response bodies or credentials.
          throw new Error(`Memory API returned non-JSON response (HTTP ${response.status})`);
        }
      }

      if (!response.ok) {
        throw new Error(JSON.stringify(body ?? { status: response.status }, null, 2));
      }

      return body;
    }
  };
}
