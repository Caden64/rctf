# Edge verification — dated results

Runs on **2026-11-08** (America/Denver, UTC−7), workstation `airch`, Linux
`7.2.14-arch1-1`. Everything below ran unprivileged inside `unshare -Urn`; no host
network, root, or `/etc` state was touched.

This revision hardens the assertions after a review (pre-flush conntrack presence, a live
cross-guest probe control, a published-port control, a full-scan nmap proof, fail-closed
probe/listener parsing, repo-pinned Traefik hashes, and a mutation selftest). The check
counts therefore differ from the earlier 55-check log.

## Environment / pinned programs

| Program | Version | Provenance |
| --- | --- | --- |
| Kernel (host) | `7.2.14-arch1-1` | `uname -r` |
| nftables | `v1.1.7 (Commodore Bullmoose #8)` | distro |
| conntrack-tools | `v1.4.9` | distro |
| nmap | `7.993` | distro |
| Bun | `1.4.4` | `~/.local/bin/bun` |
| Traefik | `3.7.15` (`built 2026-10-15T14:33:48Z`, Go `1.26.9`) | release binary, `~/.cache/rctf-edge/traefik-v3.7.15` |
| Firecracker | `v1.17.0` | `SMOKE_ARTIFACTS` (read-only) |
| Guest kernel | `6.1.155` (Firecracker CI) | `SMOKE_ARTIFACTS` (read-only) |
| Guest userland | busybox `1.35.0` static + `jq` | `SMOKE_ARTIFACTS` (read-only) |

Traefik pin: **v3.7.15**, published **2026-10-15**. The expected hashes are embedded in
`fetch-traefik.sh`, not taken from the download origin:

```
tarball traefik_v3.7.15_linux_amd64.tar.gz
  5b9f51199fcb7a3b5f7ae0f9dae8dcf01efadafd92c5fca96ea2822eca81f8e6
extracted binary `traefik`
  34bfdfa88e321ad496d829910c6145a0743eae09cdf290e3e114b137eb948e30
```

The tarball hash is the line from the official `traefik_v3.7.15_checksums.txt` and was
cross-checked against the GitHub API release asset digest
(`api.github.com/repos/traefik/traefik/releases/tags/v3.7.15` →
`assets[].digest = sha256:5b9f51199fcb7a3b5f7ae0f9dae8dcf01efadafd92c5fca96ea2822eca81f8e6`).
`fetch-traefik.sh` still downloads the published checksums file as a second source and fails
if it disagrees with the repo pin. `run.sh` calls `fetch-traefik.sh --verify` before every
run, so the cached binary is re-hashed on every use; a modified cache is fatal (verified by
appending one byte to a copy: exit 1, `sha256 mismatch`). Firecracker binary sha256 in the
read-only cache: `99ad0f5cd0514a88aad0e9ae8cfdb3cc3b4ab9d190e1194602406c786b5de7a5`.

## Command

```sh
cd deploy/firecracker/edge
./fetch-traefik.sh --verify
KEEP_RUN=1 ./run.sh
```

`run.sh` created `/run/user/1000/fce<epoch><pid>`, built the guest image with the
repository's `build-rootfs.sh`, ran the mutation selftest in its own network namespace, then
ran the three phases, each in a fresh nested network namespace. Three consecutive full runs
were made:

| Run | Started (local) | selftest | phase agent | phase veth | phase lifecycle | Total | Exit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-11-08 12:30:30 | 6 pass / 0 fail | 30 pass / 0 fail | 19 pass / 0 fail | 9 pass / 0 fail | **58 pass / 0 fail** | 0 |
| 2 | 2026-11-08 12:31:34 | 6 pass / 0 fail | 30 pass / 0 fail | 19 pass / 0 fail | 9 pass / 0 fail | **58 pass / 0 fail** | 0 |
| 3 | 2026-11-08 12:32:47 | 6 pass / 0 fail | 30 pass / 0 fail | 19 pass / 0 fail | 9 pass / 0 fail | **58 pass / 0 fail** | 0 |

Run 3 is quoted below; runs 1 and 2 produced the same check texts. There were **no FAIL
lines** in any phase or selftest log.

## Mutation selftest (run 3)

