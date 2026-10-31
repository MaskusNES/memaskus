import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MemoryDb } from "../src/db/connection.js";
import { blobPathFor, MAX_FILE_SIZE_BYTES, sha256Hex } from "../src/domain/files.js";
import { createMemoryHttpClient } from "../src/mcp/http-client.js";
import { createMemoryMcpServer } from "../src/mcp/server.js";
import { buildServer } from "../src/server.js";

const QA_SCOPE = { kind: "project", project_id: "project:qa" } as const;

function createFilePayload(bytes: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    content_base64: bytes.toString("base64"),
    filename: "notes.txt",
    description: "QA artifact notes",
    scope: QA_SCOPE,
    ...overrides
  };
}

describe("file artifacts", () => {
  let db: MemoryDb;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let directory: string;
  let filesDir: string;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "memaskus-files-"));
    filesDir = path.join(directory, "files");
    db = openDatabase(path.join(directory, "memory.sqlite"));
    app = await buildServer(db, { filesDir });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function store(bytes: Buffer, overrides: Record<string, unknown> = {}) {
    return app.inject({ method: "POST", url: "/v1/files", payload: createFilePayload(bytes, overrides) });
  }

  it("stores a text file, creates an Artifact node, and downloads the original bytes", async () => {
    const bytes = Buffer.from("hello memaskus files", "utf8");
    const response = await store(bytes);
    expect(response.statusCode).toBe(201);
    const created = response.json();
    const { file, memory } = created;

    expect(file.sha256).toBe(sha256Hex(bytes));
    expect(file.size).toBe(bytes.length);
    expect(file.original_name).toBe("notes.txt");
    expect(file.download_url).toBe(`/v1/files/${file.id}/content`);
    expect(memory.type).toBe("Artifact");
    expect(memory.status).toBe("active");
    expect(memory.content).toContain("QA artifact notes");
    expect(memory.content).not.toContain(bytes.toString("base64"));
    expect(memory.metadata.file_id).toBe(file.id);
    expect(memory.metadata.original_name).toBe("notes.txt");
    expect(memory.metadata.sha256).toBe(file.sha256);
    expect(memory.metadata.size).toBe(bytes.length);
    expect(JSON.stringify(memory)).not.toContain(filesDir);
    expect(JSON.stringify(memory)).not.toContain("base64");

    const blobPath = blobPathFor(filesDir, file.sha256);
    expect(blobPath.startsWith(path.resolve(filesDir))).toBe(true);
    expect(fs.existsSync(blobPath)).toBe(true);

    const meta = await app.inject({ method: "GET", url: `/v1/files/${file.id}` });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().file.id).toBe(file.id);

    const content = await app.inject({ method: "GET", url: `/v1/files/${file.id}/content` });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toContain("text/plain");
    expect(content.headers["content-disposition"]).toContain("attachment");
    expect(content.rawPayload.equals(bytes)).toBe(true);

    const recall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: { query: "artifact notes", scope: QA_SCOPE }
    });
    expect(recall.statusCode).toBe(200);
    const hit = recall.json().results.find((result: { id: string }) => result.id === memory.id);
    expect(hit).toBeTruthy();
    expect(hit.metadata.file_id).toBe(file.id);
  });

  it("round-trips binary content with NUL/non-UTF8 bytes and a Unicode name", async () => {
    const bytes = Buffer.concat([
      Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01]),
      Buffer.from("план ⧉ Δ", "utf8"),
      Buffer.from([0x00, 0x7f])
    ]);
    const name = "отчёт  ⧉ Δ.bin";
    const response = await store(bytes, { filename: name, description: "binary QA artifact" });
    expect(response.statusCode).toBe(201);
    const { file } = response.json();
    expect(file.original_name).toBe(name);

    const content = await app.inject({ method: "GET", url: `/v1/files/${file.id}/content` });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("application/octet-stream");
    expect(sha256Hex(content.rawPayload)).toBe(file.sha256);
    expect(content.rawPayload.equals(bytes)).toBe(true);
  });

  it("deduplicates shared bytes and keeps the blob until the last descriptor is deleted", async () => {
    const bytes = Buffer.from("shared blob bytes", "utf8");
    const first = (await store(bytes)).json();
    const second = (await store(bytes, {
      filename: "copy.txt",
      description: "duplicate bytes, other descriptor",
      scope: { kind: "project", project_id: "project:qa-other" }
    })).json();
    expect(second.file.sha256).toBe(first.file.sha256);
    expect(second.file.id).not.toBe(first.file.id);
    expect(second.memory.id).not.toBe(first.memory.id);
    const blobPath = blobPathFor(filesDir, first.file.sha256);
    expect(fs.existsSync(blobPath)).toBe(true);

    await app.inject({ method: "DELETE", url: `/v1/memories/${first.memory.id}`, payload: {} });
    const stillThere = await app.inject({ method: "GET", url: `/v1/files/${second.file.id}/content` });
    expect(stillThere.statusCode).toBe(200);
    expect(stillThere.rawPayload.equals(bytes)).toBe(true);
    expect(fs.existsSync(blobPath)).toBe(true);
    const gone = await app.inject({ method: "GET", url: `/v1/files/${first.file.id}/content` });
    expect(gone.statusCode).toBe(404);

    await app.inject({ method: "DELETE", url: `/v1/memories/${second.memory.id}`, payload: {} });
    expect(fs.existsSync(blobPath)).toBe(false);
  });

  it("keeps file bytes after archive and stops serving them after delete", async () => {
    const bytes = Buffer.from("lifecycle bytes", "utf8");
    const { file, memory } = (await store(bytes)).json();

    const archived = await app.inject({ method: "POST", url: `/v1/memories/${memory.id}/archive`, payload: {} });
    expect(archived.statusCode).toBe(200);
    const contentAfterArchive = await app.inject({ method: "GET", url: `/v1/files/${file.id}/content` });
    expect(contentAfterArchive.statusCode).toBe(200);
    expect(fs.existsSync(blobPathFor(filesDir, file.sha256))).toBe(true);

    await app.inject({ method: "DELETE", url: `/v1/memories/${memory.id}`, payload: {} });
    const contentAfterDelete = await app.inject({ method: "GET", url: `/v1/files/${file.id}/content` });
    expect(contentAfterDelete.statusCode).toBe(404);
  });

  it("isolates file descriptors by scope in list and recall", async () => {
    const bytes = Buffer.from("scoped secret-free bytes", "utf8");
    const { memory } = (await store(bytes)).json();

    const otherRecall = await app.inject({
      method: "POST",
      url: "/v1/recall",
      payload: { query: "scoped bytes", scope: { kind: "project", project_id: "project:qa-other" } }
    });
    expect(otherRecall.json().results.map((result: { id: string }) => result.id)).not.toContain(memory.id);

    const list = await app.inject({
      method: "GET",
      url: "/v1/memories?types=Artifact&scope_kind=project&project_id=project:qa-other"
    });
    expect(list.json().memories.map((entry: { id: string }) => entry.id)).not.toContain(memory.id);
  });

  it("rejects files over the 10 MiB limit, invalid base64, and non-normal privacy", async () => {
    const tooBig = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1, 1);
    const bigResponse = await store(tooBig);
    expect(bigResponse.statusCode).toBe(400);
    expect(bigResponse.json().message).toMatch(/exceeds/u);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/files",
      payload: createFilePayload(Buffer.from("x"), { content_base64: "!!!not-base64!!!" })
    });
    expect(invalid.statusCode).toBe(400);

    const sensitive = await store(Buffer.from("private bytes"), { privacy_level: "secret" });
    expect(sensitive.statusCode).toBe(400);
    expect(sensitive.json().message).toMatch(/privacy_level=normal/u);
  });

  it("rejects a sha256 that does not match the uploaded bytes", async () => {
    const response = await store(Buffer.from("mismatch bytes"), {
      sha256: "0".repeat(64)
    });
    expect(response.statusCode).toBe(400);
  });

  it("sanitizes traversal file names and never derives blob paths from them", async () => {
    const bytes = Buffer.from("traversal check", "utf8");
    const response = await store(bytes, { filename: "../../../etc/evil.txt" });
    expect(response.statusCode).toBe(201);
    const { file } = response.json();
    expect(file.original_name).not.toContain("/");
    expect(file.original_name).toBe("evil.txt");
    const blobPath = blobPathFor(filesDir, file.sha256);
    expect(path.resolve(blobPath).startsWith(path.resolve(filesDir))).toBe(true);
  });

  it("never lets client metadata override server-side descriptor fields", async () => {
    const bytes = Buffer.from("descriptor integrity bytes", "utf8");
    const response = await store(bytes, {
      metadata: {
        file_id: "file:fake",
        sha256: "0".repeat(64),
        size: 999999,
        original_name: "evil.txt",
        download_url: "https://evil.example/x",
        custom_tag: "qa-ok"
      }
    });
    expect(response.statusCode).toBe(201);
    const { file, memory } = response.json();
    expect(memory.metadata.file_id).toBe(file.id);
    expect(memory.metadata.sha256).toBe(file.sha256);
    expect(memory.metadata.size).toBe(bytes.length);
    expect(memory.metadata.original_name).toBe("notes.txt");
    expect(memory.metadata.download_url).toBe(`/v1/files/${file.id}/content`);
    expect(memory.metadata.custom_tag).toBe("qa-ok");

    const content = await app.inject({ method: "GET", url: `/v1/files/${file.id}/content` });
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.equals(bytes)).toBe(true);
  });

  it("rejects an invalid mime_type with 400 instead of failing on download", async () => {
    const bad = await store(Buffer.from("mime bytes"), { mime_type: "text/plain\r\nX-Injected: 1" });
    expect(bad.statusCode).toBe(400);

    const weird = await store(Buffer.from("mime bytes"), { mime_type: "not-a-mime-type" });
    expect(weird.statusCode).toBe(400);

    const good = await store(Buffer.from("mime bytes"), { mime_type: "text/markdown" });
    expect(good.statusCode).toBe(201);
    const { file } = good.json();
    const content = await app.inject({ method: "GET", url: `/v1/files/${file.id}/content` });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toContain("text/markdown");
  });

  it("applies the API key to the new file routes", async () => {
    const originalKey = process.env.MEMORY_API_KEY;
    process.env.MEMORY_API_KEY = "files-test-key";
    try {
      await app.close();
      db.close();
      db = openDatabase(path.join(directory, "memory.sqlite"));
      app = await buildServer(db, { filesDir });

      const denied = await app.inject({ method: "GET", url: "/v1/files/anything" });
      expect(denied.statusCode).toBe(401);
      const allowed = await app.inject({
        method: "GET",
        url: "/v1/files/anything",
        headers: { "x-memory-api-key": "files-test-key" }
      });
      expect(allowed.statusCode).toBe(404);
    } finally {
      if (originalKey === undefined) {
        delete process.env.MEMORY_API_KEY;
      } else {
        process.env.MEMORY_API_KEY = originalKey;
      }
    }
  });

  it("adds the files table on a migrated database without touching stored rows", () => {
    const before = db.prepare("SELECT COUNT(*) AS count FROM nodes").get() as { count: number };
    db.close();
    const reopened = openDatabase(path.join(directory, "memory.sqlite"));
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'files'").get()).toBeTruthy();
    expect(reopened.pragma("user_version", { simple: true })).toBe(5);
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM nodes").get()).toEqual(before);
    reopened.close();
    db = openDatabase(path.join(directory, "memory.sqlite")) as never;
  });
});

