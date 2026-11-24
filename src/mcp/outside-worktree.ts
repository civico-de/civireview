#!/usr/bin/env bun
/**
 * Runs an MCP server command from civireview's own directory. Started by `bun --cwd`, so
 * neither bun nor the server (e.g. npx) reads a `bunfig.toml`, `.env` or `.npmrc` of the PR.
 */
const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: outside-worktree.ts <command> [args...]');
  process.exit(2);
}
const proc = Bun.spawn(argv, { stdio: ['inherit', 'inherit', 'inherit'] });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => proc.kill(signal));
}
process.exit(await proc.exited);
