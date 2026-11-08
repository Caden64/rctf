/**
 * Minimal `jq` stand-in for guest-init tests (the test host may not have jq).
 * It implements only the filters `deploy/firecracker/guest/init` uses, with
 * real `-r`/`-j` output semantics so byte-for-byte flag recovery is meaningful.
 */
const args = process.argv.slice(2)
const vars: Record<string, unknown> = {}
let raw = false
let join = false
let exitStatus = false
let filter = ''

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === undefined) continue
  if (arg === '-r') {
    raw = true
  } else if (arg === '-j') {
    raw = true
    join = true
  } else if (arg === '-e') {
    exitStatus = true
  } else if (arg === '--argjson') {
    const name = args[i + 1]
    const value = args[i + 2]
    if (name !== undefined && value !== undefined) {
      vars[name] = JSON.parse(value)
    }
    i += 2
  } else if (arg.startsWith('-')) {
    // ignore other output/format flags
  } else {
    filter = arg
  }
}

const input = await Bun.stdin.text()
let doc: unknown
try {
  doc = JSON.parse(input)
} catch {
  process.stderr.write('fake-jq: invalid JSON input\n')
  process.exit(4)
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {}

const rctf = asRecord(asRecord(doc).rctf)
const flags = Array.isArray(rctf.flags) ? rctf.flags : []
const index = typeof vars.i === 'number' ? vars.i : 0

const write = (value: string, newline = !join): void => {
  process.stdout.write(
    raw
      ? value + (newline ? '\n' : '')
      : JSON.stringify(value) + (newline ? '\n' : '')
  )
}

const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

if (filter === '.') {
  if (exitStatus && (doc === null || doc === false)) process.exit(1)
  process.stdout.write(JSON.stringify(doc))
} else if (filter.includes('.rctf.version == 1')) {
  // Mirrors init's METADATA_SCHEMA filter: version 1, non-empty string
  // instanceId/hostname, env object, flags array of {provider, flag} strings.
  const rawRctf = asRecord(doc).rctf
  const record =
    typeof rawRctf === 'object' && rawRctf !== null && !Array.isArray(rawRctf)
      ? (rawRctf as Record<string, unknown>)
      : undefined
  const valid =
    record !== undefined &&
    record.version === 1 &&
    typeof record.instanceId === 'string' &&
    record.instanceId.length > 0 &&
    typeof record.hostname === 'string' &&
    record.hostname.length > 0 &&
    typeof record.env === 'object' &&
    record.env !== null &&
    !Array.isArray(record.env) &&
    Array.isArray(record.flags) &&
    record.flags.every(
      entry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).provider === 'string' &&
        typeof (entry as Record<string, unknown>).flag === 'string'
    )
  if (exitStatus && !valid) process.exit(1)
  process.stdout.write(valid ? 'true\n' : 'false\n')
} else if (filter.includes('keys[]')) {
  for (const key of Object.keys(asRecord(rctf.env))) {
    if (filter.includes('startswith("RCTF_")') && !key.startsWith('RCTF_')) {
      continue
    }
    process.stdout.write(`${key}\n`)
  }
} else if (filter.includes('to_entries[]')) {
  for (const [key, value] of Object.entries(asRecord(rctf.env))) {
    if (filter.includes('startswith("RCTF_")') && key.startsWith('RCTF_')) {
      continue
    }
    process.stdout.write(`export ${key}=${shQuote(String(value))}\n`)
  }
} else if (filter.includes('length')) {
  process.stdout.write(`${flags.length}\n`)
} else if (filter.includes('.provider')) {
  const flag = asRecord(flags[index])
  write(typeof flag.provider === 'string' ? flag.provider : '')
} else if (filter.includes('.flag')) {
  const flag = asRecord(flags[index])
  write(typeof flag.flag === 'string' ? flag.flag : '')
} else if (filter.includes('instanceId')) {
  write(typeof rctf.instanceId === 'string' ? rctf.instanceId : '')
} else if (filter.includes('hostname')) {
  write(typeof rctf.hostname === 'string' ? rctf.hostname : '')
} else if (filter.includes('@tsv')) {
  for (const entry of flags) {
    const flag = asRecord(entry)
    const escape = (value: unknown): string =>
      String(value)
        .replaceAll('\\', '\\\\')
        .replaceAll('\t', '\\t')
        .replaceAll('\n', '\\n')
        .replaceAll('\r', '\\r')
    process.stdout.write(`${escape(flag.provider)}\t${escape(flag.flag)}\n`)
  }
} else {
  process.stderr.write(`fake-jq: unsupported filter: ${filter}\n`)
  process.exit(2)
}
