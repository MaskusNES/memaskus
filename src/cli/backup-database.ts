import path from "node:path";
import { backupDatabase, verifyDatabase } from "../db/backup.js";

function usage(): never {
  throw new Error("Usage: backup-database <backup|verify> <source.sqlite> [destination.sqlite]");
}

const [command, source, destination] = process.argv.slice(2);
if (!command || !source) {
  usage();
}

if (command === "verify") {
  verifyDatabase(path.resolve(source));
} else if (command === "backup") {
  if (!destination) {
    usage();
  }
  await backupDatabase(path.resolve(source), path.resolve(destination));
} else {
  usage();
}
