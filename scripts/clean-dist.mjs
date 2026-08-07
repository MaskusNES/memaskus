import fs from "node:fs";
import path from "node:path";

fs.rmSync(path.resolve(process.cwd(), "dist"), { recursive: true, force: true });
