import { describe, expect, test } from 'bun:test'
import type { CommandResult, CommandRunner } from '../../src/interfaces'
import {
  conntrackDeleteCommands,
  flushConntrack,
  isNoEntriesResult,
} from '../../src/agent/net/conntrack'

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })

class RecordingRunner implements CommandRunner {
  readonly calls: string[][] = []
  response: (argv: readonly string[]) => CommandResult = () =>
    ok('1 flow entries have been deleted.\n')

  async run(argv: readonly string[]): Promise<CommandResult> {
    this.calls.push([...argv])
    return this.response(argv)
  }
}

describe('conntrack delete commands', () => {
  test('flushes the guest address in all four directions and every public port', () => {
    expect(
      conntrackDeleteCommands({
        guestIp: '10.200.0.2',
        publicPorts: [20001, 20000],
      })
    ).toEqual([
      ['conntrack', '-D', '--orig-src', '10.200.0.2'],
      ['conntrack', '-D', '--orig-dst', '10.200.0.2'],
      ['conntrack', '-D', '--reply-src', '10.200.0.2'],
      ['conntrack', '-D', '--reply-dst', '10.200.0.2'],
      ['conntrack', '-D', '--orig-port-dst', '20000', '-p', 'tcp'],
      ['conntrack', '-D', '--orig-port-dst', '20001', '-p', 'tcp'],
    ])
  })

  test('rejects injection in the guest IP or a port', () => {
    expect(() =>
      conntrackDeleteCommands({ guestIp: '10.200.0.2; rm -rf /' })
    ).toThrow('invalid IPv4')
    expect(() =>
      conntrackDeleteCommands({ guestIp: '10.200.0.2', publicPorts: [0] })
    ).toThrow('invalid port')
  })

  test('treats "0 flow entries have been deleted" (exit 1) as success', () => {
    expect(
      isNoEntriesResult({
        code: 1,
        stdout: '0 flow entries have been deleted.\n',
        stderr: '',
      })
    ).toBe(true)
    expect(
      isNoEntriesResult({
        code: 1,
        stdout: '',
        stderr: 'Operation not permitted',
      })
    ).toBe(false)
  })
})

describe('flushConntrack', () => {
  test('runs every delete and tolerates empty results', async () => {
    const runner = new RecordingRunner()
    runner.response = () => ({
      code: 1,
      stdout: '0 flow entries have been deleted.\n',
      stderr: '',
    })
    await flushConntrack(runner, {
      guestIp: '10.200.0.2',
      publicPorts: [20000],
    })
    expect(runner.calls.length).toBe(5)
    expect(runner.calls[4]).toEqual([
      'conntrack',
      '-D',
      '--orig-port-dst',
      '20000',
      '-p',
      'tcp',
    ])
  })

  test('propagates a real failure (so the lease stays reserved)', async () => {
    const runner = new RecordingRunner()
    runner.response = argv =>
      argv[2] === '--reply-dst'
        ? { code: 1, stdout: '', stderr: 'Operation not permitted' }
        : ok()
    await expect(
      flushConntrack(runner, { guestIp: '10.200.0.2' })
    ).rejects.toThrow(/could not flush conntrack entries for 10\.200\.0\.2/)
    // The remaining directions were still attempted.
    expect(runner.calls.length).toBe(4)
  })
})
