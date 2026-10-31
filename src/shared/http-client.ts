export type RawHttpResponse = {
  status: number;
  ok: boolean;
  contentType: string | null;
  contentDisposition: string | null;
  buffer: () => Promise<ArrayBuffer>;
  text: () => Promise<string>;
};

export type MemoryHttpClient = {
  request(path: string, options?: RequestInit): Promise<unknown>;
  requestRaw(path: string, options?: RequestInit): Promise<RawHttpResponse>;
};

export function createMemoryHttpClient(baseUrl: string = process.env.MEMORY_API_URL ?? "http://127.0.0.1:3010", fetchImpl: typeof fetch = fetch): MemoryHttpClient {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const apiKey = process.env.MEMORY_API_KEY;

  function applyAuth(options: RequestInit): Headers {
    const headers = new Headers(options.headers);
    if (options.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (apiKey && !headers.has("x-memory-api-key")) headers.set("x-memory-api-key", apiKey);
    return headers;
  }

  return {
    async requestRaw(path: string, options: RequestInit = {}) {
      const response = await fetchImpl(`${normalizedBaseUrl}${path}`, {
        ...options,
        headers: applyAuth(options)
      });
      return {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type"),
        contentDisposition: response.headers.get("content-disposition"),
        buffer: () => response.arrayBuffer(),
        text: () => response.text()
      };
    },

    async request(path: string, options: RequestInit = {}) {
      const headers = applyAuth(options);
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
