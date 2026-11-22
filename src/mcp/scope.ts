import type { McpConfig } from '../config/schema.ts';

export interface McpScopeInput {
  isPrivateRepo: boolean;
  config: { mcp: McpConfig };
  env?: Record<string, string | undefined>;
}

export interface McpScopeResult {
  enabled: boolean;
  mode: 'disabled' | 'public' | 'team';
  url: string | null;
  token: string | null;
  headers: Record<string, string>;
}

/**
 * Resolves the civicrm-knowledge MCP endpoint and auth headers.
 *
 * SECURITY INVARIANT: For public repositories (`isPrivateRepo === false`),
 * this function ALWAYS selects the public endpoint (`config.mcp.publicUrl`)
 * and NEVER attaches a team token (`env[config.mcp.tokenEnv]`), even if
 * `teamUrl` and the team token are present in the environment.
 */
export function resolveMcpScope(input: McpScopeInput): McpScopeResult {
  const { isPrivateRepo, config } = input;
  const env = input.env ?? process.env;

  if (!config.mcp.enabled) {
    return {
      enabled: false,
      mode: 'disabled',
      url: null,
      token: null,
      headers: {},
    };
  }

  if (!isPrivateRepo) {
    const guestToken = env.CIVICRM_MCP_GUEST_TOKEN?.trim() || null;
    const headers: Record<string, string> = guestToken
      ? { Authorization: `Bearer ${guestToken}` }
      : {};
    return {
      enabled: true,
      mode: 'public',
      url: config.mcp.publicUrl,
      token: guestToken,
      headers,
    };
  }

  const teamUrl = config.mcp.teamUrl ?? (env.CIVICRM_MCP_URL?.trim() || undefined);
  if (teamUrl) {
    const teamToken = env[config.mcp.tokenEnv]?.trim() || null;
    const headers: Record<string, string> = teamToken
      ? { Authorization: `Bearer ${teamToken}` }
      : {};
    return {
      enabled: true,
      mode: 'team',
      url: teamUrl,
      token: teamToken,
      headers,
    };
  }

  const guestToken = env.CIVICRM_MCP_GUEST_TOKEN?.trim() || null;
  const headers: Record<string, string> = guestToken
    ? { Authorization: `Bearer ${guestToken}` }
    : {};
  return {
    enabled: true,
    mode: 'public',
    url: config.mcp.publicUrl,
    token: guestToken,
    headers,
  };
}
