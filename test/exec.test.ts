import { describe, expect, test } from 'bun:test';
import { defaultExec } from '../src/evidence/ab/exec.ts';

describe('defaultExec', () => {
  test('returns the output and exit code of a command', async () => {
    const res = await defaultExec(['sh', '-c', 'echo out; echo err >&2; exit 3']);
    expect(res).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });

  test('a timed-out command is stopped together with its children', async () => {
    const started = Date.now();
    const res = await defaultExec(['sh', '-c', 'echo started; sleep 20.25 & wait'], {
      timeoutMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(Bun.spawnSync(['pgrep', '-f', 'sleep 20.25']).stdout.toString()).toBe('');
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).toBe('started\n');
  }, 15_000);
});
