import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolSet } from 'ai';
import type { ExtraMcpServerConfig } from '../runners/types.ts';
import type { McpScopeResult } from './scope.ts';

function warnUnavailable(name: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  console.warn(
    `[civireview:warn] MCP server "${name}" unavailable, continuing without it: ${reason}`,
  );
}

export interface ConnectedMcpHandle {
  client: MCPClient | null;
  tools: ToolSet;
  close: () => Promise<void>;
}

/**
 * Connects to `civicrm-knowledge` over Streamable HTTP when `scope.enabled` is true.
 * Degrades cleanly (empty tools, no-op close) if disabled or unreachable.
 */
export async function connectMcpClient(scope: McpScopeResult): Promise<ConnectedMcpHandle> {
  if (!scope.enabled || !scope.url) {
    return {
      client: null,
      tools: {},
      close: async () => {},
    };
  }

  try {
    const transport = new StreamableHTTPClientTransport(new URL(scope.url), {
      requestInit: {
        headers: scope.headers,
      },
    });
    const client = await createMCPClient({
      transport,
      clientName: 'civireview',
      version: '0.1.0',
    });
    const mcpTools = await client.tools();
    return {
      client,
      tools: mcpTools as unknown as ToolSet,
      close: async () => {
        try {
          await client.close();
        } catch {
          // ignore close errors
        }
      },
    };
  } catch (err) {
    warnUnavailable('civicrm-knowledge', err);
    return {
      client: null,
      tools: {},
      close: async () => {},
    };
  }
}

export interface TempMcpConfigFile {
  filePath: string;
  configJson: string;
  cleanup: () => void;
}

/**
 * Connects to a local stdio MCP server (e.g. Playwright MCP for Tier 2 interactive browser).
 * Degrades cleanly (empty tools, no-op close) if the server command cannot start.
 */
export async function connectStdioMcpClient(
  server: ExtraMcpServerConfig,
): Promise<ConnectedMcpHandle> {
  try {
    const transport = new StdioMCPTransport({
      command: server.command,
      args: server.args,
    });
    const client = await createMCPClient({
      transport,
      clientName: `civireview-${server.name}`,
      version: '0.1.0',
    });
    const mcpTools = await client.tools();
    return {
      client,
      tools: mcpTools as unknown as ToolSet,
      close: async () => {
        try {
          await client.close();
        } catch {
          // ignore close errors
        }
      },
    };
  } catch (err) {
    warnUnavailable(server.name, err);
    return {
      client: null,
      tools: {},
      close: async () => {},
    };
  }
}

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * Wraps a stdio server so it starts in civireview's directory. A CLI runner works in the
 * PR worktree, where the PR could plant `bunfig.toml`, `.env` or `.npmrc`.
 */
export function outsideWorktree(server: ExtraMcpServerConfig): ExtraMcpServerConfig {
  return {
    ...server,
    command: process.execPath,
    args: [
      '--cwd',
      REPO_ROOT,
      '--no-env-file',
      join(import.meta.dir, 'outside-worktree.ts'),
      server.command,
      ...server.args,
    ],
  };
}

/**
 * Writes a temporary `0600` `--mcp-config` file with the knowledge server (when enabled)
 * and the given stdio servers, each started outside the worktree; returns a cleanup callback.
 */
export function writeMcpConfigFile(
  scope: McpScopeResult | undefined,
  stdioServers: ExtraMcpServerConfig[] = [],
): TempMcpConfigFile | null {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  if (scope?.enabled && scope.url) {
    mcpServers['civicrm-knowledge'] = {
      type: 'http',
      url: scope.url,
      ...(Object.keys(scope.headers).length > 0 ? { headers: scope.headers } : {}),
    };
  }
  for (const server of stdioServers.map(outsideWorktree)) {
    mcpServers[server.name] = {
      type: 'stdio',
      command: server.command,
      args: server.args,
      ...(server.timeoutMs ? { timeout: server.timeoutMs } : {}),
    };
  }
  if (Object.keys(mcpServers).length === 0) {
    return null;
  }

  const dir = mkdtempSync(join(tmpdir(), 'civireview-mcp-'));
  chmodSync(dir, 0o700);
  const filePath = join(dir, 'mcp-config.json');

  const configJson = JSON.stringify({ mcpServers }, null, 2);
  writeFileSync(filePath, configJson, { mode: 0o600 });
  chmodSync(filePath, 0o600);

  return {
    filePath,
    configJson,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
