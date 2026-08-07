export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions?: number;
  readonly maxBatchSize: number;
  embed(texts: string[]): Promise<number[][]>;
}

type OpenAIEmbeddingResponse = {
  data?: Array<{ index?: number; embedding?: number[] }>;
};

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai";
  readonly maxBatchSize = 64;

  constructor(
    private readonly apiKey: string,
    readonly model = "text-embedding-3-small",
    readonly dimensions?: number,
    private readonly baseUrl = "https://api.openai.com/v1",
    private readonly timeoutMs = 15_000
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    if (texts.length > this.maxBatchSize) {
      throw new Error(`Embedding batch exceeds provider limit of ${this.maxBatchSize}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/u, "")}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          encoding_format: "float",
          ...(this.dimensions ? { dimensions: this.dimensions } : {})
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Embedding provider returned HTTP ${response.status}`);
      }

      const body = (await response.json()) as OpenAIEmbeddingResponse;
      const ordered = [...(body.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
      const vectors = ordered.map((item) => item.embedding);
      if (
        vectors.length !== texts.length ||
        vectors.some(
          (vector) =>
            !Array.isArray(vector) ||
            vector.length === 0 ||
            vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
        )
      ) {
        throw new Error("Embedding provider returned an invalid vector payload");
      }
      return vectors as number[][];
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createEmbeddingProviderFromEnv(): EmbeddingProvider | undefined {
  const provider = process.env.MEMORY_EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === "none" || provider === "disabled") {
    return undefined;
  }
  if (provider !== "openai") {
    throw new Error(`Unsupported MEMORY_EMBEDDING_PROVIDER: ${provider}`);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required when MEMORY_EMBEDDING_PROVIDER=openai");
  }
  const dimensions = positiveInteger(process.env.MEMORY_EMBEDDING_DIMENSIONS, "MEMORY_EMBEDDING_DIMENSIONS");
  const timeoutMs = positiveInteger(process.env.MEMORY_EMBEDDING_TIMEOUT_MS, "MEMORY_EMBEDDING_TIMEOUT_MS");
  return new OpenAIEmbeddingProvider(
    apiKey,
    process.env.MEMORY_EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
    dimensions,
    process.env.MEMORY_EMBEDDING_BASE_URL?.trim() || "https://api.openai.com/v1",
    timeoutMs ?? 15_000
  );
}
