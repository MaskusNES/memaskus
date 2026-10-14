export { createMemoryHttpClient, type MemoryHttpClient } from "../shared/http-client.js";

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
