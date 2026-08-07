import { Command } from "commander";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { projectExistingPreferencesToProfile } from "../domain/profile.js";

const program = new Command();

program
  .name("memory:migrate-profile")
  .description("Project existing active Preference memory nodes into mutable profile slots")
  .option("--db <path>", "SQLite database path", process.env.MEMORY_DB_PATH ?? loadConfig().databasePath)
  .option("--user <userId>", "profile user id", "default")
  .option("--limit <limit>", "maximum number of active Preference nodes to scan", "10000")
  .action((options) => {
    const db = openDatabase(options.db);
    try {
      const summary = projectExistingPreferencesToProfile(db, {
        user_id: options.user,
        limit: Number(options.limit)
      });
      console.log(JSON.stringify(summary, null, 2));
    } finally {
      db.close();
    }
  });

await program.parseAsync();
