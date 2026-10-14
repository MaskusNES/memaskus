// Read-only smoke check; never writes to graph memory or prints its contents.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import os from 'node:os';

const entry = path.resolve(process.argv[2] ?? 'scripts/mcp-vps.mjs');
const client = new Client({ name: 'memaskus-deployment-check', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd: os.tmpdir(),
  env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
  stderr: 'inherit'
});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ['memory_recall', 'memory_context', 'memory_get_profile']) {
    if (!tools.some(tool => tool.name === name)) throw new Error(`Missing MCP tool: ${name}`);
  }
  const result = await client.callTool({ name: 'memory_recall', arguments: {
    query: 'deployment connectivity check', scope: { kind: 'global' }, knowledge_scope: 'global', limit: 1
  }});
  if (result.isError) throw new Error('MCP read-only call failed');
  console.log(`MCP OK: ${tools.length} tools; read-only HTTP call succeeded`);
} finally {
  await client.close();
}
