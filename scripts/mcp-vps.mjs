// Use this launcher for both VPS clients and remote SSH clients.
// Resolve the adapter from this file, never from the client's working directory.
import { runMemoryMcpServer } from '../dist/mcp/server.js';

const envFile = process.env.MEMORY_ENV_FILE ?? '/etc/agent-memory.env';
try {
  process.loadEnvFile(envFile);
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error(`Cannot read MCP environment file: ${envFile}`);
    process.exit(1);
  }
}
process.env.MEMORY_API_URL ??= 'http://127.0.0.1:39110';
await runMemoryMcpServer();
