import path from "node:path";

export type AppConfig = {
  databasePath: string;
  host: string;
  port: number;
};

export function loadConfig(): AppConfig {
  return {
    databasePath: process.env.MEMORY_DB_PATH ?? path.resolve("data", "memory.sqlite"),
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3010)
  };
}
