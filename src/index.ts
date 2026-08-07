import { loadConfig } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
const app = await buildServer(db);

await app.listen({ host: config.host, port: config.port });
