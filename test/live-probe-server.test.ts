import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectStdioMcpClient } from '../src/mcp/client.ts';
import { liveProbeMcpServer } from '../src/runners/live-prove.ts';

describe('live-probe MCP server', () => {
  test('offers live_probe_ab over stdio with the in-process schema and result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'civireview-live-mcp-'));
    const composeFiles = { A: join(dir, 'A.compose.json'), B: join(dir, 'B.compose.json') };
    writeFileSync(composeFiles.A, '{}');
    writeFileSync(composeFiles.B, '{}');

    const handle = await connectStdioMcpClient(
      liveProbeMcpServer({ composeFiles, urls: {}, maxExecSeconds: 30 }),
    );
    try {
      expect(Object.keys(handle.tools)).toEqual(['live_probe_ab']);
      // http-get without URLs answers without touching Docker
      const result = (await handle.tools.live_probe_ab!.execute!(
        { mode: 'http-get' },
        { toolCallId: 't', messages: [], context: undefined },
      )) as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0]!.text)).toEqual({
        error: 'Live A/B HTTP URLs are unavailable.',
        differs: false,
      });
    } finally {
      await handle.close();
    }
  });
});
