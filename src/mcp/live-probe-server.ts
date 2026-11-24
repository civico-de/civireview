#!/usr/bin/env bun
/**
 * Serves `live_probe_ab` over stdio MCP, for runners whose CLI drives the tool loop.
 * Argument: the stacks as JSON (`LiveStacks`). Same tool and result as the in-process one.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ZodObject, ZodRawShape } from 'zod';
import { liveProbeTool } from '../runners/live-prove.ts';
import type { LiveStacks } from '../runners/types.ts';

const raw = process.argv[2];
if (!raw) {
  console.error('usage: live-probe-server.ts <stacks JSON>');
  process.exit(2);
}
const probe = liveProbeTool(JSON.parse(raw) as LiveStacks).live_probe_ab!;
if (typeof probe.description !== 'string')
  throw new Error('live_probe_ab needs a static description');
const description = probe.description;

const server = new McpServer({ name: 'live-probe', version: '1.0.0' });
server.registerTool(
  'live_probe_ab',
  {
    description,
    inputSchema: probe.inputSchema as ZodObject<ZodRawShape>,
  },
  async (input) => {
    const result: unknown = await probe.execute!(input, {
      toolCallId: 'mcp',
      messages: [],
      context: undefined,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);
await server.connect(new StdioServerTransport());
