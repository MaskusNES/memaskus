import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MemoryDb } from "../db/connection.js";
import { NotFoundError, ValidationError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { nowIso } from "../shared/time.js";
import { createMemory } from "./nodes.js";
import type { MemoryNode, Scope } from "./types.js";

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const FILE_NODE_TYPE = "Artifact";
export const MIME_TYPE_PATTERN = /^[-\w.+]+\/[-\w.+]+$/u;

export type FileDescriptor = {
  id: string;
  node_id: string;
  original_name: string;
  mime_type: string;
  size: number;
  sha256: string;
  download_url: string;
  created_at: string;
};

export type StoreFileInput = {
  bytes: Buffer;
  originalName: string;
  description: string;
  mimeType?: string;
  scope?: Scope;
  confidence?: number;
  metadata?: Record<string, unknown>;
  privacyLevel?: MemoryNode["privacy_level"];
  expectedSha256?: string;
};

function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[\\/:*?"<>|\0-\u001F]/gu, "_").trim();
  return base.length > 0 ? base.slice(0, 200) : "file";
}

export function detectMimeType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const known: Record<string, string> = {
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".wasm": "application/wasm"
  };
  return known[ext] ?? "application/octet-stream";
}

// Blob paths derive only from the server-side content hash, so client names
// and paths can never steer the on-disk location (no path traversal).
export function blobPathFor(filesDir: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new ValidationError("Invalid content hash");
  }
  return path.join(filesDir, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeBlobAtomically(blobPath: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  const tempPath = `${blobPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, bytes);
    fs.renameSync(tempPath, blobPath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

type FileRow = {
  id: string;
  node_id: string;
  original_name: string;
  mime_type: string;
  size: number;
  sha256: string;
  created_at: string;
};

function mapFile(row: FileRow): FileDescriptor {
  return {
    id: row.id,
    node_id: row.node_id,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size: row.size,
    sha256: row.sha256,
    download_url: `/v1/files/${row.id}/content`,
    created_at: row.created_at
  };
}

export function getFileDescriptor(db: MemoryDb, fileId: string): FileDescriptor {
  const row = db.prepare("SELECT * FROM files WHERE id = ? AND deleted_at IS NULL").get(fileId) as
    | FileRow
    | undefined;
  if (!row) {
    throw new NotFoundError(`File ${fileId} was not found`);
  }
  return mapFile(row);
}

export function storeFile(db: MemoryDb, filesDir: string, input: StoreFileInput): { file: FileDescriptor; memory: MemoryNode } {
  if (input.privacyLevel && input.privacyLevel !== "normal") {
    throw new ValidationError("File artifacts only support privacy_level=normal in this version");
  }
  if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) {
    throw new ValidationError("File content must be non-empty bytes");
  }
  if (input.bytes.length > MAX_FILE_SIZE_BYTES) {
    throw new ValidationError(
      `File size ${input.bytes.length} bytes exceeds the ${MAX_FILE_SIZE_BYTES} byte limit`
    );
  }
  const originalName = sanitizeFileName(input.originalName);
  const sha256 = sha256Hex(input.bytes);
  if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sha256) {
    throw new ValidationError("Provided sha256 does not match the uploaded content");
  }
  const trimmedMimeType = input.mimeType?.trim() || "";
  const mimeType = MIME_TYPE_PATTERN.test(trimmedMimeType) ? trimmedMimeType : detectMimeType(originalName);
  const description = input.description.trim();
  if (!description) {
    throw new ValidationError("File description is required");
  }
  const scope = input.scope ?? { kind: "global" };
  const fileId = newId("file");
  const blobPath = blobPathFor(filesDir, sha256);

  // Content-addressable dedup: identical bytes reuse one physical blob.
  if (!fs.existsSync(blobPath)) {
    writeBlobAtomically(blobPath, input.bytes);
  }

  const memory = createMemory(db, {
    type: FILE_NODE_TYPE,
    content: `${description} (file: ${originalName})`,
    scope,
    confidence: input.confidence ?? 0.8,
    privacy_level: "normal",
    metadata: {
      ...input.metadata,
      file_id: fileId,
      original_name: originalName,
      mime_type: mimeType,
      size: input.bytes.length,
      sha256,
      download_url: `/v1/files/${fileId}/content`
    },
    source: { kind: "mcp", title: "Файловый артефакт сохранён через HTTP API" }
  });
  try {
    db.prepare(
      `INSERT INTO files (id, node_id, original_name, mime_type, size, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(fileId, memory.id, originalName, mimeType, input.bytes.length, sha256, nowIso());
  } catch (error) {
    db.prepare("DELETE FROM nodes WHERE id = ?").run(memory.id);
    const remaining = db
      .prepare("SELECT COUNT(*) AS count FROM files WHERE sha256 = ? AND deleted_at IS NULL")
      .get(sha256) as { count: number };
    if (remaining.count === 0 && fs.existsSync(blobPath)) {
      fs.rmSync(blobPath, { force: true });
    }
    throw error;
  }

  return { file: getFileDescriptor(db, fileId), memory };
}

export function readFileBytes(db: MemoryDb, filesDir: string, fileId: string): { bytes: Buffer; descriptor: FileDescriptor } {
  const descriptor = getFileDescriptor(db, fileId);
  const node = db.prepare("SELECT status FROM nodes WHERE id = ?").get(descriptor.node_id) as
    | { status: string }
    | undefined;
  if (!node || node.status === "deleted") {
    throw new NotFoundError(`File ${fileId} is no longer available`);
  }
  const blobPath = blobPathFor(filesDir, descriptor.sha256);
  if (!fs.existsSync(blobPath)) {
    throw new NotFoundError(`File ${fileId} content is missing on the server`);
  }
  const bytes = fs.readFileSync(blobPath);
  if (bytes.length !== descriptor.size || sha256Hex(bytes) !== descriptor.sha256) {
    throw new NotFoundError(`File ${fileId} content failed integrity verification`);
  }
  return { bytes, descriptor };
}

// Called after a memory node is forgotten. Releases the physical blob only
// when no other live descriptor references the same content hash.
export function releaseFileForNode(db: MemoryDb, filesDir: string, nodeId: string): void {
  const rows = db
    .prepare("SELECT id, sha256 FROM files WHERE node_id = ? AND deleted_at IS NULL")
    .all(nodeId) as Array<{ id: string; sha256: string }>;
  if (!rows.length) {
    return;
  }
  const now = nowIso();
  for (const row of rows) {
    db.prepare("UPDATE files SET deleted_at = ? WHERE id = ?").run(now, row.id);
    const remaining = db
      .prepare(
        `SELECT COUNT(*) AS count FROM files f JOIN nodes n ON n.id = f.node_id
         WHERE f.sha256 = ? AND f.deleted_at IS NULL AND n.status != 'deleted'`
      )
      .get(row.sha256) as { count: number };
    if (remaining.count === 0) {
      const blobPath = blobPathFor(filesDir, row.sha256);
      if (fs.existsSync(blobPath)) {
        fs.rmSync(blobPath, { force: true });
      }
    }
  }
}