```
SELFTEST 1 PASS mutation caught: flushing the wrong address exits 0 but leaves the tuple, so 'gone after flush' cannot pass falsely
SELFTEST 1b PASS the real flush of the right address exits 0 and removes the tuple (the hardened assertion passes when it should)
SELFTEST 2 PASS probe classification: nc success=REACHED, refusal=blocked, nc exit 127=error, nc missing=error (never blocked)
SELFTEST 2b PASS probe assertion fails closed on empty/unparseable/error lines and accepts only a valid scan=blocked
SELFTEST 3 PASS published port connects and unpublished port is refused in the same netns (assertion passes when it should)
SELFTEST 3b PASS mutation caught: when the published probe does not connect, the closed-port assertion fails
RESULT selftest: 6 passed, 0 failed
```

## Full check log (run 3)

```
CHECK 1.1 PASS Host(web-a-edgea1794166372aa.edge.test) served team-a from the real guest
CHECK 1.2 PASS Host(web-b-edgeb1794166372bb.edge.test) served team-b at the same time
CHECK 1.3 PASS unknown/wrong Host -> HTTP 404 (unknown=404 wrong=404), no fallback to a guest
CHECK 1.4 PASS simultaneous requests keep teams separate (A='team-a' B='team-b')
CHECK 2.3 PASS Traefik ignored a malformed YAML file; both live routes still work
CHECK 2.4 PASS partial router (missing service) did not break the other routes
CHECK 3.1 PASS outside client on host port 24000 reached only team A's guest
CHECK 3.2 PASS outside client on host port 24002 reached only team B's guest
CHECK 3.3 PASS per-instance public ports are distinct (A=24000/24001 B=24002); no port is shared
CHECK 3.4 PASS each public port DNATs to exactly its own lease (A=24000/24001 -> 10.200.0.2, B=24002/24003 -> 10.200.0.6)
CHECK 3.5 PASS unpublished port (24099) is closed while the published port (24000) connects from the same netns
CHECK 3.6 PASS outside client cannot reach guest address 10.200.0.2 directly (no bypass)
CHECK 3.7 PASS control: the same direct probe reaches the guest when temporarily allowed, and is blocked again after removing the rules
CHECK 4.1 PASS egress:false guest cannot reach the upstream server (peer=blocked host=blocked scan=blocked)
CHECK 4.2 PASS egress:true guest reaches the upstream server (peer=REACHED host=blocked scan=blocked)
CHECK 4.3 PASS egress:true guest cannot reach the host side of its own tap (peer=REACHED host=blocked scan=blocked)
CHECK 4.4 PASS neither guest can reach the other guest's address (A and B report a valid scan=blocked)
CHECK 4.5 PASS control: with the rules flushed the same guest probe reaches the host tap side (peer=blocked host=REACHED scan=REACHED)
CHECK 4.6 PASS control: after the flush the cross-guest scan probe is live (scan=REACHED), so blocked scans are not dead-probe results
CHECK 7.1 PASS only published ports are open on the host: 8088 24000 24001 24002 24003 (nmap exit 0, 65535/65535 ports scanned)
CHECK 5.1 PASS long-lived DNAT flow to 10.200.0.2:24001 plus an unrelated flow to port 24001 are tracked
CHECK 2.1 PASS DELETE removed the per-instance Traefik YAML (HTTP 200)
CHECK 2.2 PASS deleted route -> 404 while the other team's route still serves 200
CHECK 5.2 PASS real release flushed every conntrack entry of 10.200.0.2 before freeing the address
CHECK 5.3 PASS the unrelated flow with the same destination port 24001 survived (address-scoped, not port-only)
CHECK 5.4 PASS the held DNAT connection was broken by release (connected closed: [Errno 104] Connection reset by peer)
CHECK 5.5 PASS released /30 and public ports entered the durable quarantine (index 0=1 ports 24000=1/24001=1)
CHECK 5.6 PASS post-delete instance got a different /30 and port (fctap2 10.200.0.10 port 24004), quarantine held
CHECK 5.7 PASS old released flow tuple (client port 55555) is gone after release; C holds a different /30, so real reuse is phase-veth 5.9-5.12
CHECK 7.2 PASS busybox nc connect from inside real guest A to guest B's address was blocked (peer=blocked host=blocked scan=blocked; 4.6 shows the probe is live)
CHECK 6.1 PASS packet with saddr 10.200.0.6 from guest A was dropped (upstream saw none; probe exit 0)
CHECK 6.2 PASS control: with inet rules flushed the same spoofed-IP packet is forwarded and observed
CHECK 6.3 PASS frame with ether saddr 02:00:00:00:0b:02 from guest A was dropped (probe exit 0)
CHECK 6.4 PASS control: with inet rules flushed the spoofed-MAC frame is forwarded and observed
CHECK 6.5 PASS ARP reply with ether saddr 02:00:00:00:0b:02 from guest A was dropped (host kept 02:00:00:00:0a:02; probe exit 0)
CHECK 6.6 PASS control: with the ARP table flushed the spoofed reply updates the neighbour (probe is sensitive)
CHECK 6.7 PASS legit ARP request from guest A is accepted with the ARP rules installed (positive control)
CHECK 6.8 PASS ARP request with spoofed sender 10.200.0.6 from guest A was dropped (no host reply; probe exit 0)
CHECK 6.9 PASS control: with the ARP table flushed the host answers the spoofed-sender request
CHECK 7.2 PASS nmap from guest A shows no open ports on guest B (cross-tap forwarding dropped)
CHECK 7.3 PASS control: with inet rules flushed the same nmap scan finds guest B's 8080
CHECK 5.6 PASS DNAT flow (10.200.0.2) and unrelated flow to port 24001 tracked in conntrack
CHECK 5.6a PASS the guest flow is still tracked after the fenced ruleset and tap removal, immediately before the flush (hold socket open)
CHECK 5.7 PASS real flushConntrack (exit 0) removed every entry for 10.200.0.2
CHECK 5.8 PASS unrelated flow with the SAME destination port 24001 survived (no port-only deletion)
CHECK 5.9 PASS reused /30 has no inherited conntrack state before the new instance is contacted
CHECK 5.10 PASS same public port + /30 now reaches the NEW guest (identity 'A2')
CHECK 5.11 PASS the new flow through the reused /30 is a fresh conntrack entry
CHECK 5.12 PASS the unrelated flow is still alive after the whole reuse sequence
CHECK 8.1 PASS 10 distinct /30s and taps: fctap0=10.201.0.2 fctap1=10.201.0.6 fctap2=10.201.0.10 fctap3=10.201.0.14 fctap4=10.201.0.18 fctap5=10.201.0.22 fctap6=10.201.0.26 fctap7=10.201.0.30 fctap8=10.201.0.34 fctap9=10.201.0.38
CHECK 8.2 PASS real tun/tap with ownership alias: fctap0:tap+alias fctap1:tap+alias fctap2:tap+alias fctap3:tap+alias fctap4:tap+alias fctap5:tap+alias fctap6:tap+alias fctap7:tap+alias fctap8:tap+alias fctap9:tap+alias
CHECK 8.3 PASS 10/10 DNAT rules, anti-spoof for all 10, ARP rules for all 10 taps
CHECK 8.4 PASS per-instance Traefik file written for the http expose (…/lifecycle/traefik/rctf-fc-life00xxxxxxxxxxx.yml)
CHECK 8.5 PASS conntrack saw 10/10 DNAT flows before release (real mappings)
CHECK 8.6 PASS after release: 0 taps left, rules clean=true, traefik entries=0; inet=present arp=present
CHECK 8.7 PASS release flushed every conntrack entry (0 guest addresses still present)
CHECK 8.8 PASS 10 /30 indexes + 10 ports quarantined, expiries in the future=true
CHECK 8.9 PASS post-restart allocation honours quarantine: fctap10 10.201.0.42 port 25010
```

