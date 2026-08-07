import Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { createRelatedLinksForMemory } from "../domain/links.js";
import { mapNode } from "../domain/mappers.js";

const db = new Database(process.env.MEMORY_DB_PATH ?? loadConfig().databasePath);
const rows = db.prepare("SELECT * FROM nodes WHERE status = 'active' ORDER BY created_at ASC").all();
let created = 0;

const transaction = db.transaction(() => {
  for (const row of rows) {
    const links = createRelatedLinksForMemory(db, mapNode(row as never));
    created += links.length;
  }
});

transaction();
db.close();

console.log(JSON.stringify({ created }, null, 2));
