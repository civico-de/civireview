import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolSet } from 'ai';
import type { ExtraMcpServerConfig } from '../runners/types.ts';
import type { McpScopeResult } from './scope.ts';

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
  } catch {
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
  } catch {
    return {
      client: null,
      tools: {},
      close: async () => {},
    };
  }
}

/**
 * Writes a temporary `0600` `--mcp-config` JSON file for CLI runners
 * (`claude-cli`, etc.) and returns a cleanup callback.
 */
export function writeMcpConfigFile(scope: McpScopeResult): TempMcpConfigFile | null {
  if (!scope.enabled || !scope.url) {
    return null;
  }

  const dir = mkdtempSync(join(tmpdir(), 'civireview-mcp-'));
  chmodSync(dir, 0o700);
  const filePath = join(dir, 'mcp-config.json');

  const serverEntry: Record<string, unknown> = {
    type: 'http',
    url: scope.url,
  };
  if (Object.keys(scope.headers).length > 0) {
    serverEntry.headers = scope.headers;
  }

  const payload = {
    mcpServers: {
      'civicrm-knowledge': serverEntry,
    },
  };
  const configJson = JSON.stringify(payload, null, 2);
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
