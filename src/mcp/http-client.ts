export type MemoryHttpClient = {
  request(path: string, options?: RequestInit): Promise<unknown>;
};

export function createMemoryHttpClient(baseUrl: string, fetchImpl: typeof fetch = fetch): MemoryHttpClient {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const apiKey = process.env.MEMORY_API_KEY;

  return {
    async request(path: string, options: RequestInit = {}) {
      const response = await fetchImpl(`${normalizedBaseUrl}${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { "x-memory-api-key": apiKey } : {}),
          ...options.headers
        }
      });

      const text = await response.text();
      const body = text ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(JSON.stringify(body ?? { status: response.status }, null, 2));
      }

      return body;
    }
  };
}

export function jsonToolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: {
      result: value
    }
  };
}