describe("file artifacts through MCP", () => {
  let db: MemoryDb;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let directory: string;
  let client: Client;
  let mcpServer: ReturnType<typeof createMemoryMcpServer>;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "memaskus-mcp-files-"));
    db = openDatabase(path.join(directory, "memory.sqlite"));
    app = await buildServer(db, { filesDir: path.join(directory, "files") });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server address");
    }
    mcpServer = createMemoryMcpServer(createMemoryHttpClient(`http://127.0.0.1:${address.port}`));
    client = new Client({ name: "test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await mcpServer.close();
    await app.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("stores a local file and downloads it back without putting bytes into tool results", async () => {
    const sourcePath = path.join(directory, "源ファイル データ.txt");
    const original = Buffer.from("MCP roundtrip ✓\0binary", "utf8");
    fs.writeFileSync(sourcePath, original);

    const stored = await client.callTool({
      name: "memory_store_file",
      arguments: {
        path: sourcePath,
        description: "MCP QA artifact",
        scope: QA_SCOPE
      }
    });
    const storedResult = (stored as unknown as { structuredContent: { result: { file: { id: string; sha256: string } } } })
      .structuredContent.result;
    expect(storedResult.file.sha256).toBe(sha256Hex(original));
    expect(JSON.stringify(stored)).not.toContain(original.toString("base64"));

    const destination = path.join(directory, "restored.txt");
    const downloaded = await client.callTool({
      name: "memory_download_file",
      arguments: { file_id: storedResult.file.id, destination_path: destination }
    });
    const downloadResult = (downloaded as unknown as { structuredContent: { result: { written_bytes: number } } })
      .structuredContent.result;
    expect(downloadResult.written_bytes).toBe(original.length);
    expect(sha256Hex(fs.readFileSync(destination))).toBe(storedResult.file.sha256);

    const refused = await client.callTool({
      name: "memory_download_file",
      arguments: { file_id: storedResult.file.id, destination_path: destination }
    });
    expect((refused as { isError?: boolean }).isError).toBe(true);

    const overwritten = await client.callTool({
      name: "memory_download_file",
      arguments: { file_id: storedResult.file.id, destination_path: destination, overwrite: true }
    });
    expect((overwritten as { isError?: boolean }).isError).toBeUndefined();
  });
});
