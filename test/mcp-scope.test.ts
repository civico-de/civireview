import { describe, expect, test } from 'bun:test';
import { McpConfigSchema } from '../src/config/schema.ts';
import { resolveMcpScope } from '../src/mcp/scope.ts';

describe('MCP scope isolation', () => {
  const baseConfig = {
    mcp: McpConfigSchema.parse({
      publicUrl: 'https://mcp.civico.de/mcp',
      teamUrl: 'https://team-mcp.example.invalid/mcp',
      tokenEnv: 'CIVICRM_MCP_TOKEN',
      enabled: true,
    }),
  };

  test('PUBLIC repo NEVER receives teamUrl or team bearer token', () => {
    const scope = resolveMcpScope({
      isPrivateRepo: false,
      config: baseConfig,
      env: {
        CIVICRM_MCP_TOKEN: 'super-secret-team-token',
        CIVICRM_MCP_URL: 'https://private-team-mcp.example.invalid/mcp',
      },
    });

    expect(scope.enabled).toBe(true);
    expect(scope.mode).toBe('public');
    expect(scope.url).toBe('https://mcp.civico.de/mcp');
    expect(scope.url).not.toBe(baseConfig.mcp.teamUrl);
    expect(scope.token).toBeNull();
    expect(scope.headers).toEqual({});
    expect(JSON.stringify(scope)).not.toContain('super-secret-team-token');
    expect(JSON.stringify(scope)).not.toContain('private-team-mcp');
  });

  test('PUBLIC repo attaches only explicit CIVICRM_MCP_GUEST_TOKEN if present', () => {
    const scope = resolveMcpScope({
      isPrivateRepo: false,
      config: baseConfig,
      env: {
        CIVICRM_MCP_TOKEN: 'super-secret-team-token',
        CIVICRM_MCP_GUEST_TOKEN: 'public-guest-token',
      },
    });

    expect(scope.mode).toBe('public');
    expect(scope.url).toBe('https://mcp.civico.de/mcp');
    expect(scope.token).toBe('public-guest-token');
    expect(scope.headers).toEqual({
      Authorization: 'Bearer public-guest-token',
    });
  });

  test('PRIVATE repo uses teamUrl and team token when configured', () => {
    const scope = resolveMcpScope({
      isPrivateRepo: true,
      config: baseConfig,
      env: {
        CIVICRM_MCP_TOKEN: 'super-secret-team-token',
      },
    });

    expect(scope.enabled).toBe(true);
    expect(scope.mode).toBe('team');
    expect(scope.url).toBe('https://team-mcp.example.invalid/mcp');
    expect(scope.token).toBe('super-secret-team-token');
    expect(scope.headers).toEqual({
      Authorization: 'Bearer super-secret-team-token',
    });
  });

  test('disabled MCP returns disabled scope with no URL or headers', () => {
    const scope = resolveMcpScope({
      isPrivateRepo: true,
      config: {
        mcp: McpConfigSchema.parse({ enabled: false }),
      },
      env: { CIVICRM_MCP_TOKEN: 'secret' },
    });

    expect(scope.enabled).toBe(false);
    expect(scope.mode).toBe('disabled');
    expect(scope.url).toBeNull();
    expect(scope.token).toBeNull();
    expect(scope.headers).toEqual({});
  });
});
