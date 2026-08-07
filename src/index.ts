import { loadConfig } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
const app = await buildServer(db);

await app.listen({ host: config.host, port: config.port });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    process.exitCode = 0;
  } catch (error) {
    app.log.error(error, "graceful shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
