import type { RunCommandResult } from './parsers.ts';

// How long a killed command's children may keep its output open before it is given up.
const DRAIN_MS = 2_000;

const running = new Set<number>();

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // The group is gone already.
  }
}

// A detached group does not get the terminal's Ctrl-C; pass an interrupt on.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    running.forEach(killGroup);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

/** Runs a command and collects its output; a command over `timeoutMs` is killed and reported as timed out. */
export async function defaultExec(
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<RunCommandResult> {
  const [cmd, ...rest] = args;
  if (!cmd) {
    return { exitCode: 2, stdout: '', stderr: 'empty command' };
  }
  const startMs = Date.now();
  const proc = Bun.spawn([cmd, ...rest], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    // Its own process group, so a timeout reaches the children too (docker, the recorder).
    detached: true,
  });
  running.add(proc.pid);

  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    readers.push(reader);
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  };

  let timedOut = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timers.push(
      setTimeout(() => {
        timedOut = true;
        killGroup(proc.pid);
        // A child that survives the signal holds the pipes open; stop reading them.
        timers.push(setTimeout(() => readers.forEach((r) => void r.cancel()), DRAIN_MS));
      }, opts.timeoutMs),
    );
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(proc.stdout),
      collect(proc.stderr),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, timedOut, durationMs: Date.now() - startMs };
  } finally {
    timers.forEach(clearTimeout);
    running.delete(proc.pid);
  }
}
