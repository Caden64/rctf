# Edge verification — dated results

Runs on **2026-11-08** (America/Denver, UTC−7), workstation `airch`, Linux
`7.2.14-arch1-1`. Everything below ran unprivileged inside `unshare -Urn`; no host
network, root, or `/etc` state was touched.

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

Traefik pin: **v3.7.15**, published **2026-10-15** (24 days before the run, i.e. older than
two weeks). Downloaded from
`https://github.com/traefik/traefik/releases/download/v3.7.15/traefik_v3.7.15_linux_amd64.tar.gz`;
the published `traefik_v3.7.15_checksums.txt` line was:

```
5b9f51199fcb7a3b5f7ae0f9dae8dcf01efadafd92c5fca96ea2822eca81f8e6  traefik_v3.7.15_linux_amd64.tar.gz
```

`sha256sum` of the downloaded tarball matched exactly. Extracted binary sha256:
`34bfdfa88e321ad496d829910c6145a0743eae09cdf290e3e114b137eb948e30`.
`./fetch-traefik.sh` re-checks the published checksum on a fresh machine and refuses a
mismatch. Firecracker binary sha256 in the read-only cache:
`99ad0f5cd0514a88aad0e9ae8cfdb3cc3b4ab9d190e1194602406c786b5de7a5`.

## Command

```sh
cd deploy/firecracker/edge
./fetch-traefik.sh
KEEP_RUN=1 ./run.sh
```

`run.sh` created `/run/user/1000/fce<epoch><pid>`, built the guest image with the
repository's `build-rootfs.sh`, and ran the three phases, each in a fresh nested network
namespace. Three consecutive full runs were made:

| Run | Started (local) | phase agent | phase veth | phase lifecycle | Total |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-11-08 12:02:08 | 28 pass / 0 fail | 18 pass / 0 fail | 9 pass / 0 fail | **55 pass / 0 fail**, exit 0 |
| 2 | 2026-11-08 12:03:41 | 28 pass / 0 fail | 18 pass / 0 fail | 9 pass / 0 fail | **55 pass / 0 fail**, exit 0 |
| 3 | 2026-11-08 12:04:55 | 28 pass / 0 fail | 18 pass / 0 fail | 9 pass / 0 fail | **55 pass / 0 fail**, exit 0 |

Run 3 is quoted below; runs 1 and 2 produced the same check texts. There were **no FAIL
lines** in any phase log.

## Full check log (run 3)

```
CHECK 1.1 PASS Host(web-a-edgea1794164622aa.edge.test) served team-a from the real guest
CHECK 1.2 PASS Host(web-b-edgeb1794164622bb.edge.test) served team-b at the same time
CHECK 1.3 PASS unknown/wrong Host -> HTTP 404 (unknown=404 wrong=404), no fallback to a guest
CHECK 1.4 PASS simultaneous requests keep teams separate (A='team-a' B='team-b')
CHECK 2.3 PASS Traefik ignored a malformed YAML file; both live routes still work
CHECK 2.4 PASS partial router (missing service) did not break the other routes
CHECK 3.1 PASS outside client on host port 24000 reached only team A's guest
CHECK 3.2 PASS outside client on host port 24002 reached only team B's guest
CHECK 3.3 PASS per-instance public ports are distinct (A=24000/24001 B=24002); no port is shared
CHECK 3.4 PASS each public port DNATs to exactly its own lease (A=24000/24001 -> 10.200.0.2, B=24002/24003 -> 10.200.0.6)
CHECK 3.5 PASS an unpublished port (24099) on the host is closed, not forwarded
CHECK 3.6 PASS outside client cannot reach guest address 10.200.0.2 directly (no bypass)
CHECK 4.1 PASS egress:false guest cannot reach the upstream server (peer=blocked host=blocked scan=blocked)
CHECK 4.2 PASS egress:true guest reaches the upstream server (peer=REACHED host=blocked scan=blocked)
CHECK 4.3 PASS egress:true guest cannot reach the host side of its own tap (peer=REACHED host=blocked scan=blocked)
CHECK 4.4 PASS neither guest can reach the other guest's address (A and B scan=blocked)
CHECK 7.1 PASS only published ports are open on the host: 8088 24000 24001 24002 24003
CHECK 5.1 PASS long-lived DNAT flow to 10.200.0.2:24001 plus an unrelated flow to port 24001 are tracked
CHECK 2.1 PASS DELETE removed the per-instance Traefik YAML (HTTP 200)
CHECK 2.2 PASS deleted route -> 404 while the other team's route still serves 200
CHECK 5.2 PASS real release flushed every conntrack entry of 10.200.0.2 before freeing the address
CHECK 5.3 PASS the unrelated flow with the same destination port 24001 survived (address-scoped, not port-only)
CHECK 5.4 PASS the held DNAT connection was broken by release (connected closed: [Errno 104] Connection reset by peer)
CHECK 5.5 PASS released /30 and public ports entered the durable quarantine (index 0=1 ports 24000=1/24001=1)
CHECK 5.6 PASS post-delete instance got a different /30 and port (fctap2 10.200.0.10 port 24004), quarantine held
CHECK 5.7 PASS the reused /30 carries no inherited flow (the released flow tuple is gone)
CHECK 4.5 PASS control: with the rules flushed the same guest probe reaches the host tap side (peer=blocked host=REACHED scan=blocked)
CHECK 7.2 PASS busybox nc connect from inside real guest A to guest B's address was blocked (peer=blocked host=blocked scan=blocked)
CHECK 6.1 PASS packet with saddr 10.200.0.6 from guest A was dropped (upstream saw none)
CHECK 6.2 PASS control: with inet rules flushed the same spoofed-IP packet is forwarded and observed
CHECK 6.3 PASS frame with ether saddr 02:00:00:00:0b:02 from guest A was dropped
CHECK 6.4 PASS control: with inet rules flushed the spoofed-MAC frame is forwarded and observed
CHECK 6.5 PASS ARP reply with ether saddr 02:00:00:00:0b:02 from guest A was dropped (host kept 02:00:00:00:0a:02)
CHECK 6.6 PASS control: with the ARP table flushed the spoofed reply updates the neighbour (probe is sensitive)
CHECK 6.7 PASS legit ARP request from guest A is accepted with the ARP rules installed (positive control)
CHECK 6.8 PASS ARP request with spoofed sender 10.200.0.6 from guest A was dropped (no host reply)
CHECK 6.9 PASS control: with the ARP table flushed the host answers the spoofed-sender request
CHECK 7.2 PASS nmap from guest A shows no open ports on guest B (cross-tap forwarding dropped)
CHECK 7.3 PASS control: with inet rules flushed the same nmap scan finds guest B's 8080
CHECK 5.6 PASS DNAT flow (10.200.0.2) and unrelated flow to port 24001 tracked in conntrack
CHECK 5.7 PASS real flushConntrack removed every entry for 10.200.0.2
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
CHECK 8.6 PASS after release: 0 taps left, rules clean=true, traefik entries=0
CHECK 8.7 PASS release flushed every conntrack entry (0 guest addresses still present)
CHECK 8.8 PASS 10 /30 indexes + 10 ports quarantined, expiries in the future=true
CHECK 8.9 PASS post-restart allocation honours quarantine: fctap10 10.201.0.42 port 25010
```

