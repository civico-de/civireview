export interface CliProcessOptions {
  cwd?: string;
  stdin?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Name used in error messages, e.g. `claude CLI`. */
  label: string;
}

export interface CliProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const KILL_GRACE_MS = 5_000;

/** Runs a CLI to completion; kills it and throws when it outlives `timeoutMs`. */
export async function runCliProcess(
  args: string[],
  options: CliProcessOptions,
): Promise<CliProcessResult> {
  const proc = Bun.spawn(args, {
    cwd: options.cwd,
    // Passed explicitly so the child sees the environment as it is now.
    env: options.env ?? process.env,
    ...(options.stdin !== undefined ? { stdin: new Blob([options.stdin]) } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const completed = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
  completed.catch(() => {});

  const candidates: Array<Promise<CliProcessResult>> = [completed];
  if (options.timeoutMs && options.timeoutMs > 0) {
    // A grandchild can keep the output pipes open after the CLI is killed, so the
    // timeout settles the call itself instead of waiting for the streams to close.
    candidates.push(
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          proc.kill();
          killTimer = setTimeout(() => proc.kill('SIGKILL'), KILL_GRACE_MS);
          killTimer.unref();
          reject(new Error(`${options.label} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
      }),
    );
  }

  try {
    return await Promise.race(candidates);
  } finally {
    clearTimeout(timer);
  }
}
