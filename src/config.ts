import path from "node:path";

export type AppConfig = {
  databasePath: string;
  filesDir: string;
  host: string;
  port: number;
};

export function resolveFilesDir(databasePath: string): string {
  if (process.env.MEMORY_FILES_DIR) {
    return path.resolve(process.env.MEMORY_FILES_DIR);
  }
  if (databasePath === ":memory:") {
    return path.resolve("data", "files");
  }
  return path.join(path.dirname(databasePath), "files");
}

export function loadConfig(): AppConfig {
  const config = {
    databasePath: process.env.MEMORY_DB_PATH ?? path.resolve("data", "memory.sqlite"),
    filesDir: "",
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3010)
  };
  config.filesDir = resolveFilesDir(config.databasePath);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT ?? "3010"}`);
  }
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(config.host) && !process.env.MEMORY_API_KEY) {
    throw new Error("MEMORY_API_KEY is required when binding the service to a non-loopback host");
  }
  return config;
}
