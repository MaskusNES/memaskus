import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const copies = [
  ["src/db/schema.sql", "dist/db/schema.sql"]
];

for (const [source, target] of copies) {
  const sourcePath = path.resolve(root, source);
  const targetPath = path.resolve(root, target);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}
