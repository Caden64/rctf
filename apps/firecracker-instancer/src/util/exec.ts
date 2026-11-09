import type { CommandResult, CommandRunner } from '../interfaces'

/** Real runner. argv only (never a shell). Kills the process on timeout. */
export const bunCommandRunner: CommandRunner = {
  async run(argv, opts = {}): Promise<CommandResult> {
    const proc = Bun.spawn([...argv], {
      stdin: opts.stdin === undefined ? 'ignore' : new Blob([opts.stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = opts.timeoutMs
      ? setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs)
      : undefined
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { code, stdout, stderr }
    } finally {
      if (timer) clearTimeout(timer)
    }
  },
}
