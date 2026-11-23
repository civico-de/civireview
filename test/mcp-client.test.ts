import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connectMcpClient, connectStdioMcpClient, writeMcpConfigFile } from '../src/mcp/client.ts';
import type { McpScopeResult } from '../src/mcp/scope.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const scope = (over: Partial<McpScopeResult> = {}): McpScopeResult => ({
  enabled: true,
  mode: 'team',
  url: 'http://127.0.0.1:1/mcp',
  token: 'secret-token',
  headers: { Authorization: 'Bearer secret-token' },
  ...over,
});

describe('writeMcpConfigFile', () => {
  test('writes an owner-only config for the knowledge server and removes it on cleanup', () => {
    const file = writeMcpConfigFile(scope())!;
    dirs.push(dirname(file.filePath));

    expect(statSync(file.filePath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file.filePath)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file.filePath, 'utf8'))).toEqual({
      mcpServers: {
        'civicrm-knowledge': {
          type: 'http',
          url: 'http://127.0.0.1:1/mcp',
          headers: { Authorization: 'Bearer secret-token' },
        },
      },
    });

    file.cleanup();
    expect(existsSync(file.filePath)).toBe(false);
  });

  test('omits headers for the public endpoint and returns null when MCP is off', () => {
    const file = writeMcpConfigFile(scope({ mode: 'public', token: null, headers: {} }))!;
    dirs.push(dirname(file.filePath));
    expect(JSON.parse(file.configJson).mcpServers['civicrm-knowledge']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:1/mcp',
    });
    file.cleanup();

    expect(writeMcpConfigFile(scope({ enabled: false }))).toBeNull();
    expect(writeMcpConfigFile(scope({ url: null }))).toBeNull();
  });
});

describe('connectMcpClient', () => {
  test('returns no tools when the scope is disabled', async () => {
    const handle = await connectMcpClient(scope({ enabled: false, mode: 'disabled', url: null }));
    expect(handle.client).toBeNull();
    expect(handle.tools).toEqual({});
    await handle.close();
  });

  test('degrades to no tools when the server is unreachable and says so', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handle = await connectMcpClient(scope());
      expect(handle.client).toBeNull();
      expect(handle.tools).toEqual({});
      await handle.close();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain('MCP server "civicrm-knowledge" unavailable');
      expect(message).not.toContain('secret-token');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('connectStdioMcpClient', () => {
  test('discovers the tools of a real stdio MCP server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'civireview-mcp-test-'));
    dirs.push(dir);
    const sdk = join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm');
    const serverPath = join(dir, 'server.mjs');
    writeFileSync(
      serverPath,
      `import { Server } from '${sdk}/server/index.js';
import { StdioServerTransport } from '${sdk}/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '${sdk}/types.js';
const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: String(req.params.arguments?.text ?? '') }],
}));
await server.connect(new StdioServerTransport());
`,
    );

    const handle = await connectStdioMcpClient({
      name: 'fake',
      command: 'bun',
      args: [serverPath],
    });
    try {
      expect(Object.keys(handle.tools)).toEqual(['echo']);
    } finally {
      await handle.close();
    }
  });

  test('degrades to no tools and warns when the command cannot start', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handle = await connectStdioMcpClient({
        name: 'missing',
        command: '/nonexistent/civireview-mcp-server',
        args: [],
      });
      expect(handle.client).toBeNull();
      expect(handle.tools).toEqual({});
      expect(String(warn.mock.calls[0]?.[0])).toContain('MCP server "missing" unavailable');
    } finally {
      warn.mockRestore();
    }
  });
});