(IDs `5.x`/`7.2` intentionally appear twice: once in the Firecracker phase and once in the
veth phase, where they test the same invariant through a different guest model.)

## Excerpts that are easy to get wrong

The cross-guest probe was proven live **while both guests were alive**, by flushing the
agent's rules, requiring `scan=REACHED`, and restoring the exact pre-flush ruleset:

```
NOTE A probe after flush: peer=blocked host=REACHED scan=REACHED
NOTE B probe after flush: peer=blocked host=REACHED scan=REACHED
CHECK 4.5 PASS control: with the rules flushed the same guest probe reaches the host tap side (peer=blocked host=REACHED scan=REACHED)
CHECK 4.6 PASS control: after the flush the cross-guest scan probe is live (scan=REACHED), so blocked scans are not dead-probe results
NOTE agent ruleset restored after the 4.5/4.6 control
```

The unpublished-port check now requires the published port to connect from the same netns
first, and direct guest reachability has its own positive control:

```
CHECK 3.5 PASS unpublished port (24099) is closed while the published port (24000) connects from the same netns
CHECK 3.6 PASS outside client cannot reach guest address 10.200.0.2 directly (no bypass)
CHECK 3.7 PASS control: the same direct probe reaches the guest when temporarily allowed, and is blocked again after removing the rules
```

