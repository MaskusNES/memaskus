import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export function verifyDatabase(databasePath: string): void {
  const db = new Database(path.resolve(databasePath), { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma("integrity_check", { simple: true });
    if (result !== "ok") {
      throw new Error(`SQLite integrity check failed: ${String(result)}`);
    }
  } finally {
    db.close();
  }
}

export async function backupDatabase(source: string, destination: string): Promise<void> {
  const sourcePath = path.resolve(source);
  const destinationPath = path.resolve(destination);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destinationPath);
  } finally {
    db.close();
  }
  verifyDatabase(destinationPath);
}