(IDs `5.x`/`7.2` intentionally appear twice: once in the Firecracker phase and once in the
veth phase, where they test the same invariant through a different guest model.)

## Excerpts that are easy to get wrong

Real guests booted under KVM and were ready in the agent:

```
NOTE create codes: A=200 B=200
NOTE edgea1794164622aa state=running
NOTE edgeb1794164622bb state=running
NOTE A: fctap0 10.200.0.1/10.200.0.2 ports 24000,24001 host=web-a-edgea1794164622aa.edge.test
NOTE B: fctap1 10.200.0.5/10.200.0.6 ports 24002,24003 host=web-b-edgeb1794164622bb.edge.test
```

The `nmap -sT -p-` from the outside netns returned exactly the published set (no unknown
listener; the agent API is bound to `127.0.0.1` and invisible there):

```
CHECK 7.1 PASS only published ports are open on the host: 8088 24000 24001 24002 24003
```

Long-lived DNAT flow, real release, conntrack state and the port-only regression:

```
CHECK 5.1 PASS long-lived DNAT flow to 10.200.0.2:24001 plus an unrelated flow to port 24001 are tracked
CHECK 5.2 PASS real release flushed every conntrack entry of 10.200.0.2 before freeing the address
CHECK 5.3 PASS the unrelated flow with the same destination port 24001 survived (address-scoped, not port-only)
CHECK 5.4 PASS the held DNAT connection was broken by release (connected closed: [Errno 104] Connection reset by peer)
CHECK 5.5 PASS released /30 and public ports entered the durable quarantine (index 0=1 ports 24000=1/24001=1)
```

The conntrack entry seen before release (from the outside client's fixed source port) was:

```
tcp 6 431999 ESTABLISHED src=203.0.113.2 dst=203.0.113.1 sport=55555 dport=24001 \
  src=10.200.0.2 dst=203.0.113.2 sport=9000 dport=55555 [ASSURED]
tcp 6 ... ESTABLISHED src=203.0.113.2 dst=203.0.114.3 sport=55556 dport=24001 \
  src=203.0.114.3 dst=203.0.113.2 sport=24001 dport=55556 [ASSURED]
```

After release only the second (unrelated, same destination port, different address) remained;
the first was deleted by the repository's address-scoped `flushConntrack`.

Ten concurrent real leases and a fully clean host afterwards:

```
CHECK 8.1 PASS ... fctap0=10.201.0.2 ... fctap9=10.201.0.38
CHECK 8.5 PASS conntrack saw 10/10 DNAT flows before release (real mappings)
CHECK 8.6 PASS after release: 0 taps left, rules clean=true, traefik entries=0
CHECK 8.7 PASS release flushed every conntrack entry (0 guest addresses still present)
CHECK 8.8 PASS 10 /30 indexes + 10 ports quarantined, expiries in the future=true
CHECK 8.9 PASS post-restart allocation honours quarantine: fctap10 10.201.0.42 port 25010
```

## Product bugs found

**None.** All 55 assertions passed in three consecutive runs, including the
port-only-conntrack-deletion regression (`5.3`/`5.8`), the reuse-without-quarantine test
(`5.9`–`5.12`), and the anti-spoof controls. `repros/` is therefore not present/empty.

Two harness details were found and handled (not product bugs):

1. Linux itself ignores ARP senders that are off-link for the receiving interface, before
   any nftables rule. The ARP control therefore temporarily widens `fctap0` to
   `10.200.0.0/24` (documented in `README.md`), which makes an unfiltered kernel answer and
   proves the rule is what drops it in the tested configuration.
2. The minimal busybox guest has no `nmap`; the real Firecracker guest performs the
   cross-guest scan with busybox `nc`, while `nmap` from a guest is exercised in the
   veth-backed guest namespace (same rules, same kernel forwarding path).

## Leftovers

Each phase owns a nested network namespace; exiting the phase removes every tap/veth, nft
table, conntrack entry and Traefik process with it. After the runs, only the run directories
created by `run.sh` remained; they were inspected and then removed. No Firecracker, Traefik,
`unshare`, `nsenter` or Python helper process from this work was left running, and no host
nftables/conntrack state was created (all of it lives in the private namespaces).