`nmap -sT -p-` must exit 0 and prove it scanned every port (XML `scaninfo`), not merely
return a short greppable list:

```
CHECK 7.1 PASS only published ports are open on the host: 8088 24000 24001 24002 24003 (nmap exit 0, 65535/65535 ports scanned)
```

Real release, with the hold socket kept open through the flush: the tuple is asserted
present after the fence/tap removal and immediately before the real flush, the flush must
exit 0, and only then is absence asserted:

```
CHECK 5.6 PASS DNAT flow (10.200.0.2) and unrelated flow to port 24001 tracked in conntrack
CHECK 5.6a PASS the guest flow is still tracked after the fenced ruleset and tap removal, immediately before the flush (hold socket open)
CHECK 5.7 PASS real flushConntrack (exit 0) removed every entry for 10.200.0.2
CHECK 5.8 PASS unrelated flow with the SAME destination port 24001 survived (no port-only deletion)
```

Ten concurrent real leases and a fully clean host afterwards (the listings must exit 0; a
missing table after teardown is the only accepted non-zero and is named):

```
CHECK 8.5 PASS conntrack saw 10/10 DNAT flows before release (real mappings)
CHECK 8.6 PASS after release: 0 taps left, rules clean=true, traefik entries=0; inet=present arp=present
CHECK 8.7 PASS release flushed every conntrack entry (0 guest addresses still present)
CHECK 8.8 PASS 10 /30 indexes + 10 ports quarantined, expiries in the future=true
CHECK 8.9 PASS post-restart allocation honours quarantine: fctap10 10.201.0.42 port 25010
```

## Product bugs found

**None.** All 58 assertions and 6 mutation proofs passed in three consecutive runs,
including the pre-flush conntrack presence proof (`5.6a`), the port-only-conntrack-deletion
regression (`5.3`/`5.8`), the reuse-without-quarantine test (`5.9`–`5.12`), and the
anti-spoof controls. `repros/` is therefore not present/empty.

The 120 s quarantine in the agent phase deliberately prevents same-`/30` reuse there;
`5.7` now says exactly that ("old released flow tuple is gone"). The real reuse path is
phase `veth` 5.9–5.12, which sets quarantine to 0 and hands the exact same `/30`, public
port and client source port to a new guest.

Two harness details were found and handled (not product bugs):

1. Linux itself ignores ARP senders that are off-link for the receiving interface, before
   any nftables rule. The ARP control therefore temporarily widens `fctap0` to
   `10.200.0.0/24` (documented in `README.md`), which makes an unfiltered kernel answer and
   proves the rule is what drops it in the tested configuration.
2. The minimal busybox guest has no `nmap`; the real Firecracker guest performs the
   cross-guest scan with busybox `nc`, while `nmap` from a guest is exercised in the
   veth-backed guest namespace (same rules, same kernel forwarding path). The `nc` probe
   now reports `error` (never `blocked`) when `nc` is missing or exits unexpectedly, and
   4.6 proves it can report `REACHED`.

## Leftovers

Each phase owns a nested network namespace; exiting the phase removes every tap/veth, nft
table, conntrack entry and Traefik process with it. The three `KEEP_RUN=1` run directories
(`/run/user/1000/fce1794166230152389`, `...fce1794166294156180`, `...fce1794166368165841`)
were inspected and removed after the runs. No Firecracker, Traefik, `unshare`, `nsenter` or
Python helper process from this work was left running, and no host nftables/conntrack state
was created (all of it lives in the private namespaces).
