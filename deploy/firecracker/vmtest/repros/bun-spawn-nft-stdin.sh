#!/usr/bin/env bash
# Minimal repro (test-harness issue, not product code): Bun.spawn's
# stdin:"pipe" is a socketpair, and nft only accepts a regular file or a pipe
# for `-f -`. test/net/namespace.test.ts feeds the ruleset that way, so it
# fails on Bun 1.4.4 with:
#   internal:0:0-0: Error: Not a regular file: "/dev/stdin"
#
# Run inside the VM as root or as ubuntu:
#   bash repros/bun-spawn-nft-stdin.sh
set -u
BUN=${BUN:-/usr/local/bin/bun}
command -v "$BUN" >/dev/null || BUN=$(command -v bun) || { echo "bun not found"; exit 2; }

tmp=$(mktemp -d)
cat >"$tmp/repro.ts" <<'EOF'
const a = Bun.spawn(["sh", "-c", "stat -c %F /dev/stdin"], {
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
})
a.stdin.write("hello\n")
await a.stdin.end()
console.log("stdin seen by child:", (await new Response(a.stdout).text()).trim())

const p = Bun.spawn(["nft", "-c", "-f", "-"], {
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
})
p.stdin.write("table inet vmtest_repro {}\n")
await p.stdin.end()
const [out, err, code] = await Promise.all([
  new Response(p.stdout).text(),
  new Response(p.stderr).text(),
  p.exited,
])
console.log("nft exit:", code)
console.log("nft stderr:", err.trim())
EOF
"$BUN" "$tmp/repro.ts"
rm -rf "$tmp"
